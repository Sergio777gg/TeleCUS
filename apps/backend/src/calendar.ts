export const normalizeText=(text:string)=>text.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').replace(/^[¡¿]+|[.!?¡¿]+$/g,'').trim();
const months=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const dayWords=['uno','dos','tres','cuatro','cinco','seis','siete','ocho','nueve','diez','once','doce','trece','catorce','quince','dieciseis','diecisiete','dieciocho','diecinueve','veinte','veintiuno','veintidos','veintitres','veinticuatro','veinticinco','veintiseis','veintisiete','veintiocho','veintinueve','treinta','treinta y uno'];
function validDate(year:number,month:number,day:number){
  if(year<1900||year>9999||month<1||month>12||day<1||day>31)return null;
  const value=String(year)+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0'),date=new Date(value+'T12:00:00Z');
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value?value:null;
}
const weekdays=['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];

/** Interpret calendar expressions against a server-owned date; the model never does date arithmetic. */
export function calendarAnswer(expression:string,today?:string,expectedWeekday?:number|null):string|null {
  const text=normalizeText(expression).replace(/\bprox\.?(?=\s|$)/g,'proximo').replace(/^(?:para )?(?:el )?(?:dia )?/,'');
  const explicit=text.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(explicit)return validDate(Number(explicit[1]),Number(explicit[2]),Number(explicit[3]));
  const numeric=text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);if(numeric)return validDate(Number(numeric[3]),Number(numeric[2]),Number(numeric[1]));
  const written=text.match(/^(?:(domingo|lunes|martes|miercoles|jueves|viernes|sabado)[, ]+)?(.+?) de ([a-z]+)(?: (?:de |del )?(\d{4}))?$/);
  if(written){
    const day=/^\d{1,2}$/.test(written[2])?Number(written[2]):written[2]==='primero'?1:dayWords.indexOf(written[2])+1;
    // An omitted year means this calendar year; never silently move a past request to next year.
    const year=written[4]?Number(written[4]):Number(today?.slice(0,4));
    const value=validDate(year,months.indexOf(written[3])+1,day);
    if(!value||written[1]&&new Date(value+'T12:00:00Z').getUTCDay()!==weekdays.indexOf(written[1]))return null;
    return value;
  }
  if(!/^\d{4}-\d{2}-\d{2}$/.test(today||''))return null;
  const date=new Date(today+'T12:00:00Z');
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==today)return null;
  if(['hoy','manana','pasado manana'].includes(text)){date.setUTCDate(date.getUTCDate()+['hoy','manana','pasado manana'].indexOf(text));return date.toISOString().slice(0,10);}
  const relative=/^(?:proximo|siguiente|mas cercano|mas proximo|que viene|de la (?:proxima|siguiente) semana)$/;
  const words=text.split(' '),weekday=words.find(w=>weekdays.includes(w))||
    (typeof expectedWeekday==='number'&&Number.isInteger(expectedWeekday)&&expectedWeekday>=0&&expectedWeekday<=6&&relative.test(text)?weekdays[expectedWeekday]:undefined);
  if(!weekday)return null;
  const qualifier=text.replace(weekday,'').trim();
  if(!qualifier&&!/^(?:para )?el (?:dia )?(?:domingo|lunes|martes|miercoles|jueves|viernes|sabado)$/.test(normalizeText(expression)))return null;
  if(qualifier&&!relative.test(qualifier))return null;
  const target=weekdays.indexOf(weekday);
  let days=(target-date.getUTCDay()+7)%7||7;
  if(qualifier.startsWith('de la '))days=((8-date.getUTCDay())%7||7)+(target+6)%7;
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}
