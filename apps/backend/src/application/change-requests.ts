import type { ChangeDetails } from '../ports/application.js';
import type { Intent, Role } from '../types.js';
import { changeSummary } from './appointments.js';

export function requestView(intent:Intent,role:Role,targeted=false):'pending'|'reviewed'|'all'{
  return targeted?'all':intent.request_view||(intent.intent==='pending_requests'?'pending':role==='ADMIN'?'pending':'all');
}
export function requestList(records:ChangeDetails[],intent:Intent,role:Role,targeted=false){
  const view=requestView(intent,role,targeted);
  const filtered=records.filter(c=>(!intent.request_type||c.request_type===intent.request_type)&&(!intent.request_state||c.status===intent.request_state)&&(view==='all'||(view==='pending'?c.status==='PENDING':c.status!=='PENDING')));
  const newest=(a:ChangeDetails,b:ChangeDetails)=>(b.created_at||'').localeCompare(a.created_at||'');
  const pending=filtered.filter(c=>c.status==='PENDING').sort(newest),reviewed=filtered.filter(c=>c.status!=='PENDING').sort(newest);
  const shown=[...pending,...reviewed].slice(0,20);
  let index=0;
  const section=(title:string,items:ChangeDetails[])=>items.length?title+'\n\n'+items.map(c=>`${++index}. ${changeSummary(c,role==='ADMIN',role)}`).join('\n\n'):'';
  const text=[section('Pendientes de revisión administrativa',shown.filter(c=>c.status==='PENDING')),section('Historial · solicitudes ya revisadas',shown.filter(c=>c.status!=='PENDING'))].filter(Boolean).join('\n\n');
  const empty=targeted?'No se encontró esa solicitud dentro de tu acceso.':view==='pending'?'Por ahora no hay solicitudes de cambio pendientes'+(intent.request_type==='CANCEL'?' de cancelación':intent.request_type==='RESCHEDULE'?' de reprogramación':'')+'.':view==='reviewed'?'No hay solicitudes revisadas que coincidan con esta consulta.':'Aún no hay solicitudes de cambio registradas dentro de tu acceso.';
  const guidance=role==='ADMIN'?(pending.length?'Puedes elegir una pendiente por su número y pedir «Aprobar» o «Rechazar». Revisaremos los datos antes de confirmar.\n':'')+'Para consultar gestiones anteriores, escribe «Ver historial de solicitudes».':(pending.length?'Te avisaremos en Notificaciones cuando se revise tu solicitud. Puedes elegir su número para consultar los detalles.':'Puedes consultar tu cita actual en «Ver mis citas».')+'\nPuedes escribir «Ver solicitudes pendientes» o «Ver historial de solicitudes» para ver cada grupo por separado.';
  return {shown,view,text:(text||empty)+'\n\n'+guidance+(filtered.length>20?'\nSe muestran hasta 20 solicitudes. Puedes acotar por tipo o estado.':'')};
}
