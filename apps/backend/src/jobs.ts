import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { UnitOfWork } from './ports/storage.js';
import type { ConversationUseCases,IdentityPort,InterpretationPort } from './ports/application.js';
import { sessionKey } from './application/session-key.js';
import { config } from './config.js';
import { ChatInput, Intent, Profile, intents } from './types.js';
import { resolveConversation, resolveInterpretation } from './conversation.js';
import {timeExpression} from './application/time-expression.js';
import {referencedTime} from './application/language-signals.js';
import { dialogueActs,dialogueTargets } from './application/dialogue-policy.js';
export { validateInput } from './application/chat-input.js';
export class JobsService {
  private timer?:NodeJS.Timeout;
  private busy=false;
  private stopped=false;
  constructor(public db:UnitOfWork,private cfg:ReturnType<typeof config>,private domain:ConversationUseCases,private auth:IdentityPort,private interpreter:InterpretationPort) {}
  private key() { return createHash('sha256').update(this.cfg.demoSecret).digest(); }
  private encrypt(value:string) { const iv=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',this.key(),iv); const data=Buffer.concat([cipher.update(value),cipher.final()]); return [iv,cipher.getAuthTag(),data].map(b=>b.toString('base64url')).join('.'); }
  private decrypt(value:string) { const [iv,tag,data]=value.split('.').map(s=>Buffer.from(s,'base64url')); const decipher=createDecipheriv('aes-256-gcm',this.key(),iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(data),decipher.final()]).toString(); }
  async enqueue(user:Profile,input:ChatInput,authorization:string) {
    const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.db.transaction(async cx=> {
      if(this.db.driver==='postgresql') await cx.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',[`telecus-job:${user.id}`]);
      const [existing]=await cx.query('SELECT id,status,body_hash FROM telecus_jobs WHERE owner_id=$1 AND request_id=$2',[user.id,input.requestId]);
      if(existing) { if(existing.body_hash!==hash) throw new ConflictException('Ese identificador ya corresponde a otra solicitud.'); return {id:existing.id,status:existing.status}; }
      const [queued]=await cx.query("SELECT COUNT(*) AS count FROM telecus_jobs WHERE owner_id=$1 AND status IN ('queued','running')",[user.id]);
      if(Number(queued.count)>=4) throw new ServiceUnavailableException('Tienes varias solicitudes pendientes. Espera a que terminen.');
      const [recent]=await cx.query('SELECT COUNT(*) AS count FROM telecus_jobs WHERE owner_id=$1 AND created_at>$2',[user.id,new Date(Date.now()-3600000).toISOString()]);
      if(Number(recent.count)>=120) throw new ServiceUnavailableException('Se alcanzó el límite temporal de solicitudes. Inténtalo más tarde.');
      const id=randomUUID();
      await cx.query('INSERT INTO telecus_jobs(id,owner_id,owner_role,session_id,request_id,body_hash,input_json,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,user.id,user.role,sessionKey(user,input.sessionId),input.requestId,hash,JSON.stringify({input,authorization:this.encrypt(authorization)}),'queued',new Date().toISOString()]);
      return {id,status:'queued'};
    });
  }
  async get(user:Profile,id:string) {
    if(!/^[a-f0-9-]{36}$/i.test(id)) throw new NotFoundException('Solicitud no encontrada.');
    const [job]=await this.db.query('SELECT id,status,result_json,error,created_at FROM telecus_jobs WHERE id=$1 AND owner_id=$2 AND owner_role=$3',[id,user.id,user.role]);
    if(!job) throw new NotFoundException('Solicitud no encontrada.');
    return {id:job.id,status:job.status,result:job.result_json?JSON.parse(job.result_json):undefined,error:job.error||undefined};
  }
  async claim() {
    return this.db.transaction(async cx=> {
      if(this.db.driver==='postgresql') await cx.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',['telecus-queue-claim']);
      const now=new Date().toISOString();
      await cx.query("UPDATE telecus_jobs SET status='failed',error='La solicitud no pudo recuperarse después de dos intentos.',input_json='{}' WHERE status='running' AND lease_until<$1 AND attempts>=2",[now]);
      const [job]=await cx.query(`SELECT j.* FROM telecus_jobs j WHERE (j.status='queued' OR (j.status='running' AND j.lease_until<$1 AND j.attempts<2)) AND NOT EXISTS (SELECT 1 FROM telecus_jobs other WHERE other.session_id=j.session_id AND other.status='running' AND other.lease_until>$2 AND other.id<>j.id) ORDER BY j.created_at LIMIT 1`,[now,now]);
      if(!job) return null;
      const leaseToken=randomUUID();
      await cx.query("UPDATE telecus_jobs SET status='running',lease_until=$1,lease_token=$2,attempts=attempts+1 WHERE id=$3",[new Date(Date.now()+2*this.cfg.modelTimeoutMs+30000).toISOString(),leaseToken,job.id]);
      return {...job,lease_token:leaseToken};
    });
  }
  async interpret(user:Profile,input:ChatInput):Promise<Intent> {
    const grounding=await this.domain.grounding(user,input);
    const resolved=resolveConversation(input.chatInput,grounding);
    if(resolved)return resolved;
    const result=await this.interpreter.interpret(input.chatInput,grounding) as any;
    if(!intents.includes(result.intent)) throw new BadRequestException('No fue posible interpretar la solicitud. Escríbela con otros términos.');
    const intent:any={intent:result.intent};
    for(const key of ['appointment_code','doctor_name','date','time','reason','request_id']) {
      if(result[key]!==null && result[key]!==undefined && typeof result[key]!=='string') throw new BadRequestException('El asistente devolvió datos inválidos.');
      intent[key]=typeof result[key]==='string'?result[key].slice(0,key==='reason'?300:120):null;
    }
    if(result.date_expression!=null&&typeof result.date_expression!=='string')throw new BadRequestException('Expresión de fecha inválida.');
    intent.date_expression=typeof result.date_expression==='string'?result.date_expression.slice(0,120):null;
    if(result.navigation!=null&&!['current','main_menu'].includes(result.navigation))throw new BadRequestException('Navegación inválida.');
    intent.navigation=result.navigation||null;
    if(result.dialogue_act!=null&&!(dialogueActs as readonly string[]).includes(result.dialogue_act))throw new BadRequestException('Acto de diálogo inválido.');
    intent.dialogue_act=result.dialogue_act??null;
    if(result.dialogue_target!=null&&!(dialogueTargets as readonly string[]).includes(result.dialogue_target))throw new BadRequestException('Objeto de diálogo inválido.');
    intent.dialogue_target=result.dialogue_target??null;
    const parsedReference=typeof result.reference_time==='string'?timeExpression(result.reference_time):null;
    intent.reference_time=parsedReference&&/^([01]\d|2[0-3]):[0-5]\d$/.test(parsedReference)?parsedReference:referencedTime(input.chatInput);
    if(intent.time)intent.time=timeExpression(intent.time)||null;
    for(const [field,values] of Object.entries({request_view:['pending','reviewed','all'],request_type:['CANCEL','RESCHEDULE'],request_state:['PENDING','APPROVED','REJECTED']})){
      if(result[field]!=null&&!values.includes(result[field]))throw new BadRequestException('Filtro de solicitudes inválido.');
      intent[field]=result[field]??null;
    }
    for(const field of ['option_number','reference_index']){
      if(result[field]!=null&&(!Number.isInteger(result[field])||result[field]<1||result[field]>20))throw new BadRequestException('Referencia inválida.');
      intent[field]=result[field]??null;
    }
    return resolveInterpretation(input.chatInput,intent,grounding);
  }
  async workOnce() {
    if(this.busy || this.stopped) return;
    this.busy=true;
    try {
      const job=await this.claim(); if(!job) return;
      let user:Profile|undefined,input:ChatInput|undefined;
      try {
        if(job.owner_role!=='PATIENT')throw new BadRequestException('Utiliza el panel de gestión de tu rol. Esta solicitud antigua de chat no se procesó.');
        const stored=JSON.parse(job.input_json); user=await this.auth.authenticate(this.decrypt(stored.authorization));
        if(user.id!==job.owner_id || user.role!==job.owner_role) throw new BadRequestException('El acceso de tu cuenta cambió. Inicia una nueva solicitud.');
        input=stored.input;
        const intent=input!.action==='sendMessage'?await this.interpret(user,input!):null;
        const knowledge=await this.domain.prepareKnowledge(user,input!,intent);
        await this.db.transaction(async cx=> {
          const [lease]=await cx.query("SELECT id FROM telecus_jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>$3",[job.id,job.lease_token,new Date().toISOString()]);
          if(!lease) return;
          const result=await this.domain.process(user!,input!,intent,cx,knowledge);
          await cx.query("UPDATE telecus_jobs SET status='done',result_json=$1,input_json='{}',lease_until=NULL WHERE id=$2 AND lease_token=$3",[JSON.stringify(result),job.id,job.lease_token]);
        });
      } catch(error:any) {
        const message=error?.getResponse?.()?.message || (error?.name==='TimeoutError'?'El modelo tardó demasiado. Inténtalo nuevamente.':'No se pudo obtener el resultado. Consulta la agenda antes de repetir la operación.');
        await this.db.transaction(async cx=>{
          const [owned]=await cx.query("SELECT id FROM telecus_jobs WHERE id=$1 AND status='running' AND lease_token=$2",[job.id,job.lease_token]);
          if(!owned)return;
          if(user&&input?.action==='confirm'&&[400,403,409].includes(error?.getStatus?.()))await this.domain.invalidateRejectedConfirmation(user,input,cx);
          await cx.query("UPDATE telecus_jobs SET status='failed',error=$1,input_json='{}',lease_until=NULL WHERE id=$2 AND lease_token=$3",[String(message),job.id,job.lease_token]);
        });
      }
    } finally {this.busy=false;}
  }
  start() { if(this.cfg.worker) {this.timer=setInterval(()=>{void this.workOnce().catch(()=>console.error('No fue posible procesar la cola.'));},500);this.timer.unref();} }
  async stop() {this.stopped=true;if(this.timer)clearInterval(this.timer);while(this.busy)await new Promise(r=>setTimeout(r,100));}
}
