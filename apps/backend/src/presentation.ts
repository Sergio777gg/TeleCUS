/** Render clock notation only; transport values, dates, URLs and identifiers remain unchanged. */
export function clockText(text:string):string {
  return text.replace(/https?:\/\/[^\s<>]+|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?\b|(?<![\w:])((?:[01]\d|2[0-3]):[0-5]\d)(?![\w:])(?:\s*([ap])\.?\s*m\.?)?/gi,(match,time,meridiem)=>{
    if(!time)return match;
    const hour=Number(time.slice(0,2)),minutes=time.slice(3);
    if(meridiem&&hour>=1&&hour<=12)return `${hour}:${minutes} ${meridiem.toLowerCase()}. m.`;
    return `${hour%12||12}:${minutes} ${hour<12?'a':'p'}. m.`;
  });
}

/** Present only states actually returned by the agenda; never let the model invent success. */
export function pendingDeliveryReply(delivery:{operation:string;stage:string;status:string;payment_required?:boolean}){
  const subject=delivery.operation==='confirm'?(delivery.payment_required===false?'La aprobación de la solicitud gratuita ya está registrada.':'La verificación del pago ya está registrada.'):'La cita ya tiene una operación registrada.';
  const state=delivery.status==='review'?'La sincronización requiere revisión administrativa.':delivery.stage==='calendar'?'Está pendiente completar la sincronización con Calendar.':'Está pendiente completar la notificación por correo.';
  return subject+' '+state+' No necesitas confirmar otra vez la misma operación. Consulta «Ver estado de sincronización». La cita y el pago conservarán su estado registrado hasta completar la agenda.';
}
export function operationReply(kind:string,result:string):string{
  if(result.startsWith('Solicitud pendiente de revisión administrativa'))return 'Listo, tu solicitud quedó registrada para revisión administrativa. Tu cita conserva su estado actual. Te avisaremos en Notificaciones cuando haya una decisión; también puedes preguntar «¿Cómo va mi solicitud?». ';
  if(/^Operación de .+ registrada para sincronizar con Google\./.test(result)){
    const action:Record<string,string>={confirm_free:'la aprobación de la solicitud gratuita',verify_payment:'la verificación del pago y la confirmación de la cita',approve_change:'la aprobación y aplicación de la solicitud',cancel:'la cancelación de la cita',reschedule:'la reprogramación de la cita',assign_doctor:'el cambio de médico'};
    return `Listo, registré ${action[kind]||'la operación'}. Estamos procesando el cambio en la agenda. Te avisaremos en Notificaciones cuando se complete. Por ahora, el estado de la cita sigue siendo el que aparece en «Ver mis citas». El correo se enviará después de completar la agenda.`;
  }
  if(result.startsWith('Pre-reserva ')&&result.includes('Aún no hay evento de Calendar.'))return 'Listo, '+result.replace('Aún no hay evento de Calendar.','La cita todavía no está confirmada: falta realizar el pago y que el personal administrativo lo verifique.').replace('El enlace de pago aún no está configurado; solicítalo al administrativo.','Solicita al personal administrativo el enlace o las instrucciones de pago.');
  return result;
}
