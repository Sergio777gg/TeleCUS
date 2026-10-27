import { Intent, Role } from './types.js';
import { calendarAnswer, normalizeText } from './calendar.js';
import {visitTypeAnswer} from './application/visit-policy.js';
import {conversationRoute} from './application/conversation-routing.js';
import type { DialogueGrounding,ExpectedSlot } from './application/dialogue-state.js';
import { timeExpression } from './application/time-expression.js';
import { stepQuestion } from './application/step-help.js';
import { declinesSupport,supportSignal } from './application/support-policy.js';
import { fieldRefusal } from './application/dialogue-policy.js';
import { bareControl,controlUtterance,dismissEvidence,hasControlSignal,informationQuestion,negatedControl,pureNegation,questionEvidence,referencedTime,timeExplanationReference,undecidedAnswer } from './application/language-signals.js';

type Choice = { label:string; intent:Intent['intent']; doctor_name?:string;request_id?:string;appointment_code?:string;appointment_type?:string;date?:string;time?:string;inquiry?:Intent['inquiry'] };
export type Selection = { type:'menu'|'change'|'doctor'|'requests'|'appointments'|'appointment_types'|'dates'|'slots'|'next_steps'; choices:Choice[] };
export type ConversationContext = { menu?:Selection; references?:{type:'requests'|'appointments';ids:string[];at:string}; focusedRequestId?:string;focusedAppointmentCode?:string;unresolvedCount?:number;supportOffers?:number;lastOperation?:{kind:string;appointment_code?:string;request_id?:string} };
export type Grounding = {draft?:any;awaiting?:ExpectedSlot|null;role?:Role;selection?:Selection|null;today?:string;context?:ConversationContext;dialogue?:DialogueGrounding;service?:import('./application/service-schedule.js').ServiceSchedule&{policies?:import('./application/service-schedule.js').ServiceSchedule[]}};
export const roleChoices:Record<Role,Choice[]> = {
  PATIENT:[{label:'Solicitar una cita',intent:'reserve'},{label:'Consultar disponibilidad',intent:'availability'},{label:'Ver mis citas y pago',intent:'list_appointments'},{label:'Reprogramar o cancelar',intent:'change_options'},{label:'Información de TeleCUS',intent:'knowledge'}],
  ADMIN:[{label:'Ver las citas',intent:'list_appointments'},{label:'Ver pagos pendientes',intent:'pending_payments'},{label:'Ver solicitudes de cambio',intent:'pending_requests'},{label:'Verificar un pago',intent:'verify_payment'},{label:'Reprogramar o cancelar',intent:'change_options'}],
  DOCTOR:[{label:'Ver mis citas',intent:'list_appointments'},{label:'Obtener el enlace de videollamada',intent:'list_appointments'},{label:'Registrar una cita finalizada',intent:'complete'}]
};
export const changeChoices:Choice[]=[{label:'Reprogramar una cita',intent:'reschedule'},{label:'Cancelar una cita',intent:'cancel'}];
export const numbered = (choices:Choice[])=>choices.map((c,i)=>`${i+1}. ${c.label}`).join('\n');
export const emptyIntent = (intent:Intent['intent'],fields:Partial<Intent>={}):Intent=>({intent,appointment_code:null,doctor_name:null,date:null,time:null,reason:null,request_id:null,...fields});

/** A time-only answer supplies time, never a date. Bare 2:30 means the pilot's afternoon. */
export function pilotTimeAnswer(text:string):string|null {
  return timeExpression(text);
}

