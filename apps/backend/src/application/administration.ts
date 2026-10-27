import {BadRequestException,ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import type {Profile,Role} from '../types.js';
import type {AdministrationStore,KnowledgeCatalog} from '../ports/administration.js';
import {schedulePayload} from './service-schedule.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DEFAULT_PORTAL={version:'0',payment_url:'https://pagosonline.sirec.unicauca.edu.co/',support_phone:'573148336862',payments_enabled:true,visit_workflow_available:false};
export function normalizedSupportPhone(value:unknown){
  if(typeof value!=='string')throw new BadRequestException('Escribe un número de soporte válido.');
  const digits=value.replace(/[\s()+-]/g,'');
  const result=digits.length===10?'57'+digits:digits;
  if(!/^[1-9]\d{10,14}$/.test(result))throw new BadRequestException('Usa el número con código de país, por ejemplo +57 y el número colombiano.');
  return result;
}
export function paymentUrl(value:unknown){
  try{
    if(typeof value!=='string'||value.length>1000)throw Error();
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname))throw Error();
    return url.href;
  }catch{throw new BadRequestException('El enlace de pago debe ser HTTPS, sin credenciales, puertos ni fragmentos.');}
}
function text(value:unknown,label:string,max=120){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f]/.test(value))throw new BadRequestException(label+' no válido.');return value.trim();}
function content(value:unknown){if(typeof value!=='string'||value.trim().length<10||value.length>20000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw new BadRequestException('El contenido debe tener entre 10 y 20000 caracteres válidos.');return value.trim();}
function id(value:unknown){if(typeof value!=='string'||!uuid.test(value))throw new BadRequestException('Referencia no válida.');return value;}
export class AdministrationService {
  constructor(private store:AdministrationStore,private catalog:KnowledgeCatalog,private writable=true){}
  private access(user:Profile,write=false){if(!user.active||user.role!=='ADMIN')throw new ForbiddenException('Esta gestión requiere el rol administrativo.');if(!this.store.available())throw new ServiceUnavailableException('El panel administrativo aún no está habilitado en esta base.');if(write&&!this.writable)throw new ForbiddenException('Este entorno solo permite consultas.');}
  async read(user:Profile,resource:string,filter:Record<string,unknown>={}){
    this.access(user);if(!['people','registrations','settings','knowledge','payments','schedule'].includes(resource))throw new BadRequestException('Sección administrativa desconocida.');
    const offset=filter.offset===undefined?0:Number(filter.offset);if(!Number.isInteger(offset)||offset<0||offset>100000)throw new BadRequestException('Página no válida.');
    const role=filter.role||'PATIENT';if(!['PATIENT','DOCTOR'].includes(String(role)))throw new BadRequestException('Rol no válido.');
    const view=filter.view===undefined?'received':String(filter.view);if(resource==='payments'&&!['received','awaiting','processing','history'].includes(view))throw new BadRequestException('Bandeja de pagos no válida.');
    const q=typeof filter.q==='string'?filter.q.trim().slice(0,80):'';
    return this.store.read(user,resource,{offset,role,q,view,...(typeof filter.file==='string'?{file:filter.file}:{})});
  }
  async write(user:Profile,input:{requestId?:unknown;resource?:unknown;expected?:unknown;payload?:unknown}){
    this.access(user,true);const requestId=id(input.requestId),resource=String(input.resource),expected=typeof input.expected==='string'?input.expected:'new';
    if(!input.payload||typeof input.payload!=='object'||Array.isArray(input.payload))throw new BadRequestException('Datos administrativos no válidos.');
    const p=input.payload as Record<string,unknown>;let payload:Record<string,unknown>;
    if(resource==='schedule')payload=schedulePayload(p);
    else if(resource==='settings'){
      if(p.payments_enabled!==undefined&&typeof p.payments_enabled!=='boolean')throw new BadRequestException('Indica si se requiere pago para nuevas citas.');
      if(p.payments_enabled!==undefined&&!(await this.store.settings()).visit_workflow_available)throw new ServiceUnavailableException('La modalidad de piloto requiere la actualización de la base de datos.');
      payload={payment_url:paymentUrl(p.payment_url),support_phone:normalizedSupportPhone(p.support_phone),...(p.payments_enabled!==undefined?{payments_enabled:p.payments_enabled}:{})};
    }
    else if(resource==='profile'||resource==='registration'){
      if(!['PATIENT','DOCTOR'].includes(String(p.role)))throw new BadRequestException('Solo se gestionan pacientes y médicos desde este formulario.');
      payload={full_name:text(p.full_name,'El nombre'),role:p.role};
      if(resource==='profile'){if(typeof p.active!=='boolean')throw new BadRequestException('Indica si la cuenta está activa.');payload={...payload,id:id(p.id),active:p.active};}
      else {const email=text(p.email,'El correo',254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new BadRequestException('Correo no válido.');payload={...payload,email};}
    }else if(resource==='registration_cancel')payload={id:id(p.id)};
    else if(resource==='knowledge_save'){
      const file=text(p.file,'El documento',100),body=content(p.body);this.catalog.validate(file,body);payload={file,body};
    }else if(resource==='knowledge_publish'){
      const file=text(p.file,'El documento',100),revision_id=id(p.revision_id),detail=await this.store.read(user,'knowledge',{file});
      const revision=detail.versions?.find((v:any)=>v.id===revision_id);if(!revision)throw new BadRequestException('La versión ya no está disponible para publicar.');
      this.catalog.validate(file,revision.body);payload={file,revision_id};
    }else throw new BadRequestException('Operación administrativa desconocida.');
    return this.store.write(user,requestId,resource,expected,payload);
  }
  preview(user:Profile,input:{file?:unknown;body?:unknown;query?:unknown;role?:unknown}){
    this.access(user);if(!['PATIENT','DOCTOR','ADMIN'].includes(String(input.role)))throw new BadRequestException('Audiencia no válida.');
    const file=text(input.file,'El documento',100),body=content(input.body),query=text(input.query,'La pregunta',500);this.catalog.validate(file,body);
    return this.catalog.preview(file,body,query,input.role as Role);
  }
  async prepareReview(user:Profile,appointmentId:unknown,requestId:unknown){this.access(user,true);const appointment=this.store.demo&&typeof appointmentId==='string'&&/^demo-appointment-\d{1,6}$/.test(appointmentId)?appointmentId:id(appointmentId);return this.store.prepareReview(user,appointment,id(requestId));}
  async confirmReview(user:Profile,reviewId:unknown,verified:unknown){this.access(user,true);if(verified!==true)throw new BadRequestException('Confirma que contrastaste el pago con el recaudo institucional.');return this.store.confirmReview(user,id(reviewId));}
}
