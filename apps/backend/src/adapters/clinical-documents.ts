import {ConflictException,ForbiddenException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import type {Profile} from '../types.js';
import type {UnitOfWork,Connection} from '../ports/storage.js';
import type {ClinicalMetadata,ClinicalAction} from '../ports/clinical-documents.js';
const publicFile=(r:any)=>({id:r.id,file_name:r.file_name,content_type:r.content_type,size:Number(r.size),created_at:r.created_at,status:r.status,version:Number(r.version)});
export class PostgresClinicalMetadata implements ClinicalMetadata {
 private enabled=false;
 constructor(private agenda?:{call(name:string,args?:unknown[]):Promise<any>}){}
 async initialize(){this.enabled=Boolean(this.agenda&&await this.agenda.call('clinical_documents_version')===1&&await this.agenda.call('clinical_document_list_version')===1);}
 available(){return this.enabled;}
 dispatch(actor:Profile,action:ClinicalAction,input:Record<string,unknown>){return this.agenda!.call('clinical_documents',[actor.id,action,JSON.stringify(input)]);}
}
export class DemoClinicalMetadata implements ClinicalMetadata {
 constructor(private db:UnitOfWork){}
 available(){return true;}
 async initialize(){await this.db.query('CREATE TABLE IF NOT EXISTS telecus_demo_clinical_documents(id TEXT PRIMARY KEY,appointment_id TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,file_name TEXT NOT NULL,content_type TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,storage_key TEXT NOT NULL,created_at TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,reviewed_by TEXT)');}
 async dispatch(actor:Profile,action:ClinicalAction,input:Record<string,any>){return this.db.transaction(async cx=>{
  const [fresh]=await cx.query('SELECT * FROM telecus_demo_profiles WHERE id=$1',[actor.id]);if(!fresh?.active||fresh.role!==actor.role||!['PATIENT','DOCTOR'].includes(fresh.role))throw new ForbiddenException();
  let doc:any;if(input.id)[doc]=await cx.query('SELECT * FROM telecus_demo_clinical_documents WHERE id=$1',[input.id]);const target=doc?.appointment_id||input.appointment_id;
  const rows=await cx.query('SELECT a.*,d.full_name AS doctor_name FROM telecus_demo_appointments a JOIN telecus_demo_profiles d ON d.id=a.doctor_id WHERE '+(actor.role==='PATIENT'?'a.patient_id=$1':'a.doctor_id=$1')+(target?' AND a.id=$2':'')+' ORDER BY a.start_time DESC LIMIT 100',target?[actor.id,target]:[actor.id]);
  if(action==='list')return {items:await Promise.all(rows.map(async a=>({id:a.id,code:a.code,start_time:a.start_time,doctor_name:a.doctor_name,appointment_type:a.appointment_type,status:a.status,can_upload:actor.role==='PATIENT'&&!['CANCELLED','COMPLETED'].includes(a.status)&&new Date(a.start_time).getTime()>Date.now(),documents:(await cx.query("SELECT * FROM telecus_demo_clinical_documents WHERE appointment_id=$1 AND status<>'WITHDRAWN' ORDER BY created_at",[a.id])).map(publicFile)})))};
  const a=rows.find(a=>a.id===(doc?.appointment_id||input.appointment_id));if(!a||input.id&&!doc)throw new ForbiddenException('No se encontró ese documento dentro de tu acceso.');
  const audit=async(document:string)=>{await cx.query('INSERT INTO telecus_audit(id,owner_id,operation,target_id,created_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),actor.id,'clinical_'+action,document,new Date().toISOString()]);};
  const notify=async(document:string,version:number)=>{await audit(document);const recipients=await cx.query("SELECT id,role FROM telecus_demo_profiles WHERE active=1 AND ((role='PATIENT' AND id=$1) OR (role='DOCTOR' AND id=$2))",[a.patient_id,a.doctor_id]);for(const p of recipients)await cx.query('INSERT INTO telecus_notifications(event_key,event_type,payload_json,recipient_id,recipient_role,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key,recipient_id,recipient_role) DO NOTHING',['clinical:'+document+':'+version,'clinical_documents_updated',JSON.stringify({code:a.code}),p.id,p.role,new Date().toISOString()]);};
  if(action==='download'){if(doc.status==='WITHDRAWN')throw new ConflictException('El documento fue retirado.');await audit(doc.id);return doc;}
  if(['CANCELLED','COMPLETED'].includes(a.status)||new Date(a.start_time).getTime()<=Date.now())throw new ConflictException('La cita ya no admite cambios en documentos.');
  if(['prepare','commit','withdraw'].includes(action)&&actor.role!=='PATIENT'||action==='review'&&actor.role!=='DOCTOR')throw new ForbiddenException();
  if(action==='prepare'){
   const [retry]=await cx.query('SELECT * FROM telecus_demo_clinical_documents WHERE request_id=$1',[input.request_id]);if(retry&&(retry.appointment_id!==a.id||retry.sha256!==input.sha256||retry.file_name!==input.file_name||retry.status==='WITHDRAWN'))throw new ConflictException('Este envío ya corresponde a otro documento.');
   if(!retry){const docs=await cx.query('SELECT status FROM telecus_demo_clinical_documents WHERE appointment_id=$1',[a.id]);if(docs.length>=100||docs.filter(d=>d.status!=='WITHDRAWN').length>=10)throw new ConflictException('Se alcanzó el límite de documentos para esta cita.');}return {allowed:true};
  }
  if(action==='commit'){
   const [old]=await cx.query('SELECT * FROM telecus_demo_clinical_documents WHERE request_id=$1',[input.request_id]);if(old){if(old.appointment_id!==a.id||old.sha256!==input.sha256||old.storage_key!==input.storage_key||old.file_name!==input.file_name||old.status==='WITHDRAWN')throw new ConflictException('Este envío ya corresponde a otro documento.');return publicFile(old);}
   const docs=await cx.query('SELECT status FROM telecus_demo_clinical_documents WHERE appointment_id=$1',[a.id]);if(docs.length>=100||docs.filter(d=>d.status!=='WITHDRAWN').length>=10)throw new ConflictException('Se alcanzó el límite de documentos para esta cita.');
   const record={id:randomUUID(),...input,created_at:new Date().toISOString(),status:'RECEIVED',version:1};await cx.query('INSERT INTO telecus_demo_clinical_documents(id,appointment_id,request_id,file_name,content_type,size,sha256,storage_key,created_at,status,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[record.id,a.id,input.request_id,input.file_name,input.content_type,input.size,input.sha256,input.storage_key,record.created_at,record.status,1]);await notify(record.id,1);return publicFile(record);
  }
  if(action==='withdraw'){if(doc.status==='WITHDRAWN')return {withdrawn:true};await cx.query("UPDATE telecus_demo_clinical_documents SET status='WITHDRAWN',version=version+1 WHERE id=$1",[doc.id]);await notify(doc.id,Number(doc.version)+1);return {withdrawn:true};}
  if(action==='review'){if(doc.status==='WITHDRAWN'||Number(doc.version)!==input.version)throw new ConflictException('El documento cambió. Actualiza antes de revisarlo.');await cx.query('UPDATE telecus_demo_clinical_documents SET status=$1,version=version+1,reviewed_by=$2 WHERE id=$3',[input.status,actor.id,doc.id]);await notify(doc.id,Number(doc.version)+1);return {updated:true};}
  throw new ForbiddenException();
 });}
}
