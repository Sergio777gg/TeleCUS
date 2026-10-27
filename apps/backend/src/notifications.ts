import { BadRequestException,ForbiddenException,ServiceUnavailableException } from '@nestjs/common';
import {publicRejectionNotice} from './application/rejection-reasons.js';
import type { NotificationInbox } from './ports/application.js';
import { Profile } from './types.js';

export function notificationText(event:any,role:string){
  const p=event.payload||{},code=p.code||'Tu cita';
  const date=p.start_time?new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',dateStyle:'medium',timeStyle:'short',hour12:true}).format(new Date(p.start_time)):'';
  const change=p.request_type==='RESCHEDULE'?'reprogramación':'cancelación';
  if(event.event_type==='change_rejected'&&role==='PATIENT')return publicRejectionNotice(code,p.request_type,typeof p.public_reason==='string'?p.public_reason:undefined,p.start_time);
  const labels:Record<string,[string,string]>={
    clinical_documents_updated:['Documentos de la cita actualizados',`Hay una actualización en los documentos privados de ${code}. Revísalos en la sección de documentos. Este aviso no confirma la cita.`],
    payment_receipt_withdrawn:role==='ADMIN'?['Comprobante retirado',`El paciente retiró el comprobante de ${code} para corregirlo. Revisa la evidencia vigente antes de verificar el pago.`]:['Comprobante retirado',`Puedes adjuntar el archivo correcto de ${code}. Tu pre-reserva conserva su estado; si ya pagaste, no vuelvas a pagar.`],
    payment_receipt_received:role==='ADMIN'?['Comprobante recibido',`El paciente adjuntó un comprobante para ${code}. Revísalo y contrasta el pago antes de verificarlo.`]:['Comprobante enviado',`Recibimos el comprobante de ${code}. El Administrador revisará el pago; la cita aún no está confirmada.`],
    appointment_requested:p.payment_required===false?(role==='ADMIN'?['Nueva solicitud gratuita',`La solicitud ${code} está pendiente de admisión administrativa, sin cobro.`]:['Solicitud gratuita registrada',`Tu solicitud ${code} está pendiente de revisión administrativa. No debes pagar ni enviar comprobantes.`]):role==='ADMIN'?['Nuevo pago pendiente',`La pre-reserva ${code} está pendiente de verificación de pago. Revisa la agenda antes de confirmarla.`]:['Pre-reserva registrada',`Tu pre-reserva ${code} quedó registrada. Falta realizar el pago y la verificación administrativa.`],
    appointment_confirmed:role==='DOCTOR'?['Nueva cita asignada',`Se confirmó y asignó a tu agenda la cita ${code}.`]:p.payment_required===false?['Cita gratuita confirmada',`Tu cita ${code} ya está confirmada en la agenda. No requiere pago.`]:['Pago verificado y cita confirmada',`El pago de ${code} fue verificado y la cita ya está confirmada en la agenda.`],
    appointment_rescheduled:['Cita reprogramada',`El nuevo horario de ${code} ya está confirmado en la agenda.`],
    appointment_cancelled:p.reason==='reservation_expired'?['Pre-reserva vencida',`El plazo para adjuntar el comprobante de ${code} terminó y se liberó el cupo. Consulta disponibilidad antes de pagar. Si ya pagaste, contacta al equipo de TeleCUS para revisar tu caso.`]:['Cita cancelada',`La cancelación de ${code} se completó. Esa cita ya no está vigente.`],
    appointment_completed:['Cita finalizada',`La atención de ${code} fue registrada como finalizada.`],
    doctor_assigned:role==='DOCTOR'?['Nueva cita asignada',`Se te asignó la cita ${code}.`]:['Cambio de médico confirmado',`La asignación del médico de ${code} se actualizó en la agenda.`],
    appointment_unassigned:['Cambio en tu agenda',`La cita ${code} fue reasignada y ya no está a tu cargo.`],
    change_requested:role==='ADMIN'?['Nueva solicitud de cambio',`Hay una solicitud de ${change} de ${code} pendiente de revisión.`]:['Solicitud enviada',`Registramos tu solicitud de ${change} de ${code}. La cita conserva su estado actual mientras se revisa y completa el cambio.`],
    change_approved:role==='ADMIN'&&p.request_type==='CANCEL'?['Cancelación aprobada y aplicada',`La solicitud de ${code} fue aprobada y la cita ya está cancelada.`]:['Solicitud aprobada',`La solicitud de ${change} de ${code} fue aprobada y el cambio se completó.`],
    change_rejected:role==='ADMIN'?['Rechazo registrado correctamente',`Se registró el rechazo de la solicitud de ${change} de ${code}. Esta decisión no modificó la cita. Puedes consultar su estado actual con «Ver cita».`]:[`Solicitud de ${change} no aprobada`,role==='PATIENT'?`El equipo administrativo no aprobó tu solicitud de ${change} de ${code}. Esta decisión no modificó tu cita. Puedes consultar su estado actual con «Ver cita».`:`La solicitud de ${change} de ${code} fue rechazada en la revisión administrativa. Esta decisión no modificó la cita. Puedes consultar su estado actual con «Ver cita».`],
    integration_attention:['Una operación necesita revisión',`La ${p.stage==='mail'?'entrega del correo':'sincronización de la agenda'} de ${code} requiere revisión administrativa. Consulta el estado de sincronización antes de repetir la operación.`]
  };
  const [title,body]=labels[event.event_type]||['Actualización de agenda',`Consulta el estado de ${code}.`];
  return {title,body:body+(event.event_type==='change_rejected'&&typeof p.public_reason==='string'?' Motivo comunicado: '+p.public_reason:'')+(date&&event.event_type!=='appointment_cancelled'?` ${event.event_type==='change_rejected'?'Horario registrado al rechazar la solicitud':'Horario registrado'}: ${date}, hora de Colombia.`:'')};
}