/** A bounded affirmative task grammar precedes social/model labels; questions and negations do not. */
function schedulingRequest(message:string,context:Grounding):Intent|null {
  const text=normalizeText(message).replace(/^(?:hola|buenos dias|buenas tardes|buenas noches|buenas|saludos)[,;:! .]+/,'').replace(/^por favor[, ]+/,'').replace(/[, ]+por favor$/,'').replace(/^(quiero|quisiera|necesito|deseo|me gustaria) una cita\b/,'$1 solicitar una cita');
  const match=text.match(/^(?:(?:yo )?(?:quiero|quisiera|necesito|deseo|me gustaria)\s+)?(solicitar|agendar|reservar|pedir|programar|reprogramar|cambiar|cancelar) (?:una |mi |la )?cita(?:\s+(.+))?$/);
  if(!match||/[?¿]/.test(message))return null;
  const kind=match[1]==='cancelar'?'cancel':['reprogramar','cambiar'].includes(match[1])?'reschedule':'reserve';
  const act=context.draft?.intent===kind?'answer' as const:'new_task' as const;
  if(!match[2])return emptyIntent(kind,{dialogue_act:act});
  if(kind==='cancel'){const code=match[2].match(/^(?:de )?(TCUS-[A-Z0-9]+-[A-Z0-9]+)$/i);return code?emptyIntent(kind,{appointment_code:code[1].toUpperCase(),dialogue_act:act}):null;}
  const expression=match[2].replace(/^(?:para|el dia|para el dia)\s+/,'');
  const parts=expression.match(/^(.+?)\s+(?:a las?|para las?)\s+(.+)$/);
  const date=calendarAnswer(parts?.[1]||expression,context.today,context.dialogue?.requestedWeekday),time=parts?pilotTimeAnswer(parts[2]):null;
  // Leave other modifiers (doctor, motive...) to semantic extraction instead of dropping them.
  if(!date||parts&&!time)return null;
  return emptyIntent(kind,{date,time,dialogue_act:act});
}

