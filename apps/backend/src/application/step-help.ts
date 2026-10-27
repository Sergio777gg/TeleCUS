import { normalizeText } from '../calendar.js';
import type { ExpectedSlot } from './dialogue-state.js';

type StepContext={awaiting?:ExpectedSlot|null;dialogue?:{expectedSlot?:ExpectedSlot|null};selection?:{type:string}|null};
const subjects:Partial<Record<ExpectedSlot,RegExp>>={
  doctor:/\b(?:medic[oa]s?|doctor(?:a)?s?|profesional(?:es)?)\b/,
  date:/\b(?:fechas?|dias?|lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)\b/,
  time:/\b(?:horas?|horarios?|turnos?)\b/,
  reason:/\b(?:motivos?|razon|razones|detalles?)\b/,
  appointment:/\b(?:citas?|reservas?)\b/,
  request:/\bsolicitud(?:es)?\b/,
  option:/\b(?:opciones?|menu|numeros?|lista)\b/,
  confirmation:/\b(?:confirm[a-z]*|boton|operacion)\b/
};

/** A grounded question explains a step; it never supplies a value or authorizes a write. */
export function stepQuestion(message:string,context:StepContext):ExpectedSlot|null {
  const selected:Record<string,ExpectedSlot>={doctor:'doctor',appointments:'appointment',requests:'request',menu:'option',change:'option'};
  const current=context.dialogue?.expectedSlot||context.awaiting||selected[context.selection?.type||''];
  if(!current)return null;
  const text=normalizeText(message).replace(/[¿?¡!.,;:]/g,' ').replace(/\s+/g,' ').trim();
  const explicitStep=/\b(?:este|ese|el)\s+(?:paso|campo|dato|procedimiento)\b/.test(text);
  if(explicitStep&&/\b(?:comprend[a-z]*|entend[a-z]*|entender|explic[a-z]*)\b/.test(text))return current;
  const guidedHelp=/\b(?:ayud[a-z]*|orient[a-z]*)\b/.test(text)&&/\b(?:para|a|con)\b/.test(text)&&!/^para que\b/.test(text);
  const choiceEffect=/\bque (?:cambia|implica|diferencia)\b/.test(text)&&/\b(?:segun|dependiendo|si|cuando)\b/.test(text)&&/\b(?:elij[a-z]*|eleg[a-z]*|escoj[a-z]*|escog[a-z]*|seleccion[a-z]*)\b/.test(text);
  const asking=choiceEffect||guidedHelp||/\b(?:sentido|utilidad|proposito|finalidad|para que|que (?:ocurre|pasa|sucede) (?:al|cuando)|que significa|a que te refieres|que quieres decir|me explicas|puedes explicar|podrias explicar|como asi)\b/.test(text)
    ||/\bpor que\b/.test(text)&&/\b(?:debo|debes|debemos|tengo que|hay que|necesit[a-z]*|me pides|me pide|elegir|seleccionar|escoger|indicar|confirmar)\b/.test(text)
    ||/^como\s+(?:(?:se supone que|debo|puedo|tengo que)\s+)*(?:elijo|elegir|escojo|escoger|selecciono|seleccionar|confirmo|confirmar)\b/.test(text);
  const bare=text.replace(/^(?:(?:pero|y|entonces|disculpa|oye)\s+)+/,'');
  if(!asking&&!/^(?:no entiendo|no comprendo)$/.test(bare))return null;
  const topics=Object.entries(subjects).filter(([,pattern])=>pattern!.test(text)).map(([key])=>key as ExpectedSlot);
  // 'cita' can provide the task context while the question concerns another field.
  const specific=topics.filter(t=>t!=='appointment');
  if(specific.length===1)return specific[0];
  if(asking&&explicitStep&&!specific.length)return current;
  if(topics.length===1&&topics[0]===current)return current;
  if(!specific.length){
    if(/\b(?:elegir|escoger|seleccionar)(?:lo|la)\b|\b(?:elegir|escoger|seleccionar)\s+(?:eso|esto|a alguien)\b/.test(text))return current;
    const pointers=new Set('para por que es son eso esto lo la el mi una un cita de del a en debo tengo hay elegir escoger seleccionar hacerlo sirve necesito entonces no entiendo comprendo'.split(' '));
    if(bare.split(' ').every(word=>pointers.has(word)))return current;
  }
  return null;
}

const explanations:Record<ExpectedSlot,string>={
  doctor:'Elegimos al médico que atendería tu cita para consultar sus horarios disponibles. Elegirlo todavía no reserva un espacio.',
  date:'La fecha nos permite consultar la disponibilidad del día que prefieres. Después revisamos los horarios que admite la agenda.',
  time:'La hora indica el turno que prefieres dentro de la jornada disponible. La agenda vuelve a comprobar ese espacio al confirmar la operación.',
  reason:'Se pide un motivo general para registrar la solicitud de cita. Basta una descripción breve, sin detalles clínicos; no tienes que contar algo íntimo aquí. Si te representa, puedes escribir «consulta general».',
  appointment:'Elegir una cita permite identificar cuál quieres consultar o gestionar. Así evitamos aplicar una operación a otra cita.',
  request:'Elegir la solicitud permite identificar la gestión que quieres consultar o revisar. Seleccionarla no la aprueba ni la rechaza.',
  option:'Las opciones indican qué gestión quieres realizar. Puedes elegir un número o describir lo que necesitas con tus palabras.',
  confirmation:'La confirmación autoriza la operación que acabas de revisar. Comprueba sus datos antes de aceptarla; si quieres corregirlos, puedes volver a la gestión.'
};

export function stepExplanation(target:ExpectedSlot):string{return explanations[target];}
