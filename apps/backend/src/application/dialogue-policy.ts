import type { Intent } from '../types.js';

export const dialogueActs=['answer','correct','new_task','clarify','refuse','social','ask'] as const;
export const dialogueTargets=['doctor','date','time','reason','appointment','request','option','task'] as const;
export const fieldKeys:Record<string,string[]>={doctor:['doctor_name','doctor_id'],date:['date'],time:['time'],reason:['reason'],appointment:['appointment_code'],request:['request_id'],option:[]};

/** Interpretations are candidates: a field refusal must never become a domain value or task cancellation. */
export function fieldRefusal(intent:Intent):boolean {
  return intent.dialogue_act==='refuse'&&intent.dialogue_target!=null&&intent.dialogue_target!=='task';
}

export function refusalReply(field:string,repeated:boolean):string {
  if(field==='reason')return repeated
    ? 'Está bien, no tienes que explicar lo personal. Conservo lo que elegiste y podemos dejar la gestión en pausa. Si te representa, puedes escribir «consulta general»; también puedes pedir orientación al personal administrativo. Aún no se ha creado la pre-reserva.'
    : 'Entiendo que prefieras mantenerlo en privado. Para la pre-reserva solo se requiere un motivo general, sin detalles clínicos. Si te representa, puedes escribir «consulta general»; yo no lo elegiré por ti. También puedes dejar la gestión en pausa y consultar al personal administrativo. Conservo lo que elegiste; aún no se ha creado la pre-reserva.';
  return 'Está bien. No registraré esa respuesta como un dato ni cancelaré tu gestión. Conservo lo que ya elegiste. Podemos dejarlo en pausa; cuando quieras continuar, indica el dato pendiente o pide ayuda al personal administrativo.';
}

export function socialReply(active:boolean,returning:boolean,social=false):string {
  return (social?'Gracias por preguntar. Estoy aquí para ayudarte. ':returning?'¡Hola! Seguimos por aquí. ':'¡Hola! Estoy aquí para ayudarte. ')+(active
    ? 'Conservo tu gestión. Puedes continuar con el dato pendiente, revisar lo que elegiste o pedir el menú.'
    : 'Puedes consultar una cita, gestionar un cambio o pedir el menú de opciones.');
}