/** Resolve exact UI commands using server session state, never a global number-to-action map. */
export function resolveConversation(message:string,context:Grounding):Intent|null {
  const text=normalizeText(message);
  if(supportSignal(message))return emptyIntent('support');
  const dayCommand=message.match(/^Ver horarios para (\d{4}-\d{2}-\d{2})$/);if(dayCommand)return emptyIntent('availability',{inquiry:'availability',date:dayCommand[1]});
  const route=conversationRoute(message,context);if(route)return emptyIntent(route.intent||'unknown',route);
  if(context.selection?.type==='next_steps'){
    const choice=/^\d+$/.test(text)?context.selection.choices[Number(text)-1]:context.selection.choices.find(c=>normalizeText(c.label)===text);
    if(choice)return {...choiceIntent(choice),dialogue_act:['reserve','reschedule','cancel'].includes(choice.intent)?'new_task':'answer'};
  }
  if(context.draft&&undecidedAnswer(message))return emptyIntent('unknown',{dialogue_act:'clarify',dialogue_target:context.dialogue?.expectedSlot==='confirmation'?'task':context.dialogue?.expectedSlot||null});
  const type=visitTypeAnswer(message,context.selection?.type==='appointment_types');
  if(type&&(!/^\d+$/.test(text)||!context.selection||context.selection.type==='appointment_types')&&(!context.draft||context.selection?.type==='appointment_types'||/^Tipo de cita:/.test(message)))return emptyIntent('reserve',{appointment_type:type,dialogue_act:context.draft?.intent==='reserve'?'answer':'new_task'});
  const task=schedulingRequest(message,context);if(task)return task;
  if(context.role==='ADMIN'&&/^(?:quiero )?(?:verificar|confirmar|confirmo) (?:el )?pago(?: de)?(?: TCUS-[A-Z0-9-]+)?$/i.test(message.trim()))return emptyIntent('verify_payment');
  const explanation=timeExplanationReference(message,context.dialogue?.expectedSlot||context.awaiting);
  if(explanation)return emptyIntent('unknown',{dialogue_act:'ask',dialogue_target:'time',reference_time:explanation});
  if(context.dialogue?.expectedSlot==='confirmation'&&pureNegation(message))return emptyIntent('deny',{dialogue_act:'refuse',dialogue_target:'task'});
  if(/^(?:hola|buenos dias|buenas tardes|buenas noches|buenas|saludos)(?:[, ]+(?:telecus|asistente))?$/.test(text))return emptyIntent('greeting');
  const requests=requestQuery(message,context.role);if(requests)return requests;
  const step=stepQuestion(message,context);if(step)return emptyIntent('unknown',{dialogue_act:'ask',dialogue_target:step==='confirmation'?'task':step});
  const operational=operationalQuery(message,context.role);if(operational)return emptyIntent(operational);
  const correction=selectionCorrection(text,context);if(correction)return correction;
  const named=namedChoice(message,context.selection);if(named)return named;
  if(/^\d+$/.test(text) && context.selection){
    const choice=context.selection.choices[Number(text)-1];
    return choice?choiceIntent(choice):emptyIntent('unknown');
  }
  const request=text.replace(/^por favor[, ]+/,'').replace(/^(?:yo )?(?:quiero|quisiera|necesito|deseo|me gustaria)\s+/,'').replace(/[, ]+por favor$/,'');
  if(/^(?:solicitar|agendar|reservar|pedir|programar) (?:una |mi |la )?cita$/.test(request))return emptyIntent('reserve');
  if(/^(?:consultar|ver) (?:la )?disponibilidad$/.test(request))return emptyIntent('availability');
  if(/^(?:reprogramar|cambiar) (?:una |mi |la )?cita$/.test(request))return emptyIntent('reschedule');
  if(/^cancelar (?:una |mi |la )?cita$/.test(request))return emptyIntent('cancel');
  if(/^reprogramar o cancelar(?: (?:una |mi |la )?cita)?$/.test(request))return emptyIntent('change_options');
  if(/^(?:ver (?:mis|las) citas(?: y pago)?|obtener el enlace de (?:mi cita|videollamada))$/.test(request))return emptyIntent('list_appointments');
  if(request==='ver pagos pendientes')return emptyIntent('pending_payments');
  if(request==='ver solicitudes de cambio')return emptyIntent('pending_requests');
  if(request==='verificar un pago')return emptyIntent('verify_payment');
  if(request==='registrar una cita finalizada')return emptyIntent('complete');
  if(request==='informacion de telecus')return emptyIntent('knowledge');
  if(/^(?:ver (?:las )?opciones|menu)$/.test(request))return emptyIntent('menu');
  if(personalRequestQuery(text))return emptyIntent('request_status');
  if(context.draft&&bareControl(message))return emptyIntent('deny',{dialogue_act:'refuse',dialogue_target:'task'});
  if(!/[?¿]/.test(message)&&['reserve','availability','reschedule'].includes(context.draft?.intent)){
    const correction=/^(?:mejor|prefiero|cambio a|quise decir)\s+/.test(text);
    const answer=text.replace(/^(?:mejor|prefiero|cambio a|quise decir)\s+/,'');
    const weekday=context.dialogue?.expectedSlot==='date'?context.dialogue.requestedWeekday:null;
    const act=correction?'correct' as const:'answer' as const;
    const combined=answer.match(/^(.+?)\s*,?\s+(?:a|para)\s+(?:(?:eso de|alrededor de)\s+)?las?\s+(.+)$/);
    if(combined){const day=/^(domingo|lunes|martes|miercoles|jueves|viernes|sabado)$/.test(combined[1])?'el '+combined[1]:combined[1];const date=calendarAnswer(day,context.today,weekday),time=pilotTimeAnswer(combined[2]);if(date&&time)return emptyIntent(context.draft.intent,{date,time,dialogue_act:act});}
    const time=pilotTimeAnswer(answer);
    if(time)return emptyIntent(context.draft.intent,{time,dialogue_act:act});
    const date=calendarAnswer(answer,context.today,weekday);if(date)return emptyIntent(context.draft.intent,{date,dialogue_act:act});
    if(context.dialogue?.expectedSlot&&/^(?:el otro|la otra|ese|esa|lo mismo|el mismo|la misma)$/.test(answer))return emptyIntent('unknown',{dialogue_act:'clarify'});
    if(/^(?:con )?(?:el )?mismo medico$/.test(answer)&&context.dialogue?.known.doctor_name)return emptyIntent(context.draft.intent,{doctor_name:context.dialogue.known.doctor_name,dialogue_act:act});
  }
  return null;
}

