import {BadRequestException} from '@nestjs/common';
export type ServiceSchedule={version:string;effective_from:string;days:number[];start:string;end:string;minutes:30;timezone:'America/Bogota';hold_hours:number};
export type ScheduleBook={version:string;items:ServiceSchedule[]};
export const DEFAULT_SCHEDULE:ServiceSchedule={version:'1',effective_from:'2000-01-01',days:[1],start:'14:00',end:'16:00',minutes:30,timezone:'America/Bogota',hold_hours:24};
export const DEFAULT_SCHEDULE_BOOK:ScheduleBook={version:'1',items:[DEFAULT_SCHEDULE]};
export const weekdayNames=['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
export const localDay=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota'}).format(new Date());
export const scheduleFor=(book:ScheduleBook,date=localDay())=>book.items.filter(p=>p.effective_from<=date).sort((a,b)=>b.effective_from.localeCompare(a.effective_from)||Number(b.version)-Number(a.version))[0]||DEFAULT_SCHEDULE;
export const minutesOf=(time:string)=>Number(time.slice(0,2))*60+Number(time.slice(3));
export const scheduleTimes=(p:ServiceSchedule)=>Array.from({length:(minutesOf(p.end)-minutesOf(p.start))/30},(_,i)=>{const n=minutesOf(p.start)+i*30;return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');});
export const dayNames=(p:ServiceSchedule)=>p.days.map(d=>weekdayNames[d]).join(', ');
export function validServiceDay(date:string,p:ServiceSchedule){const d=new Date(date+'T12:00:00-05:00');return /^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===date&&p.days.includes(d.getUTCDay());}
export function schedulePayload(p:Record<string,unknown>,today=localDay()){
  const days=p.days,start=p.start,end=p.end,effective_from=p.effective_from;
  if(!Number.isInteger(p.hold_hours)||Number(p.hold_hours)<1||Number(p.hold_hours)>168)throw new BadRequestException('El plazo de la pre-reserva debe estar entre 1 y 168 horas.');
  if(!Array.isArray(days)||!days.length||days.length>7||days.some(d=>!Number.isInteger(d)||d<0||d>6)||new Set(days).size!==days.length||typeof start!=='string'||typeof end!=='string'||![start,end].every(t=>/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(t))||minutesOf(end)<=minutesOf(start)||typeof effective_from!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(effective_from)||!validServiceDay(effective_from,{...DEFAULT_SCHEDULE,days:[0,1,2,3,4,5,6]})||effective_from<today)
    throw new BadRequestException('Selecciona días, una franja válida en intervalos de 30 minutos y una fecha de vigencia desde hoy.');
  return {days:[...days].sort((a,b)=>a-b),start,end,effective_from,minutes:30,timezone:'America/Bogota',hold_hours:p.hold_hours};
}

export function operatingHoursQuestion(text:string){const t=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();return !/\b(?:cambiar|editar|modificar|configurar|actualizar)\b/.test(t)&&/horarios?|dias? de atencion|cuando atienden|que dias? (?:atienden|hay citas|puedo agendar)/.test(t);}
