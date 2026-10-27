import {BadRequestException,ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import type {Profile} from '../types.js';
import type {ClinicalMetadata,ClinicalBlobs} from '../ports/clinical-documents.js';
import type {PaymentFileInput} from '../ports/payments.js';
import {validatePaymentFile} from './payments.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function id(value:unknown){if(typeof value!=='string'||!uuid.test(value))throw new BadRequestException('Referencia de documento no válida.');return value;}
/** Clinical files never enter conversation, RAG, Calendar payloads or notification bodies. */
export class ClinicalDocumentService {
 constructor(private metadata:ClinicalMetadata,private blobs:ClinicalBlobs,private writable=true){}
 private access(actor:Profile,write=false){if(!actor.active||!['PATIENT','DOCTOR'].includes(actor.role))throw new ForbiddenException('Los documentos médicos son privados del paciente y de su médico asignado.');if(!this.metadata.available())throw new ServiceUnavailableException('Falta habilitar los documentos previos de la cita.');if(write&&!this.writable)throw new ForbiddenException('Este entorno solo permite consultas.');}
 async list(actor:Profile,appointment?:string){this.access(actor);if(appointment!==undefined&&!/^[-a-zA-Z0-9]{1,80}$/.test(appointment))throw new BadRequestException('Referencia de cita no válida.');return this.metadata.dispatch(actor,'list',appointment?{appointment_id:appointment}:{});}
 async upload(actor:Profile,appointment:string,request:unknown,input:PaymentFileInput){
  this.access(actor,true);if(actor.role!=='PATIENT')throw new ForbiddenException('Solo el paciente puede adjuntar sus documentos.');
  if(typeof appointment!=='string'||!/^[-a-zA-Z0-9]{1,80}$/.test(appointment))throw new BadRequestException('Cita no válida.');
  const request_id=id(request);let file;try{file=validatePaymentFile(input);}catch{throw new BadRequestException('Adjunta un documento PDF, JPG o PNG válido de hasta 5 MB.');}
  await this.metadata.dispatch(actor,'prepare',{appointment_id:appointment,request_id,sha256:file.sha256,file_name:file.file_name});
  const storage_key=createHash('sha256').update('clinical\0'+actor.id+'\0'+appointment+'\0'+request_id+'\0'+file.sha256).digest('hex');
  try{await this.blobs.put(storage_key,file.data,file.sha256);}catch{throw new ServiceUnavailableException('No pudimos guardar el documento en el almacenamiento privado del servidor. No quedó registrado; conserva el archivo y vuelve a intentar con la misma selección.');}
  const {data,...properties}=file;
  return this.metadata.dispatch(actor,'commit',{appointment_id:appointment,request_id,...properties,storage_key});
 }
 async download(actor:Profile,document:unknown){this.access(actor);const meta=await this.metadata.dispatch(actor,'download',{id:id(document)});let data:Buffer;try{data=await this.blobs.get(meta.storage_key);}catch{throw new ServiceUnavailableException('El documento no está disponible en este servidor. Contacta al equipo de TeleCUS.');}if(createHash('sha256').update(data).digest('hex')!==meta.sha256)throw new ServiceUnavailableException('No fue posible comprobar el archivo.');return {data,content_type:meta.content_type};}
 async withdraw(actor:Profile,document:unknown){this.access(actor,true);if(actor.role!=='PATIENT')throw new ForbiddenException('Solo el paciente puede retirar su documento.');return this.metadata.dispatch(actor,'withdraw',{id:id(document)});}
 async review(actor:Profile,document:unknown,input:any){this.access(actor,true);if(actor.role!=='DOCTOR')throw new ForbiddenException('La revisión de documentos corresponde al médico asignado.');if(!input||!['LEGIBLE','CORRECTION_REQUESTED'].includes(input.status)||!Number.isSafeInteger(input.version)||input.version<1)throw new BadRequestException('Revisa el estado y la versión del documento.');return this.metadata.dispatch(actor,'review',{id:id(document),status:input.status,version:input.version});}
}