/** Queries about existing records bypass the document RAG. Procedure questions still use it. */
export function operationalQuery(message:string,role?:Role):Intent['intent']|null{
  const requests=requestQuery(message,role);if(requests)return requests.intent;
  const text=normalizeText(message);
  const lookup=/\b(?:hay|ver|consultar|revisar|mostrar|muestra|listar|cuales|cuantos|cuantas|faltan|pendientes|estado|paso|sucedio)\b/.test(text);
  if(!lookup||/^(?:como|que debo|que se necesita|por que)\b/.test(text))return null;
  if(role==='ADMIN'&&/\bpagos?\b/.test(text)&&/\b(?:pendientes?|confirmar|verificar|validar|confirmacion|verificacion)\b/.test(text))return 'pending_payments';
  if(role==='ADMIN'&&/\bcitas?\b/.test(text)&&/\b(?:por confirmar|pendientes? de confirmacion|nuevas? .*confirmar)\b/.test(text))return 'pending_payments';
  if(/\b(?:mi|mis)\b/.test(text)&&/\bcitas?\b/.test(text)&&/\b(?:estado|paso|sucedio|situacion)\b/.test(text))return 'list_appointments';
  return null;
}

/** Separate record queries from procedures and mutations; filters never confer permissions. */
export function requestQuery(message:string,role?:Role):Intent|null{
  const text=normalizeText(message);
  if(!/\b(?:solicitud|solicitudes)\b/.test(text)||/^(?:como|que debo|que se necesita|por que)\b/.test(text))return null;
  if(/\b(?:aprueba|aprobar|acepta|aceptar|rechaza|rechazar|confirmo|confirma|confirmar)\b/.test(text)&&! /\b(?:por|sin) (?:aprobar|aceptar|rechazar|confirmar)\b/.test(text))return null;
  if(!/\b(?:hay|ver|consultar|revisar|mostrar|muestra|listar|cuales|cuantos|cuantas|estado|situacion|seguimiento|paso|sucedio|historial|pendientes|nuevas|revisadas)\b/.test(text))return null;
  const cancel=/\bcancelaci(?:on|ones)\b/.test(text),reschedule=/\b(?:reprogramaci(?:on|ones)|reagendamiento)\b/.test(text);
  const pending=/\b(?:pendientes?|nuevas?|sin (?:revisar|atender|confirmar)|por (?:revisar|confirmar|aprobar|aceptar)|no (?:revisadas?|atendidas?|procesadas?|resueltas?))\b/.test(text);
  const state=pending?null:/\brechazad[ao]s?\b/.test(text)?'REJECTED':/\baprobad[ao]s?\b/.test(text)?'APPROVED':null;
  const all=/\b(?:todas|todos|historial completo)\b/.test(text);
  const reviewed=state||/\b(?:historial|revisadas?|atendidas?|procesadas?|resueltas?|anteriores|viejas)\b/.test(text);
  // A singular state query may refer to the selected or last managed request.
  const focused=/\b(?:estado|situacion|seguimiento|paso|sucedio)\b/.test(text)&&/\bsolicitud\b/.test(text)&&!all&&!reviewed&&!pending;
  const view=all?'all':pending?'pending':reviewed?'reviewed':focused?null:role==='ADMIN'?'pending':'all';
  return emptyIntent(view==='pending'?'pending_requests':'request_status',{request_view:view,request_type:cancel!==reschedule?(cancel?'CANCEL':'RESCHEDULE'):null,request_state:state,
    request_id:message.match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i)?.[0]||null,
    appointment_code:message.toUpperCase().match(/\bTCUS-[A-Z0-9]+-[A-Z0-9]+\b/)?.[0]||null,
    reference_index:text.match(/\b(?:solicitud|numero)\s+(\d{1,2})\b/)?Number(text.match(/\b(?:solicitud|numero)\s+(\d{1,2})\b/)![1]):null});
}

