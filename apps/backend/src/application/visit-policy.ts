import {normalizeText} from '../calendar.js';
export const VISIT_TYPES=[
  {code:'FOLLOW_UP',label:'Control después de valoración presencial',documents_required:false,notice:'El control requiere una valoración presencial previa. El equipo revisará si tu motivo puede atenderse por entrevista, documentos y video.'},
  {code:'RESULTS_REVIEW',label:'Lectura de resultados de exámenes',documents_required:true,notice:'Para revisar resultados previamente solicitados, adjunta antes de la cita los laboratorios, imágenes o informes en formato legible. El chat no analiza esos archivos.'},
  {code:'NON_URGENT_GUIDANCE',label:'Orientación médica no urgente',documents_required:false,notice:'Esta atención es para orientación no urgente. El médico registra las recomendaciones y decide si corresponde una consulta presencial u otra ruta de atención.'},
  {code:'CHRONIC_FOLLOW_UP',label:'Seguimiento de una condición crónica',documents_required:false,notice:'El personal de salud debe revisar si el seguimiento puede hacerse a distancia. Puede requerirse otra ruta si necesitas signos vitales, examen físico, un ajuste complejo o medicamentos por EPS. Las órdenes del CUS son particulares, salvo convenio vigente.'},
  {code:'GENERAL_CERTIFICATE',label:'Certificado médico general',documents_required:false,notice:'Solicitarlo no garantiza su expedición: depende del criterio médico y de que no se necesite examen físico presencial. No incluye valoraciones ocupacionales, ingreso o aptitud laboral, ni incapacidades que requieran constatación presencial.'}
] as const;
export type VisitType=typeof VISIT_TYPES[number]['code'];
export type VisitPolicy={available:boolean;version:string;payments_enabled:boolean};
export const LEGACY_VISIT_POLICY:VisitPolicy={available:false,version:'0',payments_enabled:true};
export function visitType(value:unknown){return VISIT_TYPES.find(t=>t.code===value);}
export function visitTypeAnswer(message:string,allowBare=false):VisitType|null{
  const raw=message.trim(),code=raw.replace(/^Tipo de cita: /,'');if(visitType(code))return code as VisitType;
  const text=normalizeText(message);
  if(/[?¿]/.test(message)||/\b(?:no|ni|nunca)\b/.test(text))return null;
  const contribution=text.replace(/^(?:quiero|quisiera|necesito|deseo|me gustaria)\s+(?:(?:solicitar|pedir|agendar|reservar)\s+)?(?:(?:una|mi|la)\s+)?(?:cita|consulta)\s+(?:de|para|por)\s+/,'').replace(/^(?:(?:es|seria)\s+)?(?:para|de)\s+/,'');
  if(!allowBare&&contribution===text&&!/^(?:lectura|consulta de|certificado medico|orientacion medica)\b/.test(text))return null;
  if(/^(?:seguimiento|control)(?: de)? (?:una |mi )?(?:condicion|enfermedad) cronica$/.test(contribution))return 'CHRONIC_FOLLOW_UP';
  if(/^(?:(?:una|la)\s+)?(?:consulta de\s+)?(?:control|seguimiento)(?:\s+(?:medico|general))?(?: despues de valoracion presencial)?$/.test(contribution))return 'FOLLOW_UP';
  if(/^(?:(?:una|la)\s+)?(?:(?:lectura|revision|entrega|analisis)\s+de\s+)?(?:mis\s+)?(?:resultados(?:\s+de\s+(?:laboratorio|examenes))?|examenes(?:\s+de\s+laboratorio)?)$/.test(contribution))return 'RESULTS_REVIEW';
  if(/^(?:orientacion(?: medica)?(?: no urgente)?)$/.test(contribution))return 'NON_URGENT_GUIDANCE';
  if(/^(?:un )?certificado medico(?: general)?$/.test(contribution))return 'GENERAL_CERTIFICATE';
  return null;
}
export const visitTypeQuestion='¿Qué tipo de atención necesitas?\n'+VISIT_TYPES.map((t,i)=>`${i+1}. ${t.label}`).join('\n')+'\n\nLa solicitud requiere revisión de su pertinencia para teleconsulta. La teleconsulta no atiende urgencias. Si tu necesidad no encaja o no sabes cuál elegir, pide orientación al equipo de TeleCUS.';
export function financiallyCleared(a:{payment_status:string;status:string}){return a.payment_status==='VERIFIED'||a.payment_status==='NOT_REQUIRED'&&['CONFIRMED','RESCHEDULED','COMPLETED'].includes(a.status);}
