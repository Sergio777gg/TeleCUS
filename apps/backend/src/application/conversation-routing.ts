import {normalizeText,calendarAnswer} from '../calendar.js';
import {timeExpression} from './time-expression.js';
import type {Intent} from '../types.js';
type Context={role?:string;draft?:any;today?:string;dialogue?:{expectedSlot?:string|null;requestedWeekday?:number|null}};
/** Distinguish capability, lookup and field repair before interpreting domain entities. */
export function conversationRoute(message:string,context:Context):Partial<Intent>|null{
 const text=normalizeText(message).replace(/^(?:hola|buenas|buenos dias|buenas tardes)[,;! ]+/,''),asking=/[?¿]/.test(message)||/^(?:puedo|es posible|se puede|que|cual|cuando|donde|en que|como)\b/.test(text);
 const reschedule=/\b(?:re ?agend[a-z]*|reprogram[a-z]*|cambiar (?:la |mi |una )?cita)\b/.test(text),cancel=/\bcancel[a-z]*\b/.test(text);
 if(/\b(?:citas|agenda)\b/.test(text)&&/\b(?:historial|anteriores|canceladas|finalizadas|todas)\b/.test(text)&&!/^(?:no|nunca)\b/.test(text))return {intent:'list_appointments',appointment_view:/\btodas\b/.test(text)?'all':'history'};
 if(/^(?:no (?:voy a )?(?:poder|puedo|podre)|se me (?:complica|dificulta)|me resulta imposible) (?:asistir|ir|acudir|atender)\b/.test(text)&&!reschedule&&!cancel)return {intent:'change_options',inquiry:'attendance'};
 if(asking&&(reschedule||cancel)&&/\b(?:puedo|posible|puede|podria|como)\b/.test(text))return {intent:reschedule?'reschedule':'cancel',inquiry:'capability'};
 if(/\b(?:pagar|pago|comprobante)\b/.test(text)&&/\b(?:donde|como|enlace|link|portal)\b/.test(text)&&!cancel&&!reschedule&&!/\b(?:verifica[a-z]*|valida[a-z]*|recaudo|concili[a-z]*)\b/.test(text))return {intent:'payment_status',inquiry:'payment'};
 if(/\b(?:mi cita|mis citas)\b/.test(text)&&/\b(?:cuando|hora|estado|asignad|vigente|confirmad)\w*\b/.test(text)&&!cancel&&!reschedule)return {intent:'list_appointments',appointment_view:'current'};
 if(/\b(?:disponibilidad|horarios?|cupos?|turnos?)\b/.test(text)&&asking&&!/\b(?:significa|equivale|formato|para que|por que)\b/.test(text))return {intent:'availability',inquiry:'availability'};
 const task=context.draft?.intent;
 if(!['reserve','reschedule','availability'].includes(task))return null;
 if(context.dialogue?.expectedSlot==='reason'&&!asking){const direct=text.match(/^(?:el motivo (?:es|seria) )?(consulta general|consulta de seguimiento)$/);if(direct)return {intent:task,reason:message.trim().slice(message.toLowerCase().lastIndexOf(direct[1])),dialogue_act:'answer',dialogue_target:'reason'};}
 const fields=[['time',/\bhor[ao]\b/],['date',/\b(?:fecha|dia)\b/],['doctor',/\b(?:medico|doctor)\b/]] as const;
 if(!asking&&!/^no (?:quiero )?(?:cambiar|corregir|rectificar|modificar)\b/.test(text))for(const [slot,subject]of fields)if(subject.test(text)&&(/\b(?:cambiar|corregir|rectificar|modificar)\b/.test(text)||/\bno era\b/.test(text)))return {intent:task,dialogue_act:'correct',dialogue_target:slot,reset_slot:slot};
 const contrast=text.match(/^(?:quiero |prefiero |mejor )?(.+?)[,;]?\s+no\s+(?:a (?:las? )?)?(.+)$/);
 if(!asking&&contrast&&timeExpression(contrast[2])){
  const requested=contrast[1].replace(/,$/,''),parts=requested.match(/^(.+?)\s+a las?\s+(.+)$/),time=timeExpression(parts?.[2]||requested),date=parts?calendarAnswer(parts[1],context.today,context.dialogue?.requestedWeekday):null;
  if(time&&(!parts||date))return {intent:task,time,date,dialogue_act:'correct',dialogue_target:'time'};
 }
 return null;
}
