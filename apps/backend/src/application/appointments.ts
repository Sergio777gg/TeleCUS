import { BadRequestException } from '@nestjs/common';
import {visitType} from './visit-policy.js';
import {DEFAULT_SCHEDULE,scheduleTimes,validServiceDay,dayNames,type ServiceSchedule} from './service-schedule.js';
export const pilotTimes = ['14:00','14:30','15:00','15:30'];
export const timeLabel = (time:string)=>`${Number(time.slice(0,2))%12||12}:${time.slice(3)} ${Number(time.slice(0,2))<12?'a':'p'}. m.`;
const dateLabel=(value:string)=>new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',dateStyle:'medium',timeStyle:'short',hour12:true}).format(new Date(value));
export function changeSummary(c:any,showReference=true,role='PATIENT'){
  const statuses:Record<string,string>={PENDING:'Pendiente de revisión administrativa',APPROVED:'Aprobada',REJECTED:'Rechazada'};
  return `${c.request_type==='RESCHEDULE'?'Reprogramación':'Cancelación'} · ${c.appointment_code||'Cita no disponible'}${c.doctor_name?' · '+c.doctor_name:''}\nEstado de la solicitud: ${statuses[c.status]||c.status}${c.status!=='PENDING'?' · Ya revisada':''}${c.created_at?'\nSolicitada el: '+dateLabel(c.created_at):''}${c.current_start_time?'\nHorario registrado de la cita (actual): '+dateLabel(c.current_start_time):''}${c.requested_start_time?'\nHorario solicitado: '+dateLabel(c.requested_start_time):''}${c.status==='PENDING'?'\n'+(role==='ADMIN'?'La cita':'Tu cita')+' conserva su estado actual mientras se revisa y completa la solicitud.':c.status==='REJECTED'?'\nEsta solicitud no se aplicó. Consulta el estado actual de la cita para ver si hubo otra gestión.':''}${showReference?'\nReferencia: '+c.id:''}`;
}
export function appointmentSummary(a: any, doctors: any[] = []) {
  const doctor = a.doctor_name || doctors.find(d => d.id === a.doctor_id)?.full_name || 'Médico asignado';
  const when = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'short', hour12: true }).format(new Date(a.start_time));
  const statuses:Record<string,string>={PRE_RESERVED:'Pre-reserva',CONFIRMED:'Confirmada',RESCHEDULED:'Reprogramada',CANCELLED:'Cancelada',COMPLETED:'Finalizada'};
  const payments:Record<string,string>={PENDING:'Pendiente',VERIFIED:'Verificado',NOT_REQUIRED:'No requerido por piloto'};
  const past=new Date(a.end_time).getTime()<=Date.now()&&!['CANCELLED','COMPLETED'].includes(a.status);
  return `${a.code} · ${doctor}${visitType(a.appointment_type)?'\nTipo: '+visitType(a.appointment_type)!.label:''}\n${when}\nEstado: ${a.status==='PRE_RESERVED'&&a.payment_status==='NOT_REQUIRED'?'Solicitud gratuita pendiente de revisión':statuses[a.status]||a.status} · Pago: ${payments[a.payment_status]||a.payment_status}${past?'\nHorario pasado · pendiente de revisión y cierre.':''}${a.meet_url ? `\nVideollamada: ${a.meet_url}` : ''}`;
}
export function serviceDate(date: string, time: string,policy:ServiceSchedule=DEFAULT_SCHEDULE) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new BadRequestException('Indica fecha y hora válidas.');
  const start = new Date(`${date}T${time}:00-05:00`);
  const localDate=Number.isFinite(start.getTime())?new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota'}).format(start):null;
  if (!Number.isFinite(start.getTime()) || localDate !== date || !validServiceDay(date,policy) || !scheduleTimes(policy).includes(time)) throw new BadRequestException(`El servicio atiende ${dayNames(policy)}, de ${timeLabel(policy.start)} a ${timeLabel(policy.end)}, en espacios de 30 minutos.`);
  if (start.getTime() <= Date.now()) throw new BadRequestException('Elige una fecha y hora futuras.');
  return { start: start.toISOString(), end: new Date(start.getTime()+30*60000).toISOString() };
}
