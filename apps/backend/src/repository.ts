import type {DemoReservationHolds} from './adapters/reservation-holds.js';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Database, Connection } from './database.js';
import { Profile } from './types.js';
import { config } from './config.js';
import type { AgendaPort } from './ports/integrations.js';
import type { SchedulingRepository } from './ports/application.js';
import { publishDemoNotification } from './adapters/notification-inbox.js';
import {rejectionReason} from './application/rejection-reasons.js';
import {LEGACY_VISIT_POLICY,VISIT_TYPES,visitType,financiallyCleared,type VisitPolicy} from './application/visit-policy.js';
export const demoIds = { patient: '10000000-0000-4000-8000-000000000001', otherPatient: '10000000-0000-4000-8000-000000000002', admin: '20000000-0000-4000-8000-000000000001', doctor: '30000000-0000-4000-8000-000000000001', otherDoctor: '30000000-0000-4000-8000-000000000002' };
import {DEFAULT_SCHEDULE_BOOK,scheduleFor,scheduleTimes,validServiceDay,type ScheduleBook} from './application/service-schedule.js';
import { pilotTimes,serviceDate } from './application/appointments.js';
export { pilotTimes,timeLabel,changeSummary,appointmentSummary,serviceDate } from './application/appointments.js';
export class Repository implements SchedulingRepository {
  get mode(){return this.cfg.mode;}
  async pendingDeliveries(user:Profile){const deliveries=this.agenda?(await this.agenda.deliveryStatus(user)).filter(d=>d.status!=='done'):[];if(this.agenda?.visitsAvailable&&deliveries.some(d=>d.operation==='confirm')){const appointments=await this.appointments(user);return deliveries.map(d=>({...d,payment_required:appointments.find(a=>a.code===d.code)?.payment_status!=='NOT_REQUIRED'}));}return deliveries;}
  constructor(public db: Database, public cfg: ReturnType<typeof config>, public agenda?: AgendaPort,private scheduleSource?:(cx?:Connection)=>Promise<ScheduleBook>,private holds?:DemoReservationHolds,private visitSource?:(cx?:Connection)=>Promise<VisitPolicy>) {}
  async visitPolicy(cx?:Connection){return this.visitSource?this.visitSource(cx):LEGACY_VISIT_POLICY;}
  async schedules(cx?:Connection){return this.scheduleSource?this.scheduleSource(cx):DEFAULT_SCHEDULE_BOOK;}
  async seed() {
    if (this.cfg.mode !== 'demo') return;
    for (const p of [
      [demoIds.patient,'PATIENT','Paciente de prueba','paciente@example.test',1], [demoIds.otherPatient,'PATIENT','Otro paciente','otro@example.test',1],
      [demoIds.admin,'ADMIN','Administración de prueba','admin@example.test',1], [demoIds.doctor,'DOCTOR','Dra. Ana López','ana@example.test',1], [demoIds.otherDoctor,'DOCTOR','Dr. Carlos Pérez','carlos@example.test',1]
    ]) await this.db.query('INSERT INTO telecus_demo_profiles(id,role,full_name,email,active) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING', p);
    const future = new Date(); future.setUTCDate(future.getUTCDate()+((8-future.getUTCDay())%7 || 7)); const day = future.toISOString().slice(0,10);
    await this.db.query(`INSERT INTO telecus_demo_appointments(id,code,patient_id,doctor_id,start_time,end_time,status,payment_status,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(code) DO NOTHING`, ['demo-appointment-1','TCUS-DEMO-001',demoIds.patient,demoIds.doctor,`${day}T19:00:00.000Z`,`${day}T19:30:00.000Z`,'PRE_RESERVED','PENDING','Consulta general de prueba']);
  }
  private async live(user: Profile, table: string, parameters: Record<string,string>) {
    const response = await fetch(`${this.cfg.supabaseUrl}/rest/v1/${table}?${new URLSearchParams(parameters)}`, { headers: { apikey: this.cfg.supabaseKey, Authorization: `Bearer ${user.token}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new BadRequestException('No fue posible consultar la agenda.');
    return await response.json() as any[];
  }
  async doctors(user: Profile, cx: Connection = this.db) {
    if (this.agenda) return this.agenda.doctors(user);
    if (this.cfg.mode !== 'demo') return this.live(user, 'profiles', { role: 'eq.DOCTOR', active: 'eq.true', select: 'id,full_name', order: 'full_name.asc', limit: '100' });
    return cx.query("SELECT id,full_name FROM telecus_demo_profiles WHERE role='DOCTOR' AND active=1 ORDER BY full_name");
  }
  async appointments(user: Profile, cx: Connection = this.db, ids?:string[]) {
    if(this.agenda?.visitsAvailable&&this.agenda.appointments)return this.agenda.appointments(user,ids);
    const field = user.role === 'PATIENT' ? 'patient_id' : 'doctor_id';
    if (this.cfg.mode !== 'demo') return this.live(user,'appointments', { select:'id,code,patient_id,doctor_id,start_time,end_time,status,payment_status,meet_url', ...(user.role !== 'ADMIN' ? { [field]:`eq.${user.id}` } : {}), ...(user.role==='DOCTOR'?{payment_status:'eq.VERIFIED',status:'not.in.(PRE_RESERVED,CANCELLED,COMPLETED)'}:{}), ...(ids?{id:`in.(${ids.join(',')})`}:{}), order:'start_time.asc', limit:'100' });
    return cx.query(`SELECT * FROM telecus_demo_appointments ${user.role === 'ADMIN' ? '' : `WHERE ${field}=$1`}${user.role==='DOCTOR'?" AND payment_status IN ('VERIFIED','NOT_REQUIRED') AND status NOT IN ('PRE_RESERVED','CANCELLED','COMPLETED')":''} ORDER BY start_time`, user.role === 'ADMIN' ? [] : [user.id]);
  }
  async pendingPaymentAppointments(user:Profile){
    if(!['PATIENT','ADMIN'].includes(user.role))throw new ForbiddenException('Tu rol no permite consultar pagos.');
    if(this.cfg.mode==='demo')return this.db.query("SELECT id,code,patient_id,doctor_id,start_time,end_time,status,payment_status FROM telecus_demo_appointments WHERE status='PRE_RESERVED' AND payment_status='PENDING' AND start_time>$1"+(user.role==='PATIENT'?' AND patient_id=$2':'')+' ORDER BY start_time LIMIT 20',user.role==='PATIENT'?[new Date().toISOString(),user.id]:[new Date().toISOString()]);
    return this.live(user,'appointments',{select:'id,code,patient_id,doctor_id,start_time,end_time,status,payment_status',status:'eq.PRE_RESERVED',payment_status:'eq.PENDING',start_time:'gt.'+new Date().toISOString(),...(user.role==='PATIENT'?{patient_id:'eq.'+user.id}:{}),order:'start_time.asc',limit:'20'});
  }
  async portalAppointments(user:Profile,code?:string,cx:Connection=this.db){
    if(user.role!=='PATIENT')throw new ForbiddenException('Se requiere un paciente activo.');
    if(this.agenda?.patientAppointments)return this.agenda.patientAppointments(user,code);
    const appointments=(await this.appointments(user,cx)).filter(a=>code?a.code===code:!['CANCELLED','COMPLETED'].includes(a.status)),doctors=await this.doctors(user,cx);
    return appointments.map(a=>({...a,doctor_name:doctors.find(d=>d.id===a.doctor_id)?.full_name||'Médico asignado',can_documents:!['CANCELLED','COMPLETED'].includes(a.status),payment_required:a.payment_status!=='NOT_REQUIRED'}));
  }
  async changes(user: Profile, cx: Connection = this.db, all=false) {
    if(user.role==='DOCTOR')throw new ForbiddenException('Tu rol no permite consultar solicitudes de cambio.');
    if (this.cfg.mode !== 'demo') return this.live(user,'appointment_change_requests', { select:'id,appointment_id,patient_id,request_type,requested_start_time,requested_end_time,status,created_at', ...(user.role !== 'ADMIN' ? {patient_id:`eq.${user.id}`} : (all?{}:{status:'eq.PENDING'})),order:'created_at.desc', limit:'100' });
    return cx.query(`SELECT * FROM telecus_demo_changes ${user.role === 'ADMIN' ? (all?'':"WHERE status='PENDING'") : 'WHERE patient_id=$1'}`, user.role === 'ADMIN' ? [] : [user.id]);
  }
  async changeDetails(user:Profile,cx:Connection=this.db,all=false){
    const changes=await this.changes(user,cx,all);if(!changes.length)return [];
    const appointments=await this.appointments(user,cx,[...new Set(changes.map(c=>String(c.appointment_id)))]),doctors=await this.doctors(user,cx);
    const reasons=this.agenda?.publicRejections?await this.agenda.publicRejections(user,changes.map(c=>c.id)):this.cfg.mode==='demo'?await cx.query('SELECT request_id,category AS rejection_category,message AS public_reason FROM telecus_public_rejections WHERE request_id IN ('+changes.map((_,i)=>'$'+(i+1)).join(',')+')',changes.map(c=>c.id)):[];
    return changes.map(c=>{const a=appointments.find(a=>a.id===c.appointment_id),reason=reasons.find(r=>r.request_id===c.id);return {...c,...(c.status==='REJECTED'&&reason?{public_reason:reason.public_reason,rejection_category:reason.rejection_category}:{}),appointment_code:a?.code,current_start_time:a?.start_time,appointment_status:a?.status,doctor_name:doctors.find(d=>d.id===a?.doctor_id)?.full_name};});
  }
  async availability(user: Profile, doctorId: string, date: string, cx: Connection = this.db) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('Indica el día en formato año-mes-día.');
    const day = new Date(`${date}T12:00:00-05:00`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0,10)!==date) throw new BadRequestException('Fecha inválida.');
    const policy=scheduleFor(await this.schedules(cx),date);
    if (!validServiceDay(date,policy)) return [];
    if (this.agenda) return this.agenda.availability(user, doctorId, date);
    // No safe availability function was found in the original schema inspection.
    if (this.cfg.mode !== 'demo') throw new BadRequestException('La disponibilidad real requiere una función de Supabase que devuelva horarios libres sin datos de otros pacientes.');
    const appointments = await cx.query("SELECT start_time,end_time FROM telecus_demo_appointments WHERE doctor_id=$1 AND status NOT IN ('CANCELLED','COMPLETED')", [doctorId]);
    return scheduleTimes(policy).filter(time => { const start=new Date(`${date}T${time}:00-05:00`).getTime(); return start>Date.now() && !appointments.some(a=>new Date(a.start_time).getTime()<start+1800000 && new Date(a.end_time).getTime()>start); });
  }
  async serviceAvailability(user:Profile,date:string,cx:Connection=this.db){
    if(this.agenda?.visitsAvailable&&this.agenda.serviceAvailability)return this.agenda.serviceAvailability(user,date);
    const doctors=await this.doctors(user,cx),slots=new Set<string>();
    for(const doctor of doctors)for(const slot of await this.availability(user,doctor.id,date,cx))slots.add(slot);
    return [...slots].sort();
  }
  async allocateDoctor(user:Profile,date:string,time:string,cx:Connection=this.db){
    if(this.cfg.mode!=='demo')return null; // Live allocation is atomic inside the restricted PostgreSQL command.
    const candidates=[];for(const doctor of await this.doctors(user,cx))if((await this.availability(user,doctor.id,date,cx)).includes(time)){
      const [load]=await cx.query("SELECT count(*) AS n FROM telecus_demo_appointments WHERE doctor_id=$1 AND status NOT IN ('CANCELLED','COMPLETED') AND start_time >= $2 AND start_time < $3",[doctor.id,date+'T05:00:00.000Z',new Date(new Date(date+'T05:00:00.000Z').getTime()+86400000).toISOString()]);
      candidates.push({...doctor,load:Number(load.n)});
    }
    candidates.sort((a,b)=>a.load-b.load||a.id.localeCompare(b.id));return candidates[0]||null;
  }
  async execute(user: Profile, kind: string, payload: Record<string,any>, cx: Connection, operationId?: string) {
    if(this.cfg.mode!=='demo')return this.executeMutation(user,kind,payload,cx,operationId);
    const before=await cx.query('SELECT * FROM telecus_demo_appointments'),oldChanges=await cx.query('SELECT * FROM telecus_demo_changes');
    const result=await this.executeMutation(user,kind,payload,cx,operationId),key=operationId||randomUUID();
    const appointments=await cx.query('SELECT * FROM telecus_demo_appointments');
    if(kind==='reschedule')for(const a of appointments)if(a.status==='PRE_RESERVED')await this.holds?.cap(a.id,cx);
    for(const a of appointments){
      const old=before.find(x=>x.id===a.id);let event:string|undefined;
      if(!old)event='appointment_requested';
      else if(a.status==='CANCELLED'&&old.status!==a.status)event='appointment_cancelled';
      else if(a.status==='COMPLETED'&&old.status!==a.status)event='appointment_completed';
      else if(financiallyCleared(a)&&['CONFIRMED','RESCHEDULED'].includes(a.status)){
        if(old.payment_status!==a.payment_status||old.status==='PRE_RESERVED')event='appointment_confirmed';
        else if(old.start_time!==a.start_time||old.end_time!==a.end_time)event='appointment_rescheduled';
        else if(old.doctor_id!==a.doctor_id)event='doctor_assigned';
      }
      if(event)await publishDemoNotification(cx,key+':'+a.id+':'+event,event,a,undefined,undefined,event==='appointment_cancelled'&&oldChanges.some(c=>c.appointment_id===a.id&&c.status==='PENDING'&&c.request_type==='CANCEL'));
      if(old&&old.doctor_id!==a.doctor_id&&financiallyCleared(old))await publishDemoNotification(cx,key+':'+a.id+':removed','appointment_unassigned',a,undefined,old.doctor_id);
    }
    for(const change of await cx.query('SELECT * FROM telecus_demo_changes')){
      const old=oldChanges.find(x=>x.id===change.id),a=appointments.find(x=>x.id===change.appointment_id);
      const event=!old?'change_requested':old.status!==change.status?(change.status==='APPROVED'?'change_approved':'change_rejected'):undefined;
      if(event==='change_rejected'&&a&&['CANCELLED','COMPLETED'].includes(a.status))await cx.query('INSERT INTO telecus_public_rejections(request_id,category,message,actor_id,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(request_id) DO NOTHING',[change.id,'appointment_closed','La cita ya fue cancelada o finalizada; esta solicitud de cambio dejó de corresponder.',user.id,new Date().toISOString()]);
      if(event&&a)await publishDemoNotification(cx,change.id+':'+event,event,a,change);
    }
    return result;
  }
  private async executeMutation(user: Profile, kind: string, payload: Record<string,any>, cx: Connection, operationId?: string) {
    if (this.cfg.mode === 'supabase-live' && this.agenda && operationId) return this.agenda.execute(user, operationId, kind, payload);
    if (this.cfg.mode !== 'demo') throw new ForbiddenException('Esta conexión permite consultas. Los cambios reales se habilitarán después de verificar las reglas de la base de datos y las conexiones de Calendar y correo.');
    if (this.db.driver==='postgresql') await cx.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', ['telecus-demo-appointments']);
    if(kind==='reserve')await this.holds?.expire(cx);
    const appointments = await this.appointments(user,cx);
    const appointment = appointments.find(a=>a.code===payload.appointment_code);
    if (kind==='reserve') {
      const policy=await this.visitPolicy(cx);
      if(policy.available&&(!VISIT_TYPES.some(t=>t.code===payload.appointment_type)||payload.visit_policy_version!==policy.version))throw new ConflictException('Revisa el tipo de atención y la modalidad actual del servicio.');
      if(user.role!=='PATIENT') throw new ForbiddenException('Solo el paciente puede solicitar una pre-reserva.');
      if(appointments.some(a=>!['CANCELLED','COMPLETED'].includes(a.status) && new Date(a.end_time).getTime()>Date.now())) throw new ConflictException('Ya tienes una cita vigente.');
      const doctor=policy.available?await this.allocateDoctor(user,payload.date,payload.time,cx):(await this.doctors(user,cx)).find(d=>d.id===payload.doctor_id);
      if(!doctor) throw new BadRequestException('Médico no disponible.');
      const interval=serviceDate(payload.date,payload.time,scheduleFor(await this.schedules(cx),payload.date));
      if(!(await this.availability(user,doctor.id,payload.date,cx)).includes(payload.time)) throw new ConflictException('El horario acaba de ocuparse. Elige otro.');
      const code=`TCUS-${randomUUID().slice(0,8).toUpperCase()}`;
      const free=policy.available&&!policy.payments_enabled;
      await cx.query('INSERT INTO telecus_demo_appointments(id,code,patient_id,doctor_id,start_time,end_time,status,payment_status,reason,appointment_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [randomUUID(),code,user.id,doctor.id,interval.start,interval.end,'PRE_RESERVED',free?'NOT_REQUIRED':'PENDING',String(payload.reason||'Consulta general').slice(0,300),payload.appointment_type||null]);
      const [created]=await cx.query('SELECT * FROM telecus_demo_appointments WHERE code=$1',[code]);if(!free)await this.holds?.create(created,scheduleFor(await this.schedules(cx),payload.date),cx);
      await this.audit(cx,user,kind,code);
      return free?`Solicitud gratuita ${code} registrada. Queda pendiente de revisión administrativa. No debes pagar ni enviar comprobantes. Esta es una operación de prueba.`:`Pre-reserva ${code} registrada con ${doctor.full_name}, el ${payload.date} a las ${payload.time}. El pago queda pendiente. Esta es una operación de prueba.`;
    }
    if(kind==='approve_change' || kind==='reject_change') {
      if(user.role!=='ADMIN') throw new ForbiddenException('Esta acción requiere un administrativo.');
      const publicReason=kind==='reject_change'?rejectionReason(payload):null;
      const [change]=await cx.query("SELECT * FROM telecus_demo_changes WHERE id=$1 AND status='PENDING'", [payload.request_id]);
      if(!change) throw new ConflictException('La solicitud ya fue revisada o no existe.');
      const [target]=await cx.query('SELECT * FROM telecus_demo_appointments WHERE id=$1', [change.appointment_id]);
      if(!target || ['CANCELLED','COMPLETED'].includes(target.status)) throw new ConflictException('La cita ya no admite este cambio.');
      if(kind==='approve_change') {
        if(change.request_type==='CANCEL') await cx.query("UPDATE telecus_demo_appointments SET status='CANCELLED' WHERE id=$1", [target.id]);
        else {
          const start=new Date(change.requested_start_time); const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota'}).format(start); const time=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Bogota',hour:'2-digit',minute:'2-digit',hour12:false}).format(start);
          serviceDate(date,time,scheduleFor(await this.schedules(cx),date));
          const conflicts=await cx.query("SELECT id FROM telecus_demo_appointments WHERE doctor_id=$1 AND id<>$2 AND status NOT IN ('CANCELLED','COMPLETED') AND start_time<$3 AND end_time>$4",[target.doctor_id,target.id,change.requested_end_time,change.requested_start_time]);
          if(conflicts.length) throw new ConflictException('El horario solicitado está ocupado.');
          await cx.query("UPDATE telecus_demo_appointments SET status='RESCHEDULED',start_time=$1,end_time=$2 WHERE id=$3",[change.requested_start_time,change.requested_end_time,target.id]);
        }
      }
      if(publicReason)await cx.query('INSERT INTO telecus_public_rejections(request_id,category,message,actor_id,created_at) VALUES($1,$2,$3,$4,$5)',[change.id,publicReason.rejection_category,publicReason.public_reason,user.id,new Date().toISOString()]);
      await cx.query('UPDATE telecus_demo_changes SET status=$1,reviewed_by=$2 WHERE id=$3',[kind==='approve_change'?'APPROVED':'REJECTED',user.id,change.id]);
      await this.audit(cx,user,kind,change.id);
      return `Solicitud ${kind==='approve_change'?'aprobada':'rechazada'} en los datos de prueba. No se enviaron correos ni se modificó Google Calendar.`;
    }
    if(!appointment) throw new ForbiddenException('No se encontró esa cita dentro de tu acceso.');
    if(['CANCELLED','COMPLETED'].includes(appointment.status)) throw new ConflictException('La cita ya no admite cambios.');
    if(kind==='confirm_free'){
      if(user.role!=='ADMIN'||appointment.payment_status!=='NOT_REQUIRED'||appointment.status!=='PRE_RESERVED'||new Date(appointment.start_time).getTime()<=Date.now())throw new ForbiddenException('Solo administración puede aprobar una solicitud gratuita pendiente.');
      await cx.query("UPDATE telecus_demo_appointments SET status='CONFIRMED' WHERE id=$1",[appointment.id]);
    } else if(kind==='verify_payment') {
      await this.holds?.eligible(appointment.id,cx);
      if(user.role!=='ADMIN') throw new ForbiddenException('Solo un administrativo puede verificar pagos.');
      if(appointment.payment_status!=='PENDING') throw new ConflictException('El pago ya fue verificado.');
      await cx.query("UPDATE telecus_demo_appointments SET payment_status='VERIFIED',status='CONFIRMED' WHERE id=$1",[appointment.id]);
    } else if(kind==='complete') {
      if(user.role!=='DOCTOR' || appointment.doctor_id!==user.id) throw new ForbiddenException('Solo el médico asignado puede finalizar la cita.');
      if(!financiallyCleared(appointment) || !['CONFIRMED','RESCHEDULED'].includes(appointment.status) || new Date(appointment.end_time).getTime()>Date.now()) throw new ConflictException('La cita debe estar confirmada y su horario debe haber terminado.');
      await cx.query("UPDATE telecus_demo_appointments SET status='COMPLETED' WHERE id=$1",[appointment.id]);
    } else if(kind==='assign_doctor') {
      if(user.role!=='ADMIN') throw new ForbiddenException('Solo un administrativo puede asignar un médico.');
      if(!(await this.doctors(user,cx)).some(d=>d.id===payload.doctor_id)) throw new BadRequestException('Médico no disponible.');
      const conflict=await cx.query("SELECT id FROM telecus_demo_appointments WHERE doctor_id=$1 AND id<>$2 AND status NOT IN ('CANCELLED','COMPLETED') AND start_time<$3 AND end_time>$4",[payload.doctor_id,appointment.id,appointment.end_time,appointment.start_time]);
      if(conflict.length) throw new ConflictException('El médico tiene otra cita en ese horario.');
      await cx.query('UPDATE telecus_demo_appointments SET doctor_id=$1 WHERE id=$2',[payload.doctor_id,appointment.id]);
    } else if(kind==='cancel' || kind==='reschedule') {
      if(user.role==='DOCTOR') throw new ForbiddenException('El médico no puede cancelar ni reprogramar.');
      let interval: {start:string;end:string}|undefined;
      if(kind==='reschedule') {
        interval=serviceDate(payload.date,payload.time,scheduleFor(await this.schedules(cx),payload.date));
        const conflicts=await cx.query("SELECT id FROM telecus_demo_appointments WHERE doctor_id=$1 AND id<>$2 AND status NOT IN ('CANCELLED','COMPLETED') AND start_time<$3 AND end_time>$4",[appointment.doctor_id,appointment.id,interval.end,interval.start]);
        if(conflicts.length) throw new ConflictException('El horario está ocupado.');
      }
      if(user.role==='PATIENT' && financiallyCleared(appointment)) {
        const existing=await cx.query("SELECT id FROM telecus_demo_changes WHERE appointment_id=$1 AND status='PENDING'",[appointment.id]);
        if(existing.length) throw new ConflictException('Ya existe una solicitud pendiente para esta cita.');
        await cx.query('INSERT INTO telecus_demo_changes(id,appointment_id,patient_id,request_type,requested_start_time,requested_end_time,status,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),appointment.id,user.id,kind==='cancel'?'CANCEL':'RESCHEDULE',interval?.start||null,interval?.end||null,'PENDING',String(payload.reason||'Solicitud del paciente').slice(0,300)]);
        await this.audit(cx,user,kind,appointment.id);
        return 'Solicitud de cambio registrada en los datos de prueba. La cita original permanece igual hasta la aprobación administrativa.';
      }
      if(kind==='cancel') {
        await cx.query("UPDATE telecus_demo_appointments SET status='CANCELLED' WHERE id=$1",[appointment.id]);
        await cx.query("UPDATE telecus_demo_changes SET status=CASE WHEN request_type='CANCEL' THEN 'APPROVED' ELSE 'REJECTED' END,reviewed_by=$1 WHERE appointment_id=$2 AND status='PENDING'",[user.id,appointment.id]);
      }
      else await cx.query("UPDATE telecus_demo_appointments SET status='RESCHEDULED',start_time=$1,end_time=$2 WHERE id=$3",[interval!.start,interval!.end,appointment.id]);
    } else throw new BadRequestException('Operación desconocida.');
    await this.audit(cx,user,kind,appointment.id);
    return 'Operación completada en los datos de prueba. No se modificó Calendar ni se enviaron correos reales.';
  }
  private audit(cx: Connection,user:Profile,operation:string,target:string) { return cx.query('INSERT INTO telecus_audit(id,owner_id,operation,target_id,created_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),user.id,operation,target,new Date().toISOString()]); }
}
