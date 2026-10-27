import type {Appointment,ChangeDetails,PendingDelivery} from '../ports/application.js';
import type {Selection} from '../conversation.js';

/** Read-only result + current record + next steps. No cached notification is a source of agenda state. */
export function focusedPatientRequest(records:ChangeDetails[],current:Appointment[],options:{id?:string;code?:string}={}):ChangeDetails|undefined{
 if(options.id)return records.find(r=>r.id===options.id&&(!options.code||r.appointment_code===options.code));
 const relevant=options.code?records.filter(r=>r.appointment_code===options.code):records.filter(r=>current.some(a=>a.id===r.appointment_id));
 const candidates=relevant.length?relevant:options.code?[]:records;
 const pending=candidates.filter(r=>r.status==='PENDING'),pool=pending.length?pending:candidates;
 if(pool.length===1)return pool[0];
 // Legacy rows without timestamps need an explicit choice instead of an invented recency.
 const dated=pool.filter(r=>r.created_at&&Number.isFinite(Date.parse(r.created_at)));
 return dated.sort((a,b)=>Date.parse(b.created_at!)-Date.parse(a.created_at!)||b.id.localeCompare(a.id))[0];
}

export function patientRequestFollowUp(request:ChangeDetails,appointment:Appointment|undefined,records:ChangeDetails[],current:Appointment[],deliveries:PendingDelivery[],now=Date.now()){
 const change=request.request_type==='RESCHEDULE'?'reprogramación':'cancelación',code=request.appointment_code||appointment?.code||'tu cita';
 const result=(request.status==='REJECTED'?`Tu solicitud de ${change} de ${code} no fue aprobada en la revisión administrativa. Esa decisión no modificó tu cita.`:request.status==='APPROVED'?`Tu solicitud de ${change} de ${code} fue aprobada.`:`Tu solicitud de ${change} de ${code} está pendiente de revisión administrativa. Te avisaremos en Notificaciones cuando haya una decisión.`)+(request.status==='REJECTED'&&request.public_reason?'\nMotivo comunicado por administración: '+request.public_reason:'');
 const choices:Selection['choices']=[],view=(a:Appointment)=>({label:'Ver mi cita',intent:'select_appointment' as const,appointment_code:a.code});
 const history='Puedes consultar «Ver historial de solicitudes» para ver las gestiones anteriores.';
 if(!appointment)return {text:result+'\n\nNo pude comprobar el estado actual de esa cita. Consulta «Ver mis citas» antes de iniciar otra gestión.\n\n'+history,choices:[{label:'Ver mis citas',intent:'list_appointments' as const}]};
 const date=new Date(appointment.start_time),when=Number.isFinite(date.getTime())?new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',weekday:'long',day:'numeric',month:'long',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true}).format(date):null;
 const active=!['CANCELLED','COMPLETED'].includes(appointment.status),other=current.find(a=>a.id!==appointment.id&&!['CANCELLED','COMPLETED'].includes(a.status));
 const status=({PRE_RESERVED:'Pre-reserva',CONFIRMED:'Confirmada',RESCHEDULED:'Reprogramada',CANCELLED:'Cancelada',COMPLETED:'Finalizada'} as Record<string,string>)[appointment.status]||appointment.status;
 let text=result+`\n\nEstado actual de ${appointment.code}: ${status}.`+(active&&when?'\nHorario actual: '+when:'');
 if(request.status==='PENDING'&&request.request_type==='RESCHEDULE'&&request.requested_start_time&&Number.isFinite(Date.parse(request.requested_start_time)))text+='\nHorario solicitado: '+new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',dateStyle:'long',timeStyle:'short',hour12:true}).format(new Date(request.requested_start_time));
 const pending=records.filter(r=>r.appointment_id===appointment.id&&r.status==='PENDING').sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||''))[0];
 if(!active){
  if(other){text+='\nActualmente tienes otra cita vigente; puedes consultar sus datos.';choices.push(view(other));}
  else{text+='\nSi necesitas otra atención, puedes solicitar una nueva cita.';choices.push({label:'Solicitar una cita',intent:'reserve'},view(appointment));}
 }else if(deliveries.some(d=>d.code===appointment.code&&d.status!=='done')){
  text+='\nHay una gestión de esta cita en proceso. Espera su resultado antes de enviar otra solicitud; te avisaremos en Notificaciones.';choices.push(view(appointment));
 }else if(pending){
  if(pending.id!==request.id){text+='\nHay una solicitud posterior pendiente de revisión. Consúltala antes de iniciar otra.';choices.push({label:'Ver solicitud pendiente',intent:'select_request',request_id:pending.id});}
  choices.push(view(appointment));
 }else if(!when||!Number.isFinite(Date.parse(appointment.start_time))||Date.parse(appointment.start_time)<=now){
  text+='\nEl horario ya pasó o necesita revisión. El equipo de TeleCUS debe comprobar la atención antes de gestionar otro cambio.';choices.push(view(appointment));
 }else{
  text+='\nSi ese horario no te sirve, podemos buscar otro o solicitar la cancelación. También puedes conservar tu cita actual.';
  choices.push({label:'Buscar otro horario',intent:'reschedule',appointment_code:appointment.code},{label:'Solicitar cancelación',intent:'cancel',appointment_code:appointment.code},view(appointment));
 }
 return {text:text+'\n\n'+history,choices};
}
