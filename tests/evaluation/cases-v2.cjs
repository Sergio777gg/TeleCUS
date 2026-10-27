// New diagnostic variants, authored before measuring this version.
// v1 is retained byte-for-byte so matched-case comparisons remain possible.
const baseline=require('./cases-v1.cjs');
const extra=[
 ['N01','privacy-refusal','reason','Quisiera reservarme esa información y hablarla durante la consulta',{intent:['reserve','unknown'],fields:{reason:null,dialogue_act:'refuse',dialogue_target:'reason'}},'critical'],
 ['N02','privacy-refusal','reason','Me incomoda dar detalles en este chat, aunque sí deseo continuar',{notIntent:['deny','cancel'],fields:{reason:null,dialogue_act:'refuse',dialogue_target:'reason'}},'critical'],
 ['N03','text-integrity','reason','Revisión periódica',{intent:['reserve'],fields:{reason:'Revisión periódica',dialogue_act:'answer'}}],
 ['N04','time','time','Quise decir a las dos y cuarto de la tarde',{intent:['reschedule'],fields:{time:'14:15',dialogue_act:'correct'}}],
 ['N05','time','time','A las cuatro menos cuarto de la tarde',{intent:['reschedule'],fields:{time:'15:45'}}],
 ['N06','negation','reason','No quiero seguir con la reserva, dejémosla por ahora',{intent:['deny'],fields:{reason:null,dialogue_target:'task'}},'critical'],
 ['N07','social','date','Gracias por acompañarme, ¿cómo te ha ido?',{intent:['greeting'],fields:{reason:null,dialogue_act:'social'}}],
 ['N08','repair','time','Todavía no he decidido la hora; conserva lo que llevamos',{notIntent:['cancel','deny'],fields:{time:null,reason:null}}]
].map(([id,capability,context,message,expect,severity='major'])=>({id,type:'MFT',capability,context,message,expect,severity,origin:'new-synthetic-v2'}));
const flows=[
 {id:'G01',capability:'privacy-recovery',user:'otherPatient',setup:'reason',severity:'critical',steps:[
  {text:'Quisiera reservarme esa información y hablarla durante la consulta',check:{noReason:true,noProposal:true,task:'reserve',audit:0}},
  {text:'Aún prefiero hablarlo en persona',check:{noReason:true,noProposal:true,task:'reserve',notSameReply:true,audit:0}},
  {text:'Entonces pon consulta general',check:{reason:'consulta general',proposal:'reserve',audit:0}},
  {action:'confirm',check:{appointments:1,payment:'PENDING',audit:1}}
 ]},
 {id:'G02',capability:'temporal-meaning',user:'patient',steps:[
  {text:'Reprogramar mi cita',check:{slot:'date'}},{text:'El siguiente',check:{slot:'time',date:'$DATE'}},
  {text:'A las dos y media de la tarde',check:{proposal:'reschedule',time:'14:30',date:'$DATE',audit:0}}
 ]},
 {id:'G03',capability:'typed-choice',user:'otherPatient',steps:[
  {text:'Solicitar una cita',check:{slot:'doctor'}},{text:'ana lopez',check:{slot:'date',task:'reserve',audit:0}}
 ]},
 {id:'G04',capability:'refusal-scope',user:'otherPatient',setup:'reason',severity:'critical',steps:[
  {text:'Quisiera mantenerlo reservado',check:{noReason:true,noProposal:true,task:'reserve',audit:0}},
  {text:'Mejor dejemos toda la reserva por ahora',check:{noProposal:true,audit:0,notSameReply:true}}
 ]}
];
module.exports={version:'telecus-checklist-v2',cases:[...baseline.cases,...extra],flows:[...baseline.flows,...flows]};