/** Accept only a semantically classified value supported by the current message. No free-text fallback. */
export function reasonAnswer(message:string,grounding:Grounding,intent:Intent):string|null{
  if(controlUtterance(message)||controlUtterance(intent.reason||'')||informationQuestion(message)||/[?¿]/.test(message)||pureNegation(message))return null;
  if(grounding.draft?.intent!=='reserve'||!['answer','correct','new_task'].includes(intent.dialogue_act||'')||!intent.reason||intent.reason.length>300)return null;
  if(fieldRefusal(intent)||intent.dialogue_target&&intent.dialogue_target!=='reason'&&intent.dialogue_target!=='task')return null;
  const offset=message.toLocaleLowerCase('es').indexOf(intent.reason.toLocaleLowerCase('es'));
  return offset<0?null:message.slice(offset,offset+intent.reason.length).trim();
}

const choiceIntent=(choice:Choice)=>emptyIntent(choice.intent,{...(choice.doctor_name?{doctor_name:choice.doctor_name}:{}),...(choice.request_id?{request_id:choice.request_id}:{}),...(choice.appointment_code?{appointment_code:choice.appointment_code}:{}),...(choice.appointment_type?{appointment_type:choice.appointment_type}:{}),...(choice.date?{date:choice.date}:{}),...(choice.time?{time:choice.time}:{}),...(choice.inquiry?{inquiry:choice.inquiry}:{})});
function namedChoice(message:string,selection?:Selection|null):Intent|null {
  if(!selection)return null;
  const key=(value:string)=>normalizeText(value).replace(/^(?:dr\.?|dra\.?|doctor|doctora)\s+/,'').replace(/[.!]+$/,'').trim();
  const name=key(message),matches=selection.choices.filter(c=>key(c.label)===name||c.doctor_name&&key(c.doctor_name)===name);
  return matches.length===1?{...choiceIntent(matches[0]),dialogue_act:'answer'}:null;
}
/** Recognize a choice-repair speech act, then resolve scopes; never map a bare number globally. */
function selectionCorrection(text:string,grounding:Grounding):Intent|null{
  const ordinals=['primer','primera','primero','segunda','segundo','tercera','tercero','cuarta','cuarto','quinta','quinto','sexta','sexto','septima','septimo','octava','octavo','novena','noveno','decima','decimo'];
  const values=[1,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10];
  const expression=new RegExp('^(?:perdon(?:a|ame)?|disculp(?:a|ame|e|eme)|rectifico|corrijo|correccion|me equivoque|quise decir|queria decir|cambio mi eleccion)[, :;]*(?:(?:era|es|queria|quiero|a)\\s+)?(?:(?:la|el)\\s+)?(?:(?:opcion|numero)\\s+)?(\\d{1,2}|'+ordinals.join('|')+')(?:\\s+(del menu(?: principal)?|de (?:esta|la) lista(?: actual)?))?$');
  const match=text.match(expression);if(!match)return null;
  const number=/^\d+$/.test(match[1])?Number(match[1]):values[ordinals.indexOf(match[1])];
  const current=grounding.selection?.choices[number-1],menu=grounding.context?.menu?.choices[number-1];
  const menuCorrection=()=>({...choiceIntent(menu!),navigation:'main_menu' as const,option_number:number});
  if(match[2]?.startsWith('del menu'))return menu?menuCorrection():emptyIntent('unknown');
  if(match[2])return current?choiceIntent(current):emptyIntent('unknown');
  if(grounding.selection?.type==='menu')return current?{...choiceIntent(current),navigation:'main_menu',option_number:number}:emptyIntent('unknown');
  if(current&&menu)return emptyIntent('unknown',{option_number:number,dialogue_act:'clarify'});
  return current?choiceIntent(current):menu?menuCorrection():emptyIntent('unknown');
}
/** Personal state questions must use authenticated live records, even if the model labels them knowledge. */
export function personalRequestQuery(text:string){
  const tokens=new Set(normalizeText(text).match(/[a-z0-9]+/g)||[]);
  return ['mi','mis'].some(w=>tokens.has(w))&&['solicitud','solicitudes','cambio','cambios','reprogramacion','cancelacion'].some(w=>tokens.has(w))&&['estado','situacion','seguimiento','ver','consultar','revisar'].some(w=>tokens.has(w));
}
export function resolveInterpretation(message:string,intent:Intent,grounding:Grounding):Intent {
  // Human assistance takes precedence over incidental social/selection/entity labels.
  if(supportSignal(message))return emptyIntent('support');
  const route=conversationRoute(message,grounding);if(route)return emptyIntent(route.intent||'unknown',route);
  if(grounding.draft&&undecidedAnswer(message))return emptyIntent('unknown',{dialogue_act:'clarify',dialogue_target:grounding.dialogue?.expectedSlot==='confirmation'?'task':grounding.dialogue?.expectedSlot||null});
  const type=visitTypeAnswer(message,grounding.selection?.type==='appointment_types');if(type&&(!/^\d+$/.test(normalizeText(message))||!grounding.selection||grounding.selection.type==='appointment_types')&&(!grounding.draft||grounding.selection?.type==='appointment_types'||/^Tipo de cita:/.test(message)))return emptyIntent('reserve',{appointment_type:type,dialogue_act:grounding.draft?.intent==='reserve'?'answer':'new_task'});
  const task=schedulingRequest(message,grounding);if(task)return task;
  const answer=resolveConversation(message,grounding);if(answer&&['reserve','reschedule','availability'].includes(answer.intent)&&answer.dialogue_act==='answer')return answer;
  const step=stepQuestion(message,grounding);if(step)return emptyIntent('unknown',{dialogue_act:'ask',dialogue_target:step==='confirmation'?'task':step});
  if(intent.intent==='support')return declinesSupport(message)?emptyIntent('greeting',{dialogue_act:'social'}):emptyIntent('support');
  const explanation=timeExplanationReference(message,grounding.dialogue?.expectedSlot||grounding.awaiting);
  if(explanation)return emptyIntent('unknown',{dialogue_act:'ask',dialogue_target:'time',reference_time:explanation});
  const requests=requestQuery(message,grounding.role);if(requests)return requests;
  const operational=operationalQuery(message,grounding.role);if(operational)return {...intent,intent:operational};
  if(personalRequestQuery(message))return {...intent,intent:'request_status'};
  if(fieldRefusal(intent))return emptyIntent('unknown',{dialogue_act:'refuse',dialogue_target:intent.dialogue_target});
  // Apply this boundary to general fallback results too: mentioning a slot in
  // a question is not an affirmative field contribution.
  if(questionEvidence(message)&&['answer','correct'].includes(intent.dialogue_act||'')&&['reserve','reschedule'].includes(intent.intent)){
    const reference=intent.time&&grounding.draft?referencedTime(message):null;
    const slot=grounding.dialogue?.expectedSlot||grounding.awaiting;
    return emptyIntent(reference?'availability':'unknown',{dialogue_act:'ask',dialogue_target:reference?'time':slot==='confirmation'?'task':slot||null,reference_time:reference||null});
  }
  if(intent.intent==='deny'&&!dismissEvidence(message,grounding.dialogue?.expectedSlot==='confirmation'))return emptyIntent('unknown',{dialogue_act:'clarify',dialogue_target:'task'});
  if(intent.intent==='deny'&&negatedControl(message))return emptyIntent('unknown',{dialogue_act:'clarify',dialogue_target:'task'});
  // Social questions remain read-only courtesy even when the provider also labels them 'ask'.
  if(intent.intent==='greeting')return emptyIntent('greeting',{dialogue_act:'social'});
  if(intent.dialogue_act==='ask'){
    if(['menu','knowledge','list_appointments','payment_status','pending_payments','pending_requests','request_status'].includes(intent.intent))return {...intent,dialogue_act:null,date:null,time:null,reason:null,reference_time:null};
    const groundedExplanation=Boolean(grounding.draft&&intent.dialogue_target&&intent.dialogue_target!=='time'&&(intent.dialogue_target!=='task'||grounding.dialogue?.expectedSlot==='confirmation'));
    if(questionEvidence(message)||groundedExplanation)return emptyIntent(intent.intent==='availability'&&intent.reference_time?'availability':'unknown',{dialogue_act:'ask',dialogue_target:intent.dialogue_target,reference_time:intent.reference_time});
    intent={...intent,dialogue_act:null,reference_time:null};
  }
  if(intent.dialogue_act==='social')return emptyIntent('greeting',{dialogue_act:'social'});
  if(informationQuestion(message)&&!['menu','knowledge','list_appointments','payment_status','pending_payments','pending_requests','request_status'].includes(intent.intent))return emptyIntent('unknown',{dialogue_act:'ask',dialogue_target:grounding.dialogue?.expectedSlot==='time'?'time':null,reference_time:referencedTime(message)});
  if(intent.intent==='deny'&&grounding.draft&&grounding.dialogue?.expectedSlot!=='confirmation'&&intent.dialogue_target!=='task')return emptyIntent('unknown',{dialogue_act:'clarify'});
  if(intent.dialogue_act==='clarify'){
    // A clear new task with missing slots still starts that task; ambiguity about a reference does not.
    if(!grounding.draft&&['reserve','availability','reschedule','cancel'].includes(intent.intent))return {...intent,dialogue_act:'new_task'};
    return emptyIntent('unknown',{dialogue_act:'clarify'});
  }
  const named=namedChoice(message,grounding.selection);if(named)return named;
  if(grounding.selection?.type==='doctor'&&intent.doctor_name){const doctor=namedChoice(intent.doctor_name,grounding.selection);if(doctor)return doctor;}
  // An answer/correction supplies slots to the active scheduling task. A model
  // label must not silently turn a reschedule answer into a new reservation.
  const scheduling=['reserve','availability','reschedule'];
  if(['answer','correct'].includes(intent.dialogue_act||'')&&scheduling.includes(grounding.draft?.intent)&&scheduling.includes(intent.intent))intent={...intent,intent:grounding.draft.intent};
  if(intent.option_number!=null){
    const selection=intent.navigation==='main_menu'?grounding.context?.menu:grounding.selection;
    const choice=selection?.choices[intent.option_number-1];
    return choice?{...choiceIntent(choice),navigation:intent.navigation,option_number:intent.option_number}:emptyIntent('unknown');
  }
  if(intent.date_expression){
    const date=calendarAnswer(intent.date_expression,grounding.today,grounding.dialogue?.expectedSlot==='date'?grounding.dialogue.requestedWeekday:null);
    return {...intent,intent:intent.intent==='unknown'&&grounding.draft?grounding.draft.intent:intent.intent,date:date||null};
  }
  if(intent.reason){const reason=reasonAnswer(message,grounding,intent);if(!reason)return emptyIntent('unknown',{dialogue_act:'clarify',dialogue_target:hasControlSignal(message)||pureNegation(message)?'task':'reason'});intent={...intent,reason};}
  return intent;
}
