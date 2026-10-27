import type { ChatInput, Reply } from '../types.js';

export type ExpectedSlot='doctor'|'date'|'time'|'reason'|'appointment'|'request'|'option'|'confirmation';
export type DialogueMemory={recentTurns:{user:string;assistant:string}[];known:{doctor_name?:string;date?:string;time?:string}};
export type DialogueGrounding=DialogueMemory&{activeTask:string|null;expectedSlot:ExpectedSlot|null;requestedWeekday:number|null;lastQuestion:string|null;refusedField?:string|null};

export function activeDraft(state:any){
  return state.draft||(state.proposal&&new Date(state.proposal.expires_at).getTime()>Date.now()?state.proposal.payload:null);
}
export function expectedSlot(state:any):ExpectedSlot|null{
  if(state.proposal&&new Date(state.proposal.expires_at).getTime()>Date.now())return 'confirmation';
  if(state.awaiting)return state.awaiting;
  const draft=state.draft;if(!draft)return null;
  if(state.selection?.type==='doctor')return 'doctor';
  if(state.selection?.type==='requests')return 'request';
  if(state.selection?.type==='appointments')return 'appointment';
  if(['reserve','availability','reschedule'].includes(draft.intent)){
    if(!draft.date)return 'date';
    if(!draft.time&&draft.intent!=='availability')return 'time';
    if(!draft.reason&&draft.intent==='reserve')return 'reason';
  }
  return null;
}
export function carryDialogue(previous:any,next:any):DialogueMemory{
  const draft=activeDraft(next),known={...(previous?.known||{})};
  for(const key of ['doctor_name','date','time'] as const)if(draft?.[key])known[key]=draft[key];
  if(next.refusedField){const key=next.refusedField==='doctor'?'doctor_name':next.refusedField;delete known[key];}
  return {recentTurns:(previous?.recentTurns||[]).slice(-4),known};
}
export function dialogueGrounding(state:any):DialogueGrounding{
  const memory=carryDialogue(state.dialogue,state),expected=expectedSlot(state);
  return {...memory,activeTask:activeDraft(state)?.intent||null,expectedSlot:expected,
    requestedWeekday:expected==='date'?1:null,lastQuestion:state.prompt?.text?.slice(0,700)||null,refusedField:state.refusedField||null};
}
export function recordDialogue(state:any,input:ChatInput,result:Reply,reasonReceived=false):DialogueMemory{
  const memory=carryDialogue(state.dialogue,state);
  const user=input.action==='sendMessage'?(reasonReceived?'[Motivo general recibido]':input.chatInput.slice(0,400)):
    input.action==='confirm'?'[Confirmación explícita]':input.action==='dismiss'?'[Operación descartada]':'[Menú solicitado]';
  return {...memory,recentTurns:[...memory.recentTurns,{user,assistant:result.reply.slice(0,700)}].slice(-4)};
}
