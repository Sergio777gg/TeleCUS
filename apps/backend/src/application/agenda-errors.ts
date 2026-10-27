/** Translate only known database conditions; never expose arbitrary SQL messages. */
export function agendaConflict(code:string,message:string):string{
 if(code==='P0002'&&message==='Appointment changed or delivery pending')return 'La cita ya cambió o tiene una sincronización pendiente. Consulta «Ver estado de sincronización» antes de volver a confirmar; si requiere revisión, repetir el pago no desbloquea la entrega.';
 if(code==='P0002'&&message==='Staff review changed')return 'La cita, solicitud u horario cambió desde que lo revisaste. Actualiza y prepara una nueva confirmación.';
 if(code==='23P01')return 'El horario está ocupado o el médico ya no está disponible. Consulta nuevamente la agenda antes de confirmar.';
 if(code==='P0002'&&message==='Request changed')return 'La solicitud ya fue revisada o cambió. Consulta nuevamente su estado.';
 return 'La cita, solicitud o disponibilidad cambió. Consulta nuevamente la agenda.';
}
