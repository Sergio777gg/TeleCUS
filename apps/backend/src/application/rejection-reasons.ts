import {BadRequestException} from '@nestjs/common';
export const REJECTION_REASONS=[
 {code:'availability',label:'Horario o profesional no disponible',suggestion:'El horario solicitado no está disponible. Puedes elegir otra fecha u hora.'},
 {code:'information',label:'Información por completar',suggestion:'Necesitamos que completes la información indicada antes de revisar nuevamente tu solicitud.'},
 {code:'duplicate',label:'Solicitud duplicada',suggestion:'Ya existe otra solicitud para esta misma gestión. Puedes consultar su seguimiento.'},
 {code:'service_rules',label:'Condición del servicio',suggestion:''},
 {code:'other',label:'Otro motivo',suggestion:''}
];
/** Public explanation only: never derive a reason from the patient's clinical text or private notes. */
export function rejectionReason(input:Record<string,unknown>){
 const category=input.rejection_category,raw=input.public_reason;
 if(typeof category!=='string'||!REJECTION_REASONS.some(r=>r.code===category)||typeof raw!=='string'||/[\u0000-\u001f\u007f]/.test(raw))throw new BadRequestException('Selecciona un motivo y escribe la explicación que recibirá el paciente.');
 const message=raw.trim().replace(/\s+/g,' ');
 if(message.length<20||message.length>300||message.split(' ').length<3||!/[a-záéíóúñ]/i.test(message))throw new BadRequestException('Explica el motivo de forma comprensible, entre 20 y 300 caracteres.');
 return {rejection_category:category,public_reason:message};
}
export function publicRejectionNotice(code:string,type:string,reason?:string,start?:string){
 const change=type==='RESCHEDULE'?'reprogramación':'cancelación',date=start&&Number.isFinite(Date.parse(start))?new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',dateStyle:'medium',timeStyle:'short',hour12:true}).format(new Date(start)):null;
 return {title:`Solicitud de ${change} no aprobada`,body:`El equipo administrativo no aprobó tu solicitud de ${change} de ${code}.`+(reason?' Motivo: '+reason:'')+' Esta decisión no modificó tu cita. Puedes consultar su estado actual con «Ver cita».'+(date?' Horario registrado al rechazar la solicitud: '+date+', hora de Colombia.':'')};
}
