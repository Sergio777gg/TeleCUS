module.exports=function contexts(roleChoices){
 const doctors=[{id:'30000000-0000-4000-8000-000000000001',full_name:'Dra. Ana López'},{id:'30000000-0000-4000-8000-000000000002',full_name:'Dr. Carlos Pérez'}];
 function context(role='PATIENT',draft=null,slot=null,question=null){return {
  role,today:'2026-10-17',timezone:'America/Bogota',doctors,draft,awaiting:slot,selection:null,pendingConfirmation:slot==='confirmation',context:{menu:{type:'menu',choices:roleChoices[role]}},
  dialogue:{activeTask:draft?.intent||null,expectedSlot:slot,requestedWeekday:slot==='date'?1:null,lastQuestion:question,known:{...(draft?.doctor_name?{doctor_name:draft.doctor_name}:{}),...(draft?.date?{date:draft.date}:{}),...(draft?.time?{time:draft.time}:{})},recentTurns:question?[{user:'Estoy gestionando mi cita',assistant:question}]:[]}
 };}
 const reschedule={intent:'reschedule',appointment_code:'TCUS-DEMO-001',doctor_name:doctors[0].full_name};
 const ambiguous=context();ambiguous.selection={type:'doctor',choices:doctors.map(d=>({label:d.full_name,doctor_name:d.full_name,intent:'reserve'}))};
 ambiguous.draft={intent:'reserve'};ambiguous.dialogue.activeTask='reserve';ambiguous.dialogue.expectedSlot='doctor';ambiguous.dialogue.lastQuestion='Elige un médico de esta lista; también existe el menú principal anterior.';
 return {empty:context(),admin:context('ADMIN'),doctor:context('DOCTOR'),ambiguous,
  date:context('PATIENT',reschedule,'date','¿Qué lunes prefieres?'),
  time:context('PATIENT',{...reschedule,date:'2026-10-19'},'time','¿A qué hora? Los horarios son 14:00, 14:30, 15:00 o 15:30, hora de Colombia.'),
  reason:context('PATIENT',{intent:'reserve',doctor_name:doctors[1].full_name,date:'2026-10-19',time:'15:00'},'reason','¿Cuál es el motivo general de tu cita? Escríbelo brevemente, sin detalles clínicos.'),
  proposal:context('PATIENT',{intent:'cancel',appointment_code:'TCUS-DEMO-001'},'confirmation','Revisa los datos de la cancelación y confirma o descarta la operación.')};
};
