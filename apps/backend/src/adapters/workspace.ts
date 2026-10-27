import {ConflictException,ForbiddenException} from '@nestjs/common';
import type {Profile} from '../types.js';
import {financiallyCleared} from '../application/visit-policy.js';
import type {Connection,UnitOfWork} from '../ports/storage.js';
import type {SchedulingRepository} from '../ports/application.js';
import type {WorkspaceStore,StaffFilter,StaffReview,UsageMetrics} from '../ports/workspace.js';
type Agenda={call(name:string,args?:unknown[]):Promise<any>;execute(actor:Profile,id:string,kind:string,payload:Record<string,unknown>):Promise<string>};
export class PostgresWorkspaceStore implements WorkspaceStore {
  constructor(private agenda:Agenda){}
  async initialize(){if(await this.agenda.call('workspace_version')!==1)throw Error('Falta la migración 007 de los paneles de personal.');}
  page(actor:Profile,filter:StaffFilter){return this.agenda.call('workspace_appointments',[actor.id,JSON.stringify(filter)]);}
  requests(actor:Profile,filter:StaffFilter){return this.agenda.call('workspace_requests',[actor.id,JSON.stringify(filter)]);}
  snapshot(actor:Profile,kind:string,payload:Record<string,unknown>){return this.agenda.call('staff_snapshot',[actor.id,kind,JSON.stringify(payload)]);}
  commit(actor:Profile,review:StaffReview){return this.agenda.execute(actor,review.id,review.kind,{...review.payload,expected_snapshot:review.snapshot});}
}
export class DemoWorkspaceStore implements WorkspaceStore {
  constructor(private db:UnitOfWork,private scheduling:SchedulingRepository){}
  async initialize(){await this.db.query('CREATE TABLE IF NOT EXISTS telecus_staff_commands(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL)');}
  private async actor(actor:Profile,cx:Connection=this.db){const [p]=await cx.query('SELECT role,active FROM telecus_demo_profiles WHERE id=$1',[actor.id]);if(!p?.active||p.role!==actor.role||!['ADMIN','DOCTOR'].includes(p.role))throw new ForbiddenException('Se requiere un perfil de personal activo.');}
  async page(actor:Profile,filter:StaffFilter){
    await this.actor(actor);const rows=await this.db.query("SELECT a.*,d.full_name AS doctor_name FROM telecus_demo_appointments a JOIN telecus_demo_profiles d ON d.id=a.doctor_id WHERE ($1='ADMIN' OR (a.doctor_id=$2 AND a.payment_status IN ('VERIFIED','NOT_REQUIRED') AND a.status<>'PRE_RESERVED')) ORDER BY a.start_time,a.id",[actor.role,actor.id]);
    const active=(a:any)=>!['CANCELLED','COMPLETED'].includes(a.status),filtered=rows.filter(a=>(filter.view==='all'||(filter.view==='current'?active(a):!active(a)))&&(a.code+' '+a.doctor_name).toLocaleLowerCase('es').includes(filter.q.toLocaleLowerCase('es')));
    if(filter.view==='history')filtered.reverse();
    const items=filtered.slice(filter.offset,filter.offset+25).map(a=>({id:a.id,code:a.code,doctor_id:a.doctor_id,doctor_name:a.doctor_name,start_time:a.start_time,end_time:a.end_time,status:a.status,payment_status:a.payment_status,appointment_type:a.appointment_type,...(actor.role==='DOCTOR'&&financiallyCleared(a)&&['CONFIRMED','RESCHEDULED'].includes(a.status)&&/^https:\/\/meet\.google\.com\/[a-z0-9-]+$/.test(a.meet_url||'')?{meet_url:a.meet_url}:{})}));
    const receiptRows=actor.role==='ADMIN'?await this.db.query('SELECT appointment_id FROM telecus_demo_payment_receipts WHERE withdrawn_at IS NULL'):[],received=new Set(receiptRows.map(r=>r.appointment_id));
    const unpaid=rows.filter(a=>a.status==='PRE_RESERVED'&&a.payment_status==='PENDING'&&new Date(a.start_time).getTime()>Date.now());
    const [changes]=await this.db.query("SELECT COUNT(*) AS n FROM telecus_demo_changes WHERE status='PENDING'");return {items,next_offset:filtered.length>filter.offset+25?filter.offset+25:null,counts:{pending_admissions:rows.filter(a=>a.status==='PRE_RESERVED'&&a.payment_status==='NOT_REQUIRED'&&new Date(a.start_time).getTime()>Date.now()).length,active:rows.filter(active).length,pending_payments:unpaid.filter(a=>received.has(a.id)).length,awaiting_receipt:unpaid.filter(a=>!received.has(a.id)).length,pending_requests:actor.role==='ADMIN'?Number(changes.n):0,to_complete:rows.filter(a=>financiallyCleared(a)&&['CONFIRMED','RESCHEDULED'].includes(a.status)&&new Date(a.end_time).getTime()<=Date.now()).length},scope:'Datos ficticios del entorno de prueba'};
  }
  async requests(actor:Profile,filter:StaffFilter){await this.actor(actor);if(actor.role!=='ADMIN')throw new ForbiddenException();const rows=await this.scheduling.changeDetails(actor,undefined,true),ordered=rows.filter(r=>filter.view==='all'||(filter.view==='current'?r.status==='PENDING':r.status!=='PENDING')).filter(r=>(r.appointment_code||'').toLowerCase().includes(filter.q.toLowerCase())).sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')));return {items:ordered.slice(filter.offset,filter.offset+25),next_offset:ordered.length>filter.offset+25?filter.offset+25:null};}
  snapshot(actor:Profile,kind:string,payload:Record<string,any>){return this.snapshotAt(actor,kind,payload,this.db);}
  private async snapshotAt(actor:Profile,kind:string,payload:Record<string,any>,cx:Connection){
    await this.actor(actor,cx);if(actor.role==='DOCTOR'&&kind!=='complete'||actor.role==='ADMIN'&&!['cancel','reschedule','assign_doctor','approve_change','reject_change','confirm_free'].includes(kind))throw new ForbiddenException();
    let change:any;if(['approve_change','reject_change'].includes(kind)){[change]=await cx.query("SELECT * FROM telecus_demo_changes WHERE id=$1 AND status='PENDING'",[payload.request_id]);if(!change)throw new ConflictException('La solicitud ya no está pendiente. Actualiza la lista.');}
    const [a]=await cx.query('SELECT a.*,d.full_name AS doctor_name FROM telecus_demo_appointments a JOIN telecus_demo_profiles d ON d.id=a.doctor_id WHERE '+(change?'a.id=$1':'a.code=$1'),[change?.appointment_id||payload.appointment_code]);
    if(!a||actor.role==='DOCTOR'&&(a.doctor_id!==actor.id||!financiallyCleared(a)))throw new ForbiddenException('Esta cita no está dentro de tu acceso.');
    if(['CANCELLED','COMPLETED'].includes(a.status))throw new ConflictException('La cita ya no admite esa operación.');
    if(kind==='complete'&&(!financiallyCleared(a)||!['CONFIRMED','RESCHEDULED'].includes(a.status)||new Date(a.end_time).getTime()>Date.now()))throw new ConflictException('Solo puedes finalizar una cita confirmada cuyo horario haya terminado.');
    if(kind==='confirm_free'&&(a.payment_status!=='NOT_REQUIRED'||a.status!=='PRE_RESERVED'||new Date(a.start_time).getTime()<=Date.now()))throw new ConflictException('La solicitud gratuita ya no está pendiente de admisión.');
    const [selected]=kind==='assign_doctor'?await cx.query("SELECT id,full_name FROM telecus_demo_profiles WHERE id=$1 AND role='DOCTOR' AND active=1",[payload.doctor_id]):[];if(kind==='assign_doctor'&&!selected)throw new ConflictException('El médico seleccionado ya no está activo.');
    const [schedule]=await cx.query("SELECT version FROM telecus_demo_admin_state WHERE resource='schedule' AND object_key='service'");
    return {snapshot:[a.id,a.doctor_id,a.start_time,a.end_time,a.status,a.payment_status,change?.id||null,change?.status||null,change?.requested_start_time||null,change?.requested_end_time||null,selected?.id||null,['reschedule','approve_change'].includes(kind)?String(schedule?.version||'1'):null],details:{appointment_code:a.code,doctor_name:a.doctor_name,current_start_time:a.start_time,current_end_time:a.end_time,requested_start_time:change?.requested_start_time||null,request_type:change?.request_type||null,target_doctor_name:selected?.full_name||null,date:payload.date||null,time:payload.time||null}};
  }
  commit(actor:Profile,review:StaffReview){return this.db.transaction(async cx=>{await this.actor(actor,cx);const fingerprint=JSON.stringify([review.kind,review.payload,review.snapshot]),[old]=await cx.query('SELECT * FROM telecus_staff_commands WHERE id=$1',[review.id]);if(old){if(old.actor_id!==actor.id||old.fingerprint!==fingerprint)throw new ConflictException('La referencia ya corresponde a otra operación.');return old.result;}const current=await this.snapshotAt(actor,review.kind,review.payload,cx);if(JSON.stringify(current.snapshot)!==JSON.stringify(review.snapshot))throw new ConflictException('La cita, solicitud u horario cambió. Revisa otra vez la operación.');const result=await this.scheduling.execute(actor,review.kind,review.payload,cx,review.id);await cx.query('INSERT INTO telecus_staff_commands VALUES($1,$2,$3,$4)',[review.id,actor.id,fingerprint,result]);return result;});}
}

/** Technical aggregates only, per API database. No messages, tokens, identities or clinical content. */
export class DatabaseUsageMetrics implements UsageMetrics {
  constructor(private db:UnitOfWork){}
  async initialize(){await this.db.query('CREATE TABLE IF NOT EXISTS telecus_usage(route TEXT NOT NULL,role TEXT NOT NULL,requests INTEGER NOT NULL,failures INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL,PRIMARY KEY(route,role))');}
  async record(route:string,role:string,elapsed:number,success:boolean){await this.db.query('INSERT INTO telecus_usage VALUES($1,$2,1,$3,$4) ON CONFLICT(route,role) DO UPDATE SET requests=telecus_usage.requests+1,failures=telecus_usage.failures+excluded.failures,elapsed_ms=telecus_usage.elapsed_ms+excluded.elapsed_ms',[route,role,success?0:1,Math.max(0,Math.round(elapsed))]);}
  async read(){const [direct,chat]=await Promise.all([this.db.query('SELECT route,role,requests,failures,elapsed_ms FROM telecus_usage ORDER BY role,route'),this.db.query('SELECT owner_role AS role,status,COUNT(*) AS requests FROM telecus_jobs GROUP BY owner_role,status')]);return {available:true,direct:direct.map(r=>({...r,mean_ms:Math.round(r.elapsed_ms/Math.max(1,r.requests))})),chat_jobs:chat,scope:'Acumulado de esta base de API; los trabajos de chat no equivalen a llamadas al modelo. No mide GPU, RAM ni tokens.'};}
}
