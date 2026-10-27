import { normalizeText } from '../calendar.js';
import { timeExpression } from './time-expression.js';

const controls=['cancela','cancelar','canceles','descarta','descartar','descartes','detener','deten','parar','dejemos','dejalo','olvida','olvidar','olvidalo','abandona','abandonar','desiste','desistir','paremos','suspende','suspender'];
function distance(a:string,b:string):number {
  const rows=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
  for(let i=0;i<=a.length;i++)rows[i][0]=i;for(let j=0;j<=b.length;j++)rows[0][j]=j;
  for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++){
    rows[i][j]=Math.min(rows[i-1][j]+1,rows[i][j-1]+1,rows[i-1][j-1]+Number(a[i-1]!==b[j-1]));
    if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])rows[i][j]=Math.min(rows[i][j],rows[i-2][j-2]+1);
  }
  return rows[a.length][b.length];
}
/** Bounded cues protect free text. They never authorize or execute a cancellation. */
export function hasControlSignal(message:string):boolean {
  return (normalizeText(message).match(/[a-z0-9]+(?:[-@.][a-z0-9]+)*/g)||[]).filter(word=>/^[a-z]+$/.test(word)).some(word=>controls.some(control=>word===control||word.length>=6&&control.length>=6&&Math.abs(word.length-control.length)<=1&&distance(word,control)<=1));
}
export function normalizedDialogueText(message:string):string {
  return normalizeText(message).replace(/\b(?:no){2,}\b/g,'no no').replace(/\b[qk]\b/g,'que').replace(/[a-z0-9]+(?:[-@.][a-z0-9]+)*/g,word=>{
    if(!/^[a-z]{6,}$/.test(word)||controls.includes(word))return word;
    const candidates=controls.filter(control=>control.length>=6&&Math.abs(word.length-control.length)<=1&&distance(word,control)<=1);
    return candidates.length===1?candidates[0]:word;
  });
}
export function controlUtterance(message:string):boolean {
  const text=normalizedDialogueText(message).replace(/^(?:(?:no|por favor|porfa|mejor|oye|entonces|ahora|quiero|quisiera|necesito|deseo|ya|simplemente)[,\s]+)+/,'');
  const first=text.match(/^[a-z]+/)?.[0];
  if(!first||!controls.includes(first))return false;
  // A verb can describe the consultation's subject rather than control this dialogue.
  if(/^(?:parar|detener)\s+de\s+\w+(?:ar|er|ir)\b/.test(text))return false;
  return true;
}
/** An isolated stop directive refers to the active draft. It cannot cancel an existing appointment. */
export function bareControl(message:string):boolean {
  const text=normalizedDialogueText(message).replace(/^(?:(?:no|por favor|porfa|mejor|oye|entonces|ahora|quiero|quisiera|necesito|deseo|ya|simplemente)[,\s]+)+/,'').replace(/[,\s]+(?:por favor|porfa)$/,'').trim();
  const explicit=text.match(/^([a-z]+)\s+(?:(?:la|esta|el|este|mi)\s+)?(?:gestion|tramite|proceso|borrador|operacion)(?:\s+(?:en curso|actual))?$/);
  return (controls.includes(text)||Boolean(explicit&&controls.includes(explicit[1])))&&abandonEvidence(message);
}
export function pureNegation(message:string):boolean {return /^(?:no[\s,!;.]*?)+$/.test(normalizedDialogueText(message));}
export function negatedControl(message:string):boolean {
  const words=normalizedDialogueText(message).match(/[a-z]+/g)||[],vetoes=['canceles','cancelar','descartes','descartar','detengas','detener','pares','parar','dejemos','olvides','abandonar','abandones','suspendas'];
  return words.some((word,i)=>word==='no'&&words.slice(i+1,i+4).some(next=>vetoes.some(veto=>next===veto||next.length>=6&&veto.length>=6&&next.at(-1)===veto.at(-1)&&distance(next,veto)<=1)));
}
/** A model label alone cannot discard session state. Unclear scope requires clarification. */
export function abandonEvidence(message:string):boolean {
  const text=normalizedDialogueText(message);
  if(informationQuestion(message)||/[?¿]/.test(message)||negatedControl(message)||/\bTCUS-[A-Z0-9]+-[A-Z0-9]+\b/i.test(message))return false;
  return controlUtterance(message)||/\bno\b(?:\W+\w+){0,3}\W+(?:continu\w*|segu\w*|sig\w*|avanc\w*)\b/.test(text);
}
export function dismissEvidence(message:string,pending:boolean):boolean {return pending&&pureNegation(message)||abandonEvidence(message);}
/** Strong information questions, independent of punctuation. Requests such as '¿puedes reservar?' remain requests. */
export function informationQuestion(message:string):boolean {
  return /^(?:(?:pero|y|entonces|oye)\s+)*(?:que|como|cual(?:es)?|cuando|donde|por que|para que|a que)\b/.test(normalizedDialogueText(message));
}
export function questionEvidence(message:string):boolean {
  return informationQuestion(message)||/[?¿]/.test(message)||/^(?:por favor\s+)?(?:explica\w*|aclara\w*|dime\s+(?:que|como|cual)|no entiendo)\b/.test(normalizedDialogueText(message));
}
/** Reference only, never a selected appointment time. */
export function referencedTime(value:string):string|null {
  const valid=(v:string|null)=>v&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v)?v:null;
  const text=normalizeText(value),direct=valid(timeExpression(text)||timeExpression('a las '+text));
  if(direct)return direct;
  const matches=[...text.matchAll(/\b(\d{1,2})(?::(\d{2}))?(?:\s*([ap])\s*\.?\s*m\.?)?\b/g)];
  if(matches.length!==1)return null;
  const m=matches[0];return valid(timeExpression('a las '+m[0]));
}

/** A question about clock notation is a read-only conversion, not a slot answer. */
export function timeExplanationReference(message:string,expectedSlot?:string|null):string|null {
  if(!informationQuestion(message))return null;
  const text=normalizedDialogueText(message),words=text.match(/[a-z]+/g)||[];
  if(/\b(?:libres?|disponib\w*|cupos?|atiend\w*|atencion|agend\w*)\b/.test(text))return null;
  const clockTopic=words.some(w=>w==='formato'||w.length>=3&&w.length<=6&&(distance(w,'hora')<=1||distance(w,'horas')<=2));
  const notation=/\b(?:significa\w*|equivale\w*|formato|lee|leer|entiend\w*)\b/.test(text);
  if(!(clockTopic&&/\b(?:son|es)\b/.test(text)||notation&&(clockTopic||expectedSlot==='time'||/\d{1,2}:\d{2}/.test(text))))return null;
  return referencedTime(message);
}

/** An explicit lack of decision is not affirmative evidence for a slot. */
export function undecidedAnswer(message:string):boolean {
 const text=normalizedDialogueText(message).replace(/[,;]+/g,' ').replace(/\s+/g,' ').trim();
 return /^(?:(?:aun|todavia) )?(?:no (?:lo )?se|no (?:estoy|lo tengo) segur[oa]|no (?:me )?he decidido)(?: (?:aun|todavia|bien))?$/.test(text);
}
