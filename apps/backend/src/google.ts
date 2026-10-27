import { createHash } from 'node:crypto';
import type { GoogleAppointment,GoogleTask,GooglePort } from './ports/integrations.js';
export type { GoogleAppointment,GoogleTask } from './ports/integrations.js';
export const eventId=(id:string)=>'telecus'+createHash('sha256').update(id).digest('hex').slice(0,40);
function email(value:string){if(!/^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(value))throw Error('Correo de perfil inválido.');return value;}
export function calendarEvent(appointment:GoogleAppointment){
  if(!appointment.id||!appointment.code||!Number.isFinite(Date.parse(appointment.start_time))||Date.parse(appointment.end_time)-Date.parse(appointment.start_time)!==1800000)throw Error('Intervalo de cita inválido.');
  return {id:appointment.calendar_event_id||eventId(appointment.id),summary:appointment.code.startsWith('TCUS-TEST-')?'PRUEBA TeleCUS - Integración':'TeleCUS - Teleconsulta de medicina general',description:'Código de cita: '+appointment.code,
    start:{dateTime:appointment.start_time,timeZone:'America/Bogota'},end:{dateTime:appointment.end_time,timeZone:'America/Bogota'},
    attendees:[...new Set([email(appointment.patient_email),email(appointment.doctor_email)])].map(email=>({email})),visibility:'private',guestsCanInviteOthers:false,guestsCanModify:false,
    extendedProperties:{private:{telecus_id:appointment.id}},conferenceData:{createRequest:{requestId:eventId(appointment.id)+'meet',conferenceSolutionKey:{type:'hangoutsMeet'}}}};
}
export function notification(task:GoogleTask){
  const a=task.appointment;const subjects={confirm:'Cita confirmada',reschedule:'Cita reprogramada',cancel:'Cita cancelada',complete:'Consulta finalizada',assign_doctor:'Cambio de médico'};
  const recipients=[...new Set(task.operation==='complete'||task.operation==='confirm'?[email(a.patient_email)]:[email(a.patient_email),email(a.doctor_email),...(task.operation==='assign_doctor'&&a.previous_doctor_email?[email(a.previous_doctor_email)]:[])])];
  const when=new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',dateStyle:'long',timeStyle:'short',hour12:true}).format(new Date(a.start_time));
  const lines=['TeleCUS - '+subjects[task.operation],'Código: '+a.code,...(['cancel','complete'].includes(task.operation)?[]:['Fecha y hora: '+when]),...(a.meet_url&& !['cancel','complete'].includes(task.operation)?['Videollamada: '+a.meet_url]:[]),'Centro Universitario de Salud Alfonso López'];
  return {to:recipients,subject:(a.code.startsWith('TCUS-TEST-')?'PRUEBA TeleCUS - ':'TeleCUS - ')+subjects[task.operation],text:lines.join('\n')};
}
export class GoogleGateway implements GooglePort{
  constructor(private credentials:{clientId:string;clientSecret:string;refreshToken:string;calendarId:string;sender:string},private transport:typeof fetch=fetch){}
  private async token(){const r=await this.transport('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.credentials.clientId,client_secret:this.credentials.clientSecret,refresh_token:this.credentials.refreshToken,grant_type:'refresh_token'}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Es necesario renovar la conexión de Google.');const data=await r.json() as any;return data.access_token;}
  private async call(token:string,url:string,method='GET',body?:any,etag?:string){return this.transport(url,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{}),...(etag?{'If-Match':etag}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});}
  async calendar(task:GoogleTask){
    const a=task.appointment,base='https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(this.credentials.calendarId)+'/events',id=a.calendar_event_id||eventId(a.id),token=await this.token();
    if(task.operation==='complete')return {};
    if(task.operation==='cancel'){const r=await this.call(token,base+'/'+encodeURIComponent(id)+'?sendUpdates=all','DELETE');if(![200,204,404,410].includes(r.status))throw Error('No fue posible cancelar el evento de Google.');return {calendar_event_id:id};}
    let result:any;
    if(task.operation==='confirm'){
      const r=await this.call(token,base+'?conferenceDataVersion=1&sendUpdates=all','POST',calendarEvent(a));
      if(r.status===409){const existing=await this.call(token,base+'/'+encodeURIComponent(id));if(!existing.ok)throw Error('No fue posible recuperar el evento ya creado.');result=await existing.json();if(result.extendedProperties?.private?.telecus_id!==a.id||result.status==='cancelled')throw Error('El evento existente no corresponde a esta cita.');}
      else{if(!r.ok)throw Error('No fue posible crear la cita en Google Calendar.');result=await r.json();}
    }else{
      const current=await this.call(token,base+'/'+encodeURIComponent(id));if(!current.ok)throw Error('No se encontró el evento asociado a la cita.');const existing=await current.json() as any;
      // Existing n8n events do not have telecus_id; the ID must come from the authenticated repository.
      if(existing.extendedProperties?.private?.telecus_id&&existing.extendedProperties.private.telecus_id!==a.id)throw Error('El evento no corresponde a esta cita.');
      if(existing.extendedProperties?.private?.telecus_delivery_id===task.delivery_id){
        const matches=task.operation==='assign_doctor'?[a.patient_email,a.doctor_email].every(e=>existing.attendees?.some((g:any)=>g.email===e)):
          Date.parse(existing.start?.dateTime)===Date.parse(a.start_time)&&Date.parse(existing.end?.dateTime)===Date.parse(a.end_time);
        if(!matches)throw Error('El evento cambió después de sincronizarse. Requiere revisión.');
        result=existing;
      }
      else{
        const change={...(task.operation==='assign_doctor'?{attendees:calendarEvent(a).attendees}:{start:{dateTime:a.start_time,timeZone:'America/Bogota'},end:{dateTime:a.end_time,timeZone:'America/Bogota'}}),extendedProperties:{private:{...existing.extendedProperties?.private,telecus_id:a.id,telecus_delivery_id:task.delivery_id}}};
        const r=await this.call(token,base+'/'+encodeURIComponent(id)+'?conferenceDataVersion=1&sendUpdates=all','PATCH',change,existing.etag);if(!r.ok)throw Error('No fue posible actualizar Google Calendar.');result=await r.json();
      }
    }
    if(task.operation==='confirm'){
      for(let attempt=0;result.conferenceData?.createRequest?.status?.statusCode==='pending'&&attempt<5;attempt++){await new Promise(r=>setTimeout(r,1000));const r=await this.call(token,base+'/'+encodeURIComponent(id));if(!r.ok)break;result=await r.json();}
      if(!result.hangoutLink&&!result.conferenceData?.entryPoints?.some((e:any)=>e.entryPointType==='video'))throw Error('El evento existe pero Meet no está disponible. Debe recuperarse antes de confirmar en la base de datos.');
    }
    return {calendar_event_id:result.id||id,meet_url:result.hangoutLink||result.conferenceData?.entryPoints?.find((e:any)=>e.entryPointType==='video')?.uri||a.meet_url||''};
  }
  async sendNotification(task:GoogleTask){
    const token=await this.token(),n=notification(task);
    const subject='=?UTF-8?B?'+Buffer.from(n.subject).toString('base64')+'?=';
    const mime=['From: TeleCUS <'+email(this.credentials.sender)+'>','To: '+n.to.join(', '),'Subject: '+subject,'Message-ID: <'+createHash('sha256').update(task.delivery_id).digest('hex')+'@telecus.local>','MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',Buffer.from(n.text).toString('base64').match(/.{1,76}/g)!.join('\r\n')].join('\r\n');
    const r=await this.call(token,'https://gmail.googleapis.com/gmail/v1/users/me/messages/send','POST',{raw:Buffer.from(mime).toString('base64url')});
    if(!r.ok)throw Error('No fue posible enviar el correo. Una respuesta ambigua requiere revisión antes de reenviarlo.');return await r.json();
  }
}
