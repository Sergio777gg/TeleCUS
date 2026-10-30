import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Profile } from '../types.js';
import type { AgendaPort } from '../ports/integrations.js';
import { agendaConflict } from '../application/agenda-errors.js';
import { PAYMENT_PORTAL_URL } from '../config.js';
export type { AgendaPort } from '../ports/integrations.js';
/** The API authenticates the actor; the database independently checks their current role. */
export class PostgresAgenda implements AgendaPort {
  visitsAvailable=false;
  private pool: Pool;
  constructor(url: string, caFile: string, address?: string,private paymentDestination?:()=>Promise<string>,private readOnly=false) {
    const uri = new URL(url);
    if (uri.search) throw new Error('Configura TLS mediante el certificado, sin par�metros sslmode en la URL.');
    this.pool = new Pool({
      host: address || uri.hostname, port: Number(uri.port || 5432),
      user: decodeURIComponent(uri.username), password: decodeURIComponent(uri.password),
      database: uri.pathname.slice(1), max: 4, connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000, statement_timeout: 15000, application_name: 'telecus-agenda',
      ssl: { rejectUnauthorized: true, servername: uri.hostname, ca: readFileSync(caFile, 'utf8') },
    });
    this.pool.on('error', () => console.error('La conexi�n de agenda necesita recuperarse.'));
  }
  private async query(text:string,args:unknown[]){
    if(!this.readOnly)return this.pool.query(text,args);
    const client=await this.pool.connect();
    let discard=false;
    try{
      // An explicit transaction also works through transaction poolers that ignore startup options.
      await client.query('BEGIN READ ONLY');
      const result=await client.query(text,args);
      await client.query('COMMIT');
      return result;
    }catch(error){
      try{await client.query('ROLLBACK');}catch{discard=true;}
      throw error;
    }finally{client.release(discard);}
  }
  async call(name: string, args: unknown[] = []) {
    const allowed = ['doctors','availability','execute','claim_delivery','finish_calendar','arm_mail','finish_mail','fail_delivery','delivery_status','version','notification_version','list_notifications','read_notifications','payment_receipts_version','list_payment_receipts','upload_payment_receipt','download_payment_receipt','withdraw_payment_receipt','administration_version','portal_settings','seed_knowledge_catalog','published_knowledge','administration_read','administration_write','claim_registration','prepare_payment_review','confirm_payment_review','schedule_version','service_schedules','save_service_schedule','expire_holds','workspace_version','workspace_appointments','workspace_requests','staff_snapshot'];
    if (!allowed.includes(name)&&!['visit_workflow_version','scoped_visit_appointments','service_availability','patient_workspace_version','payment_history_version','public_rejections','rejection_reasons_version','notification_actions_version','dismiss_notifications','restore_notifications','clinical_document_list_version','clinical_documents_version','clinical_documents','patient_workspace'].includes(name)) throw new Error('Operaci�n de agenda desconocida.');
    try {
      const result = await this.query(`SELECT telecus_integration.${name}(${args.map((_, i) => '$'+(i+1)).join(',')}) AS result`, args);
      return result.rows[0]?.result;
    } catch (error: any) {
      if(error.code==='25006')throw new ForbiddenException('La conexi�n actual solo permite consultas.');
      if(['payment_receipts_version','administration_version','visit_workflow_version','patient_workspace_version','payment_history_version','rejection_reasons_version','notification_actions_version','clinical_document_list_version','clinical_documents_version'].includes(name)&&error.code==='42883')return null;
      if (error.code === '42501') throw new ForbiddenException('Tu cuenta no permite esta operaci�n.');
      if(name==='clinical_documents'){
        if(['P0002','23505','40001'].includes(error.code))throw new ConflictException(error.message==='Document limit'?'Esta cita admite hasta 10 documentos vigentes. Retira el archivo que necesites corregir.':error.message==='Document withdrawn'?'El documento fue retirado; actualiza la lista.':error.message==='Appointment no longer editable'?'Esta cita ya no admite nuevos documentos o cambios. Consulta su estado actual.':'El documento cambi� o el env�o ya fue utilizado. Actualiza antes de continuar.');
        if(['22023','22P02','23514'].includes(error.code))throw new BadRequestException('Revisa la cita y selecciona un PDF, JPG o PNG v�lido de hasta 5 MB.');
        throw new ServiceUnavailableException('No pudimos conectar con el registro de documentos. Conserva el archivo y reintenta con la misma selecci�n; el env�o no se duplicar�.');
      }
      if(['save_service_schedule','withdraw_payment_receipt','administration_write','prepare_payment_review','confirm_payment_review'].includes(name)){
        const conflicts:Record<string,string>={'Schedule changed':'Los horarios cambiaron. Actualiza los datos y revisa nuevamente la operaci�n.','Review expired':'La revisi�n venci�. Abre una nueva para comprobar los datos actuales.','Receipt or appointment changed':'La cita o el comprobante cambi�. Revisa de nuevo antes de confirmar.','Payment no longer reviewable':'La cita ya no tiene un pago pendiente elegible o su confirmaci�n est� en proceso.','Receipt no longer editable':'El comprobante ya no puede retirarse; consulta el estado con el Administrador.','Profile changed':'El perfil cambi�. Actualiza antes de guardar.','Settings changed':'La configuraci�n cambi�. Actualiza antes de guardar.','Document changed':'El documento cambi�. Abre su versi�n actual.','Resolve active appointments first':'Resuelve las citas vigentes antes de cambiar el rol o desactivar.','Identity already exists':'La persona ya tiene una identidad registrada. Busca su perfil para editarlo.'};
        if(['P0002','23505'].includes(error.code))throw new ConflictException(conflicts[error.message]||'Los datos cambiaron o la referencia ya fue utilizada. Actualiza antes de repetir la gesti�n.');
        if(error.code==='22023')throw new BadRequestException('Revisa los datos del formulario. No se aplic� la gesti�n.');
      }
      if(name==='upload_payment_receipt'){
        if(error.code==='23505')throw new ConflictException(error.message==='Receipt request mismatch'?'Este env�o ya se us� para otro archivo. Vuelve a seleccionar el comprobante.':'Ya recibimos un comprobante para esta pre-reserva. Consulta su estado antes de volver a enviarlo.');
        if(error.code==='P0002')throw new ConflictException('La cita ya no admite comprobantes o su confirmaci�n est� en proceso. Consulta su estado actual.');
        if(error.code==='22023')throw new BadRequestException('No se pudo validar el comprobante. Selecciona un PDF, JPG o PNG de hasta 5 MB.');
      }
      if (['23505','23P01','40001','P0002'].includes(error.code)) throw new ConflictException(agendaConflict(error.code,error.message));
      if (error.code === '22023') throw new BadRequestException('Los datos no cumplen las reglas de la cita. Revisa el m�dico, fecha y estado.');
      throw new ServiceUnavailableException('No fue posible completar la conexi�n con la agenda. Consulta el estado antes de repetir la operaci�n.');
    }
  }
  doctors(actor: Profile) { return this.call('doctors', [actor.id]); }
  deliveryStatus(actor:Profile){return this.call('delivery_status',[actor.id]);}
  availability(actor: Profile, doctor: string, date: string) { return this.call('availability', [actor.id, doctor, date]); }
  async execute(actor: Profile, id: string, kind: string, payload: Record<string, unknown>) {
    const allowed=['doctor_id','date','time','reason','appointment_code','request_id','schedule_version','expected_snapshot','appointment_type','visit_policy_version','rejection_category','public_reason'];
    const trusted=Object.fromEntries(allowed.filter(k=>payload[k]!==undefined).map(k=>[k,payload[k]]));
    if(kind==='reserve')trusted.payment_link=this.paymentDestination?await this.paymentDestination():PAYMENT_PORTAL_URL;
    return this.call('execute', [actor.id, id, kind, JSON.stringify(trusted)]);
  }
  async appointments(actor:Profile,ids?:string[]){return this.call('scoped_visit_appointments',[actor.id,ids?JSON.stringify(ids):null]);}
  async patientAppointments(actor:Profile,code?:string){return (await this.call('patient_workspace',[actor.id,code||null])).items;}
  async publicRejections(actor:Profile,ids:string[]){return await this.call('public_rejections',[actor.id,JSON.stringify(ids)]);}
  async serviceAvailability(actor:Profile,date:string){return this.call('service_availability',[actor.id,date]);}
  async ready() { if (await this.call('version') !== 1 || await this.call('notification_version') !== 2) throw new Error('Falta una migraci�n compatible de agenda/notificaciones.');this.visitsAvailable=await this.call('visit_workflow_version')===1; }
  close() { return this.pool.end(); }
}
