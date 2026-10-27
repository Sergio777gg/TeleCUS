import { BadRequestException,ForbiddenException,ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Profile } from '../types.js';
import type { PaymentFileInput,PaymentReceiptStore,ValidatedPaymentFile } from '../ports/payments.js';

export const MAX_PAYMENT_RECEIPT_BYTES=5*1024*1024;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const demoId=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
function identifier(value:unknown,label:string,allowDemo=false):string{
  if(typeof value!=='string'||!(uuid.test(value)||(allowDemo&&demoId.test(value))))throw new BadRequestException(label+' no válido.');
  return value;
}
function mimeOf(data:Buffer):string|null{
  if(data.length>=24&&data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&data.subarray(12,16).equals(Buffer.from('IHDR')))return 'image/png';
  if(data.length>=4&&data[0]===255&&data[1]===216&&data[2]===255&&data[data.length-2]===255&&data[data.length-1]===217)return 'image/jpeg';
  if(data.length>=16&&/^%PDF-[12]\.[0-9]/.test(data.toString('latin1',0,8))&&/%%EOF[ \t\r\n\f\v]*$/.test(data.toString('latin1',Math.max(0,data.length-1024))))return 'application/pdf';
  return null;
}
/** File signature checks are a type gate, not an antivirus scan or proof of payment. */
export function validatePaymentFile(input:PaymentFileInput):ValidatedPaymentFile{
  if(!input||typeof input.file_name!=='string'||!input.file_name.trim()||input.file_name.length>240||typeof input.content_type!=='string'||!Buffer.isBuffer(input.data))throw new BadRequestException('Selecciona un comprobante PDF, JPG o PNG.');
  const data=Buffer.from(input.data);
  if(!data.length||data.length>MAX_PAYMENT_RECEIPT_BYTES)throw new BadRequestException('El comprobante debe pesar como máximo 5 MB.');
  const content_type=mimeOf(data);
  const declared=input.content_type.toLowerCase();
  if(!content_type||(declared&&declared!=='application/octet-stream'&&content_type!==declared))throw new BadRequestException('El contenido del comprobante no corresponde a un PDF, JPG o PNG válido.');
  const extension=content_type==='application/pdf'?'pdf':content_type==='image/png'?'png':'jpg';
  const clean=input.file_name.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').replace(/[\ud800-\udfff]/gu,'').replace(/[\\/<>:"|?*]/g,'-').replace(/\s+/g,' ').replace(/^[. ]+|[. ]+$/g,'');
  const base=Array.from(clean.replace(/\.[^. ]+$/,'')).slice(0,90).join('').replace(/[. ]+$/,'')||'comprobante';
  return {file_name:base+'.'+extension,content_type,size:data.length,sha256:createHash('sha256').update(data).digest('hex'),data};
}
export class PaymentService {
  constructor(private store:PaymentReceiptStore,private uploadsEnabled=true){}
  private readAccess(user:Profile){if(!user.active||!['PATIENT','ADMIN'].includes(user.role))throw new ForbiddenException('Tu perfil no permite consultar comprobantes de pago.');}
  async list(user:Profile){this.readAccess(user);const page=await this.store.list(user);return this.uploadsEnabled?page:{...page,items:page.items.map(item=>({...item,can_upload:false,can_pay:false,can_withdraw:false}))};}
  async upload(user:Profile,appointmentId:unknown,requestId:unknown,input:PaymentFileInput){
    if(!user.active||user.role!=='PATIENT')throw new ForbiddenException('Solo el paciente puede adjuntar el comprobante de su pre-reserva.');
    if(!this.uploadsEnabled)throw new ForbiddenException('Este entorno permite consultas. No se pueden adjuntar comprobantes.');
    const appointment=identifier(appointmentId,'La pre-reserva',true),request=identifier(requestId,'La referencia de envío');
    const file=validatePaymentFile(input);
    if(!this.store.available())throw new ServiceUnavailableException('Todavía no se habilitaron los adjuntos en este entorno. Tu pago no ha cambiado.');
    return this.store.upload(user,appointment,request,file);
  }
  async download(user:Profile,id:unknown){this.readAccess(user);return this.store.download(user,identifier(id,'El comprobante'));}
  async withdraw(user:Profile,id:unknown,requestId:unknown){
    if(!user.active||user.role!=='PATIENT'||!this.uploadsEnabled)throw new ForbiddenException('Solo el paciente puede retirar su comprobante pendiente.');
    if(!this.store.withdraw)throw new ServiceUnavailableException('La corrección de comprobantes aún no está habilitada.');
    return this.store.withdraw(user,identifier(id,'El comprobante'),identifier(requestId,'La referencia de retiro'));
  }
}
