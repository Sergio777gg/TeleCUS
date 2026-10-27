import {createHash,randomUUID} from 'node:crypto';
import {ConflictException,ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import type {AdministrationStore,KnowledgeDocument,PortalSettings} from '../ports/administration.js';
import type {UnitOfWork,Connection} from '../ports/storage.js';
import type {SchedulingRepository} from '../ports/application.js';
import type {Profile} from '../types.js';
import {DEFAULT_PORTAL} from '../application/administration.js';
import {DEFAULT_SCHEDULE_BOOK,schedulePayload} from '../application/service-schedule.js';
import type {DemoReservationHolds} from './reservation-holds.js';
const fingerprint=(p:any)=>createHash('sha256').update(JSON.stringify([p.id,p.full_name,p.email,p.role,Boolean(p.active)])).digest('hex');
const mutationHash=(resource:string,expected:string,payload:unknown)=>createHash('sha256').update(JSON.stringify([resource,expected,payload])).digest('hex');
export class DemoAdministrationStore implements AdministrationStore {
  readonly demo=true;
  private ready=false;
  constructor(private db:UnitOfWork,private repository:SchedulingRepository,private holds?:DemoReservationHolds){}
  available(){return this.ready;}
  async initialize(catalog:KnowledgeDocument[]){
    await this.db.query('CREATE TABLE IF NOT EXISTS telecus_demo_admin_state (resource TEXT NOT NULL,object_key TEXT NOT NULL,version INTEGER NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(resource,object_key))');
    await this.db.query('CREATE TABLE IF NOT EXISTS telecus_demo_admin_commands (id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,hash TEXT NOT NULL,result_json TEXT NOT NULL)');
    await this.db.query("INSERT INTO telecus_demo_admin_state VALUES('settings','portal',1,$1) ON CONFLICT(resource,object_key) DO NOTHING",[JSON.stringify(DEFAULT_PORTAL)]);
    await this.db.query("INSERT INTO telecus_demo_admin_state VALUES('schedule','service',1,$1) ON CONFLICT(resource,object_key) DO NOTHING",[JSON.stringify(DEFAULT_SCHEDULE_BOOK)]);
    for(const doc of catalog){const version={id:randomUUID(),body:doc.body,created_at:new Date().toISOString(),author:'Corpus inicial'};await this.db.query("INSERT INTO telecus_demo_admin_state VALUES('knowledge',$1,1,$2) ON CONFLICT(resource,object_key) DO NOTHING",[doc.file,JSON.stringify({...doc,published_id:version.id,versions:[version]})]);}
    this.ready=true;
  }
  private async actor(user:Profile,cx:Connection=this.db){const [p]=await cx.query('SELECT role,active FROM telecus_demo_profiles WHERE id=$1',[user.id]);if(!p?.active||p.role!=='ADMIN'||user.role!=='ADMIN')throw new ForbiddenException('Se requiere una cuenta administrativa activa.');}
  private async state(resource:string,key:string,cx:Connection=this.db){const [r]=await cx.query('SELECT * FROM telecus_demo_admin_state WHERE resource=$1 AND object_key=$2',[resource,key]);return r?{...JSON.parse(r.data_json),version:String(r.version)}:null;}
  async schedules(){return await this.state('schedule','service')||DEFAULT_SCHEDULE_BOOK;}
  async settings():Promise<PortalSettings>{return {...DEFAULT_PORTAL,...await this.state('settings','portal'),visit_workflow_available:true};}
  async published(){const rows=await this.db.query("SELECT data_json,version FROM telecus_demo_admin_state WHERE resource='knowledge'");return rows.map(r=>{const d=JSON.parse(r.data_json),v=d.versions.find((x:any)=>x.id===d.published_id);return {...d,body:v.body,version:v.id};});}
  async claimRegistration(_id:string){}
  async read(user:Profile,resource:string,filter:Record<string,any>){
    await this.actor(user);
    if(resource==='settings')return this.settings();
    if(resource==='schedule')return this.schedules();
    if(resource==='people'){
      const q='%'+String(filter.q||'').toLowerCase().replaceAll('!','!!').replaceAll('%','!%').replaceAll('_','!_')+'%',offset=Number(filter.offset||0);
      const rows=await this.db.query("SELECT id,role,full_name,email,active FROM telecus_demo_profiles WHERE role=$1 AND LOWER(full_name||' '||email) LIKE $2 ESCAPE '!' ORDER BY email,id LIMIT 26 OFFSET $3",[filter.role||'PATIENT',q,offset]);
      return {items:rows.slice(0,25).map(p=>({...p,active:Boolean(p.active),version:fingerprint(p)})),next_offset:rows.length>25?offset+25:null};
    }
    if(resource==='payments'){
      if(filter.view==='history'){
        const offset=Number(filter.offset||0),query=String(filter.q||'').toLowerCase(),match=this.db.driver==='sqlite'?"instr(LOWER(a.code||' '||p.full_name||' '||d.full_name),$1)":"strpos(LOWER(a.code||' '||p.full_name||' '||d.full_name),$1)";
        const rows=await this.db.query("SELECT a.id AS appointment_id,a.code,a.start_time,a.status,a.payment_status,p.full_name AS patient_name,d.full_name AS doctor_name,r.id AS receipt_id,r.file_name,r.content_type,r.size,r.created_at FROM telecus_demo_appointments a JOIN telecus_demo_profiles p ON p.id=a.patient_id JOIN telecus_demo_profiles d ON d.id=a.doctor_id LEFT JOIN telecus_demo_payment_receipts r ON r.appointment_id=a.id AND r.withdrawn_at IS NULL WHERE a.payment_status='VERIFIED' AND ($1='' OR "+match+">0) ORDER BY a.start_time DESC,a.id DESC LIMIT 26 OFFSET $2",[query,offset]);
        return {items:rows.slice(0,25).map(r=>({appointment_id:r.appointment_id,code:r.code,start_time:r.start_time,status:r.status,payment_status:r.payment_status,patient_name:r.patient_name,doctor_name:r.doctor_name,processing:false,receipt:r.receipt_id?{id:r.receipt_id,file_name:r.file_name,content_type:r.content_type,size:r.size,created_at:r.created_at}:null})),next_offset:rows.length>25?offset+25:null};
      }
      const rows=await this.db.query("SELECT a.id AS appointment_id,a.code,a.start_time,p.full_name AS patient_name,d.full_name AS doctor_name,r.id AS receipt_id,r.file_name,r.content_type,r.size,r.created_at FROM telecus_demo_appointments a JOIN telecus_demo_profiles p ON p.id=a.patient_id JOIN telecus_demo_profiles d ON d.id=a.doctor_id LEFT JOIN telecus_demo_payment_receipts r ON r.appointment_id=a.id AND r.withdrawn_at IS NULL WHERE a.status='PRE_RESERVED' AND a.payment_status='PENDING' AND a.start_time>$1 AND (($3='received' AND r.id IS NOT NULL) OR ($3='awaiting' AND r.id IS NULL)) ORDER BY a.start_time,a.id LIMIT 26 OFFSET $2",[new Date().toISOString(),Number(filter.offset||0),filter.view||'received']);
      return {items:await Promise.all(rows.slice(0,25).map(async r=>({...r,...await this.holds?.info(r.appointment_id),processing:false,receipt:r.receipt_id?{id:r.receipt_id,file_name:r.file_name,content_type:r.content_type,size:r.size,created_at:r.created_at}:null}))),next_offset:rows.length>25?Number(filter.offset||0)+25:null};
    }
    if(resource==='knowledge'){
      if(filter.file){const d=await this.state('knowledge',filter.file);if(!d)throw new ConflictException('Documento no disponible.');return d;}
      const rows=await this.db.query("SELECT object_key,data_json,version FROM telecus_demo_admin_state WHERE resource='knowledge' ORDER BY object_key");
      return {items:rows.map(r=>{const d=JSON.parse(r.data_json);return {file:r.object_key,title:d.title,roles:d.roles,version:String(r.version),published_id:d.published_id};})};
    }
    const rows=await this.db.query("SELECT object_key,data_json,version FROM telecus_demo_admin_state WHERE resource='registrations' ORDER BY object_key LIMIT 100");
    return {items:rows.map(r=>({...JSON.parse(r.data_json),id:r.object_key,version:String(r.version)}))};
  }
  async write(user:Profile,requestId:string,resource:string,expected:string,p:Record<string,any>){
    return this.db.transaction(async cx=>{
      await this.actor(user,cx);const hash=mutationHash(resource,expected,p),[old]=await cx.query('SELECT * FROM telecus_demo_admin_commands WHERE id=$1',[requestId]);
      if(old){if(old.actor_id!==user.id||old.hash!==hash)throw new ConflictException('La referencia ya corresponde a otra gestión.');return JSON.parse(old.result_json);}
      let result:any,key='',group=resource,data:any;
      if(resource==='profile'){
        const [target]=await cx.query('SELECT * FROM telecus_demo_profiles WHERE id=$1',[p.id]);
        if(!target||target.role==='ADMIN')throw new ForbiddenException('Solo se gestionan pacientes y médicos.');
        if(fingerprint(target)!==expected)throw new ConflictException('El perfil cambió. Actualiza antes de guardar.');
        if(!p.active||target.role!==p.role){const pending=await cx.query("SELECT id FROM telecus_demo_appointments WHERE (patient_id=$1 OR doctor_id=$1) AND status NOT IN ('CANCELLED','COMPLETED') AND end_time>$2 LIMIT 1",[p.id,new Date().toISOString()]);if(pending.length)throw new ConflictException('Resuelve sus citas vigentes antes de cambiar el rol o desactivar.');}
        await cx.query('UPDATE telecus_demo_profiles SET full_name=$1,role=$2,active=$3 WHERE id=$4',[p.full_name,p.role,p.active?1:0,p.id]);result={status:'saved'};
      }else if(resource==='registration'){
        const existing=await cx.query('SELECT id FROM telecus_demo_profiles WHERE LOWER(email)=$1',[p.email]);if(existing.length)throw new ConflictException('La persona ya tiene perfil. Búscala para editarla.');
        const registrations=await cx.query("SELECT data_json FROM telecus_demo_admin_state WHERE resource='registrations'");if(registrations.some(r=>JSON.parse(r.data_json).email===p.email&&JSON.parse(r.data_json).status==='PENDING'))throw new ConflictException('Ya hay una preinscripción pendiente para ese correo.');
        group='registrations';key=randomUUID();data={...p,status:'PENDING',created_at:new Date().toISOString()};result={status:'registered',id:key};
      }else{
        group=resource.startsWith('knowledge_')?'knowledge':resource==='registration_cancel'?'registrations':resource;key=group==='settings'?'portal':group==='schedule'?'service':p.file||p.id;
        const current=await this.state(group,key,cx);if(!current||current.version!==expected)throw new ConflictException('Los datos cambiaron. Actualiza antes de guardar.');
        data={...current};
        if(resource==='schedule'){schedulePayload(p);data={items:[...current.items,{...p,version:String(Number(current.version)+1)}]};}
        else if(resource==='settings')data={...current,...p};
        else if(resource==='registration_cancel'){if(data.status!=='PENDING')throw new ConflictException('La preinscripción ya fue resuelta.');data.status='CANCELLED';}
        else if(resource==='knowledge_save')data.versions=[{id:randomUUID(),body:p.body,created_at:new Date().toISOString(),author:user.id},...data.versions];
        else if(resource==='knowledge_publish'){if(!data.versions.some((v:any)=>v.id===p.revision_id))throw new ConflictException('Versión no disponible.');data.published_id=p.revision_id;}
        result={status:'saved'};
      }
      if(data){const current=await this.state(group,key,cx);await cx.query('INSERT INTO telecus_demo_admin_state(resource,object_key,version,data_json) VALUES($1,$2,$3,$4) ON CONFLICT(resource,object_key) DO UPDATE SET version=excluded.version,data_json=excluded.data_json',[group,key,current?Number(current.version)+1:1,JSON.stringify(data)]);}
      await cx.query('INSERT INTO telecus_audit(id,owner_id,operation,target_id,created_at) VALUES($1,$2,$3,$4,$5)',[requestId,user.id,'admin:'+resource,p.id||key||resource,new Date().toISOString()]);
      await cx.query('INSERT INTO telecus_demo_admin_commands VALUES($1,$2,$3,$4)',[requestId,user.id,hash,JSON.stringify(result)]);return result;
    });
  }
  private async reviewSnapshot(appointmentId:string,cx:Connection){
    const [a]=await cx.query("SELECT a.*,p.full_name AS patient_name,d.full_name AS doctor_name FROM telecus_demo_appointments a JOIN telecus_demo_profiles p ON p.id=a.patient_id JOIN telecus_demo_profiles d ON d.id=a.doctor_id WHERE a.id=$1",[appointmentId]);
    if(!a||a.status!=='PRE_RESERVED'||a.payment_status!=='PENDING'||new Date(a.start_time).getTime()<=Date.now())throw new ConflictException('La cita ya no tiene un pago pendiente elegible.');
    const [r]=await cx.query('SELECT id,file_name,content_type,size,created_at FROM telecus_demo_payment_receipts WHERE appointment_id=$1 AND withdrawn_at IS NULL',[appointmentId]);
    await this.holds?.eligible(a.id,cx);
    return {appointment:{id:a.id,code:a.code,patient_name:a.patient_name,doctor_name:a.doctor_name,start_time:a.start_time},receipt:r||null,snapshot:JSON.stringify([a.doctor_id,a.start_time,a.end_time,r?.id||null])};
  }
  async prepareReview(user:Profile,appointmentId:string,requestId:string){
    return this.db.transaction(async cx=>{
      await this.actor(user,cx);const old=await this.state('payment_reviews',requestId,cx);
      if(old){if(old.actor!==user.id||old.appointment.id!==appointmentId)throw new ConflictException('La referencia ya fue utilizada.');return old;}
      const data={id:requestId,actor:user.id,...await this.reviewSnapshot(appointmentId,cx),expires_at:new Date(Date.now()+600000).toISOString()};
      await cx.query("INSERT INTO telecus_demo_admin_state VALUES('payment_reviews',$1,1,$2)",[requestId,JSON.stringify(data)]);return data;
    });
  }
  async confirmReview(user:Profile,id:string){
    return this.db.transaction(async cx=>{
      await this.actor(user,cx);const review=await this.state('payment_reviews',id,cx);if(!review||review.actor!==user.id)throw new ForbiddenException('Revisión no disponible para tu cuenta.');
      if(review.result)return review.result;
      if(new Date(review.expires_at).getTime()<=Date.now())throw new ConflictException('La revisión venció. Abre otra para comprobar los datos actuales.');
      const current=await this.reviewSnapshot(review.appointment.id,cx);if(current.snapshot!==review.snapshot)throw new ConflictException('La cita o el comprobante cambió. Abre una revisión nueva.');
      const text=await this.repository.execute(user,'verify_payment',{appointment_code:review.appointment.code},cx,id);
      const result={status:'completed',reply:text,mode:'demo'};review.result=result;
      await cx.query("UPDATE telecus_demo_admin_state SET data_json=$1 WHERE resource='payment_reviews' AND object_key=$2",[JSON.stringify(review),id]);return result;
    });
  }
}
type Agenda={call(name:string,args?:unknown[]):Promise<any>};
export class PostgresAdministrationStore implements AdministrationStore {
  private ready=false;
  constructor(private agenda?:Agenda){}
  available(){return this.ready;}
  async initialize(catalog:KnowledgeDocument[],writeSeeds:boolean){this.ready=Boolean(this.agenda)&&await this.agenda!.call('administration_version')===1;if(this.ready&&writeSeeds)await this.agenda!.call('seed_knowledge_catalog',[JSON.stringify(catalog)]);}
  private require(){if(!this.ready)throw new ServiceUnavailableException('El panel administrativo aún no está habilitado.');}
  async schedules(){this.require();return this.agenda!.call('service_schedules');}
  async settings(){return this.ready?this.agenda!.call('portal_settings'):DEFAULT_PORTAL;}
  async published(){return this.ready?this.agenda!.call('published_knowledge'):[];}
  async claimRegistration(id:string){if(this.ready)await this.agenda!.call('claim_registration',[id]);}
  async read(user:Profile,resource:string,filter:Record<string,unknown>){this.require();if(resource==='schedule'){await this.agenda!.call('administration_read',[user.id,'settings','{}']);return this.schedules();}return this.agenda!.call('administration_read',[user.id,resource,JSON.stringify(filter)]);}
  async write(user:Profile,requestId:string,resource:string,expected:string,payload:Record<string,unknown>){this.require();return resource==='schedule'?this.agenda!.call('save_service_schedule',[user.id,requestId,expected,JSON.stringify(payload)]):this.agenda!.call('administration_write',[user.id,requestId,resource,expected,JSON.stringify(payload)]);}
  async prepareReview(user:Profile,appointmentId:string,requestId:string){this.require();return this.agenda!.call('prepare_payment_review',[user.id,appointmentId,requestId]);}
  async confirmReview(user:Profile,id:string){this.require();return this.agenda!.call('confirm_payment_review',[user.id,id]);}
}
