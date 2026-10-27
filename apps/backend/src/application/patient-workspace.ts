import {BadRequestException,ForbiddenException} from '@nestjs/common';
import type {SchedulingRepository} from '../ports/application.js';
import type {Profile} from '../types.js';
/** Current patient agenda and notification targets are direct authenticated queries, not chat jobs. */
export class PatientWorkspaceService {
 constructor(private repository:SchedulingRepository){}
 async read(actor:Profile,code?:unknown){
  if(!actor.active||actor.role!=='PATIENT')throw new ForbiddenException('Este espacio pertenece al paciente autenticado.');
  if(code!==undefined&&(typeof code!=='string'||!/^TCUS-[A-Z0-9-]{1,65}$/i.test(code)))throw new BadRequestException('Referencia de cita no válida.');
  const reference=typeof code==='string'?code.toUpperCase():undefined;
  const items=this.repository.portalAppointments?await this.repository.portalAppointments(actor,reference):(await this.repository.appointments(actor)).filter(a=>reference?a.code===reference:!['CANCELLED','COMPLETED'].includes(a.status));
  return {items};
 }
}
