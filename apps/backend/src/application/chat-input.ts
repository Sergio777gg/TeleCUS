import { BadRequestException } from '@nestjs/common';
import type { ChatInput } from '../types.js';
export function validateInput(body:any):ChatInput {
  if(!body || typeof body!=='object' || Array.isArray(body)) throw new BadRequestException('Solicitud inválida.');
  const action=body.action||'sendMessage';
  if(!['sendMessage','roleOverview','confirm','dismiss'].includes(action)) throw new BadRequestException('Acción inválida.');
  if(typeof body.sessionId!=='string' || !/^[\w:-]{1,120}$/.test(body.sessionId) || typeof body.requestId!=='string' || !/^[a-f0-9-]{36}$/i.test(body.requestId)) throw new BadRequestException('Falta una conversación o solicitud válida.');
  const chatInput=typeof body.chatInput==='string'?body.chatInput.trim():'';
  if(chatInput.length>4000 || (action==='sendMessage' && !chatInput)) throw new BadRequestException('Escribe un mensaje de hasta 4000 caracteres.');
  if(body.proposalId!==undefined && (typeof body.proposalId!=='string' || !/^[a-f0-9-]{36}$/i.test(body.proposalId))) throw new BadRequestException('Confirmación inválida.');
  return {chatInput,action,sessionId:body.sessionId,requestId:body.requestId,...(body.proposalId?{proposalId:body.proposalId}:{})};
}
