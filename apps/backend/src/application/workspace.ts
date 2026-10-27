import {BadRequestException,ConflictException,ForbiddenException} from '@nestjs/common';
import type {Profile} from '../types.js';
import type {SchedulingRepository} from '../ports/application.js';
import type {ReviewSigner,WorkspaceStore,UsageMetrics,StaffFilter} from '../ports/workspace.js';
import {operationReply} from '../presentation.js';
import type {AdministrationStore} from '../ports/administration.js';
import {rejectionReason,publicRejectionNotice} from './rejection-reasons.js';

/** Administrative and medical workflows call domain repositories directly; no language model or chat job. */
export class WorkspaceService {
  constructor(private readonly scheduling:SchedulingRepository,private readonly store:WorkspaceStore,private readonly signer:ReviewSigner,private readonly metrics?:UsageMetrics,private readonly administration?:AdministrationStore){}
  private filter(input:Record<string,unknown>={}):StaffFilter{const view=String(input.view||'current'),offset=Number(input.offset||0);if(!['current','history','all'].includes(view)||!Number.isInteger(offset)||offset<0||offset>100000)throw new BadRequestException('Filtros no válidos.');return {view:view as StaffFilter['view'],offset,q:typeof input.q==='string'?input.q.trim().slice(0,80):''};}
  private async measured<T>(actor:Profile,route:string,work:()=>Promise<T>){const start=Date.now();let success=false;try{const value=await work();success=true;return value;}finally{await this.metrics?.record(route,actor.role,Date.now()-start,success).catch(()=>{});}}
  private staff(actor:Profile){
    if(!actor.active||!['ADMIN','DOCTOR'].includes(actor.role))throw new ForbiddenException('Este panel requiere una cuenta de médico o administración.');
  }
  async appointments(actor:Profile,filter:Record<string,unknown>={}){this.staff(actor);return this.measured(actor,'appointments',()=>this.store.page(actor,this.filter(filter)));}
  async requests(actor:Profile,filter:Record<string,unknown>={}){this.staff(actor);if(actor.role!=='ADMIN')throw new ForbiddenException('Solo administración puede revisar solicitudes.');return this.measured(actor,'requests',()=>this.store.requests(actor,this.filter(filter)));}
  async information(actor:Profile){this.staff(actor);const items=await this.administration?.published()||[];return {items:items.filter(d=>d.roles.includes(actor.role.toLowerCase())).map(d=>({title:d.title,body:d.body,version:d.version})),notice:'Documentos institucionales publicados. El horario operativo se consulta en la configuración del servicio.'};}
  async usage(actor:Profile){this.staff(actor);if(actor.role!=='ADMIN')throw new ForbiddenException('Solo administración puede consultar métricas.');return this.metrics?.read()||{available:false};}
  async doctors(actor:Profile){
    if(actor.role!=='ADMIN')throw new ForbiddenException('Acceso reservado a administración.');
    return {items:await this.scheduling.doctors(actor)};
  }
  async availability(actor:Profile,doctorId:unknown,date:unknown){
    if(actor.role!=='ADMIN')throw new ForbiddenException('Solo administración puede consultar disponibilidad desde este panel.');
    if(typeof doctorId!=='string'||!(await this.scheduling.doctors(actor)).some(d=>d.id===doctorId))throw new BadRequestException('Selecciona un médico activo.');
    if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new BadRequestException('Selecciona una fecha válida.');
    return {doctor_id:doctorId,date,slots:await this.scheduling.availability(actor,doctorId,date)};
  }
  async prepare(actor:Profile,raw:unknown){
    this.staff(actor);
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new BadRequestException('Solicitud inválida.');
    const input=raw as Record<string,unknown>;
    const kind=input.kind;
    const permitted=actor.role==='DOCTOR'?['complete']:['approve_change','reject_change','assign_doctor','reschedule','cancel','confirm_free'];
    if(typeof kind!=='string'||!permitted.includes(kind))throw new ForbiddenException('La acción no está permitida para tu rol.');
    
    if(typeof input.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId))throw new BadRequestException('Identificador de operación inválido.');
    if(this.scheduling.mode==='supabase-readonly')throw new ForbiddenException('Esta conexión solo admite consultas.');
    const payload:Record<string,string>={};
    const appointmentActions=['complete','assign_doctor','reschedule','cancel','confirm_free'];
    if(appointmentActions.includes(kind)){
      if(typeof input.appointment_code!=='string'||!/^[-A-Za-z0-9]{3,60}$/.test(input.appointment_code))throw new BadRequestException('Selecciona una cita válida.');
      payload.appointment_code=input.appointment_code;
      // The store scopes the exact record to the current role and freezes its non-clinical state.
    }
    if(kind==='approve_change'||kind==='reject_change'){
      if(typeof input.request_id!=='string'||!input.request_id||input.request_id.length>100)throw new BadRequestException('Selecciona una solicitud válida.');
      payload.request_id=input.request_id;
      if(kind==='reject_change')Object.assign(payload,rejectionReason(input));
    }
    if(kind==='assign_doctor'){
      if(typeof input.doctor_id!=='string'||!(await this.scheduling.doctors(actor)).some(d=>d.id===input.doctor_id))throw new BadRequestException('Selecciona un médico activo.');
      payload.doctor_id=input.doctor_id;
    }
    if(kind==='reschedule'){
      if(typeof input.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(input.date)||typeof input.time!=='string'||!/^\d{2}:\d{2}$/.test(input.time))throw new BadRequestException('Selecciona fecha y hora completas.');
      payload.date=input.date;payload.time=input.time;
    }
    const prepared=await this.store.snapshot(actor,kind,payload),snapshot=prepared.snapshot,details=kind==='reject_change'?{...prepared.details,...rejectionReason(payload),patient_notice:publicRejectionNotice(prepared.details.appointment_code,prepared.details.request_type,payload.public_reason,prepared.details.current_start_time)}:prepared.details;
    const review={id:input.requestId as string,actor_id:actor.id,role:actor.role,expires_at:new Date(Date.now()+600000).toISOString(),kind,payload,snapshot,details};
    return {token:this.signer.seal(review),id:review.id,kind,expires_at:review.expires_at,details};
  }
  async action(actor:Profile,raw:unknown){
    this.staff(actor);if(this.scheduling.mode==='supabase-readonly')throw new ForbiddenException('Esta conexión solo admite consultas.');
    const input=raw as any;if(!input||input.confirmed!==true||typeof input.token!=='string')throw new BadRequestException('Revisa y confirma los datos de la operación.');
    const review=this.signer.open(input.token);if(review.kind==='confirm_free'&&input.admission_checked!==true)throw new BadRequestException('Confirma que revisaste la admisión de la solicitud gratuita.');if(review.kind==='complete'&&input.attended!==true)throw new BadRequestException('Confirma expresamente que realizaste la atención de esta cita.');if(review.actor_id!==actor.id||review.role!==actor.role)throw new ForbiddenException('Esta revisión pertenece a otra cuenta.');
    if(review.kind==='reject_change')rejectionReason(review.payload);
    if(new Date(review.expires_at).getTime()<=Date.now())throw new ConflictException('La revisión venció. Revisa nuevamente los datos.');
    return this.measured(actor,'confirm',async()=>{
      const result=await this.store.commit(actor,review);
      const pending=/^Operación de .+ registrada para sincronizar con Google\./.test(result);
      const labels:Record<string,string>={approve_change:'Aprobación registrada',reject_change:'Solicitud rechazada',cancel:'Cancelación registrada',reschedule:'Reprogramación registrada',assign_doctor:'Asignación registrada',complete:'Atención registrada',confirm_free:'Admisión registrada'};
      return {message:pending?`${labels[review.kind]||'Operación registrada'}. Te avisaremos cuando se complete en la agenda.`:operationReply(review.kind,result),mode:this.scheduling.mode};
    });
  }
}
