import { normalizeText } from '../calendar.js';

/** A bounded Spanish time grammar. It parses values; the domain validates opening hours. */
export function timeExpression(message:string):string|null {
  const text=normalizeText(message).replace(/[.!]+$/,'').trim();
  const words:Record<string,number>={una:1,uno:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10,once:11,doce:12};
  const match=text.match(/^(?:(?:para )?(?:a )?las?\s+)?(\d{1,2}|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)(?::(\d{2})|\s+(y media|y cuarto|menos cuarto|en punto))?\s*(am|pm|a\s*\.?\s*m\.?|p\s*\.?\s*m\.?|de la manana|de la tarde|de la noche|del mediodia)?$/);
  if(!match)return null;
  if(!match[2]&&!match[3]&&!match[4]&&!/\blas?\s/.test(text))return null;
  let hour=words[match[1]]??Number(match[1]);
  let minute=match[2]?Number(match[2]):match[3]==='y media'?30:match[3]==='y cuarto'?15:0;
  const period=match[4]?.replace(/[.\s]/g,'');
  if(period){
    if(hour<1||hour>12)return null;
    hour=hour%12+(['pm','delatarde','delmediodia'].includes(period)||period==='delanoche'&&hour>=6&&hour<12?12:0);
  }else if(hour>=1&&hour<=4&&!/^0\d/.test(match[1]))hour+=12;
  if(match[3]==='menos cuarto'){hour=(hour+23)%24;minute=45;}
  return String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0');
}