export class NotificationsService{
  constructor(private inbox:NotificationInbox){}
  private batch(user:Profile,value:unknown){if(!user.active||!['PATIENT','ADMIN','DOCTOR'].includes(user.role))throw new ForbiddenException();if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new BadRequestException('Referencia de limpieza no válida.');return value;}
  async remove(user:Profile,raw:any){const batch=this.batch(user,raw?.batchId),ids=raw?.ids??[],read=raw?.read??false;if(typeof read!=='boolean'||!Array.isArray(ids)||ids.length>50||ids.some((id:any)=>typeof id!=='string'||!/^[1-9][0-9]{0,17}$/.test(id))||read&&ids.length)throw new BadRequestException('Selecciona notificaciones o elimina las leídas.');if(!this.inbox.remove)throw new ServiceUnavailableException('La limpieza de notificaciones todavía no está habilitada.');return {removed:await this.inbox.remove(user,([...new Set(ids)] as string[]).sort(),read,batch),batchId:batch};}
  async restore(user:Profile,raw:any){const batch=this.batch(user,raw?.batchId);if(!this.inbox.restore)throw new ServiceUnavailableException('La recuperación de notificaciones todavía no está habilitada.');return {restored:await this.inbox.restore(user,batch)};}
  async list(user:Profile,before?:string,limit=20){
    if(!Number.isInteger(limit)||limit<1||limit>50||(before&&!/^[1-9][0-9]{0,17}$/.test(before)))throw new BadRequestException('La página de notificaciones no es válida.');
    const page=await this.inbox.list(user,before,limit);
    return {...page,unread:Number(page.unread),items:page.items.map((event:any)=>({id:String(event.id),created_at:event.created_at,read_at:event.read_at,...notificationText(event,user.role),...(/^TCUS-[A-Z0-9-]{1,65}$/.test(event.payload?.code||'')?{target:{appointment_code:event.payload.code}}:{})}))};
  }
  async read(user:Profile,ids:unknown){
    if(!Array.isArray(ids)||ids.length>50||ids.some(id=>typeof id!=='string'||!/^[1-9][0-9]{0,17}$/.test(id)))throw new BadRequestException('Selecciona notificaciones válidas.');
    if(!ids.length)return {updated:0};
    return {updated:await this.inbox.read(user,ids)};
  }
}

