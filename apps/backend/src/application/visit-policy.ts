import {normalizeText} from '../calendar.js';
export const VISIT_TYPES=[
  {code:'NON_URGENT_GUIDANCE',label:'Valoración que no requiera examen físico',documents_required:false,notice:'La valoración por teleconsulta solo procede si no requiere examen físico y no hay criterios de atención presencial prioritaria ni signos de alarma.'},
  {code:'RESULTS_REVIEW',label:'Revisión de laboratorios',documents_required:true,notice:'Adjunta los resultados de laboratorio legibles antes de la cita. El chat no analiza los archivos. Si hay signos de alarma, acude a urgencias.'},
  {code:'FOLLOW_UP',label:'Consulta de control (según criterio médico)',documents_required:false,notice:'La pertinencia del control por teleconsulta depende del criterio médico y de que no requieras examen físico.'},
  {code:'REFERRALS_ORDERS',label:'Remisiones y órdenes médicas',documents_required:false,notice:'El médico determina si corresponde emitir una remisión u orden y si necesitas valoración presencial. Solicitarla no garantiza su expedición.'},
  {code:'MEDICATION_PRESCRIPTION',label:'Fórmulas de medicamentos',documents_required:false,notice:'El médico revisa la pertinencia de la fórmula. Solicitarla no garantiza su expedición ni autoriza automedicarse.'}
] as const;
// Conserva la lectura de citas históricas sin ofrecer estos motivos en nuevas solicitudes.
const LEGACY_TYPES=[
  {code:'CHRONIC_FOLLOW_UP',label:'Seguimiento de una condición crónica',documents_required:false,notice:'Las órdenes del CUS son particulares, salvo convenio vigente.'},
  {code:'GENERAL_CERTIFICATE',label:'Certificado médico general',documents_required:false,notice:'No incluye incapacidades que requieran constatación presencial.'}
] as const;
export type VisitType=typeof VISIT_TYPES[number]['code']|typeof LEGACY_TYPES[number]['code'];
export const CARE_ROUTES=[
  {code:'IN_PERSON_PRIORITY',label:'Necesito valoración presencial prioritaria'},
  {code:'EMERGENCY',label:'Presento un signo de alarma / necesito urgencias'}
] as const;
export const priorityCriteria='Dolor abdominal nuevo, persistente o localizado que necesite palpación; vómitos o diarrea persistentes, menor ingesta o disminución de la orina sin deterioro grave; fiebre con empeoramiento clínico o factores de riesgo; síntomas nuevos o empeoramiento de una enfermedad crónica que requieran signos vitales, examen físico o pruebas inmediatas; necesidad de auscultación, otoscopia, palpación, evaluación de una herida u otra exploración que no pueda resolverse a distancia; incertidumbre diagnóstica relevante o imposibilidad de obtener información confiable.';
export const emergencyCriteria='Dificultad respiratoria intensa o que empeora rápidamente, no poder hablar frases completas por falta de aire, labios azulados, pausas respiratorias o sensación de asfixia; dolor u opresión torácica nueva, intensa o persistente, especialmente con sudoración, náuseas, falta de aire, desmayo o irradiación al brazo, mandíbula o espalda; debilidad repentina de un lado del cuerpo, desviación de la boca, dificultad súbita para hablar, pérdida repentina de visión, confusión de inicio súbito, pérdida del conocimiento o convulsión nueva, prolongada o repetida sin recuperación; dolor repentino e intenso, dolor de cabeza súbito y excepcionalmente fuerte, dificultad para despertar o deterioro rápido del estado general; dolor abdominal intenso, súbito o progresivo, abdomen rígido con dolor importante, vómito con sangre, deposiciones negras o sangrado abundante, vómitos persistentes con desmayo, confusión o debilidad marcada; sangrado que no se controla, traumatismo importante especialmente con alteración de conciencia, sospecha de intoxicación o sobredosis; hinchazón de lengua o garganta, dificultad para respirar o tragar, o reacción alérgica con desmayo; intento reciente de suicidio, intención actual de hacerse daño o dañar a otra persona con riesgo inmediato, o agitación grave que comprometa la seguridad.';
export function careRouteAnswer(message:string){
  const raw=message.trim().replace(/^Tipo de cita: /,'');
  return CARE_ROUTES.find(r=>r.code===raw||normalizeText(r.label)===normalizeText(message))?.code;
}
export function careRouteReply(route:string){return route==='EMERGENCY'
  ?'No continuaré con la reserva de teleconsulta. Busca atención inmediata en urgencias; no esperes una cita de TeleCUS. Si no puedes trasladarte de forma segura, solicita ayuda al servicio local de emergencias.'
  :'No continuaré con la reserva de teleconsulta. Necesitas valoración presencial prioritaria el mismo día, según criterio médico y disponibilidad de una ruta segura. Contacta a tu prestador de salud para acceder a esa valoración. Si aparece un signo de alarma, acude inmediatamente a urgencias.';}
export type VisitPolicy={available:boolean;version:string;payments_enabled:boolean};
export const LEGACY_VISIT_POLICY:VisitPolicy={available:false,version:'0',payments_enabled:true};
export function visitType(value:unknown){return [...VISIT_TYPES,...LEGACY_TYPES].find(t=>t.code===value);}
export function visitTypeAnswer(message:string,allowBare=false):VisitType|null{
  const raw=message.trim(),code=raw.replace(/^Tipo de cita: /,'');if(VISIT_TYPES.some(t=>t.code===code))return code as VisitType;
  const text=normalizeText(message);
  if(/[?¿]/.test(message)||/\b(?:no|ni|nunca)\b/.test(text))return null;
  const contribution=text.replace(/^(?:quiero|quisiera|necesito|deseo|me gustaria)\s+(?:(?:solicitar|pedir|agendar|reservar)\s+)?(?:(?:una|mi|la)\s+)?(?:cita|consulta)\s+(?:de|para|por)\s+/,'').replace(/^(?:(?:es|seria)\s+)?(?:para|de)\s+/,'');
  if(!allowBare&&contribution===text&&!/^(?:lectura|consulta de|certificado medico|orientacion medica)\b/.test(text))return null;
  if(/^(?:remisiones?|ordenes?)(?: y ordenes)?(?: medicas)?$/.test(contribution))return 'REFERRALS_ORDERS';
  if(/^(?:formulas?(?: de medicamentos)?|receta(?: medica)?)$/.test(contribution))return 'MEDICATION_PRESCRIPTION';
  if(/^(?:(?:una|la)\s+)?(?:consulta de\s+)?(?:control|seguimiento)(?:\s+(?:medico|general))?(?: despues de valoracion presencial)?$/.test(contribution))return 'FOLLOW_UP';
  if(/^(?:(?:una|la)\s+)?(?:(?:lectura|revision|entrega|analisis)\s+de\s+)?(?:mis\s+)?(?:resultados(?:\s+de\s+(?:laboratorio|examenes))?|examenes(?:\s+de\s+laboratorio)?)$/.test(contribution))return 'RESULTS_REVIEW';
  if(/^(?:orientacion(?: medica)?(?: no urgente)?)$/.test(contribution))return 'NON_URGENT_GUIDANCE';
  return null;
}
export const visitTypeQuestion='¿Qué tipo de atención necesitas?\n'+[...VISIT_TYPES,...CARE_ROUTES].map((t,i)=>`${i+1}. ${t.label}`).join('\n');
export function financiallyCleared(a:{payment_status:string;status:string}){return a.payment_status==='VERIFIED'||a.payment_status==='NOT_REQUIRED'&&['CONFIRMED','RESCHEDULED','COMPLETED'].includes(a.status);}
