// The user-reported failure and capability variants; existing v1/v2 oracles are unchanged.
const previous=require('./cases-v2.cjs');
const cases=[
 ['Q01','time-explanation','time','q ora son las 14?',{intent:['unknown'],fields:{dialogue_act:'ask',dialogue_target:'time',reference_time:'14:00',time:null,reason:null}}],
 ['Q02','time-explanation','reason','Pero q oran son las 14?',{intent:['unknown'],fields:{dialogue_act:'ask',dialogue_target:'time',reference_time:'14:00',time:null,reason:null}}],
 ['Q03','abandon-typo','reason','Nono, cansela',{intent:['deny'],fields:{dialogue_target:'task',reason:null}}],
 ['Q04','abandon-proposal','proposal','Nono',{intent:['deny'],fields:{dialogue_target:'task',reason:null}}],
 ['Q05','negated-control','reason','No canceles, solo estoy preguntando',{notIntent:['deny','cancel'],fields:{reason:null}}],
 ['Q06','text-integrity','reason','Dolor de cabeza',{intent:['reserve'],fields:{reason:'Dolor de cabeza'}}],
 ['Q07','time-explanation','time','cómo se lee 15:30',{intent:['unknown'],fields:{dialogue_act:'ask',reference_time:'15:30',time:null}}],
 ['Q08','question-not-value','time','¿Las 14 están libres?',{notIntent:['reserve','deny','cancel'],fields:{time:null,reason:null}}]
].map(([id,capability,context,message,expect])=>({id,type:'MFT',capability,context,message,expect,severity:'critical',origin:'user-report-and-new-variants-v3'}));
const flows=[
 {id:'H01',capability:'reported-conversation',user:'otherPatient',severity:'critical',steps:[
  {text:'Solicitar una cita',check:{slot:'doctor'}},{text:'Dra. Ana López',check:{slot:'date'}},
  {text:'el prosimo lune',check:{slot:'time',date:'$DATE'}},
  {text:'q ora son las 14?',check:{slot:'time',time:null,date:'$DATE',noProposal:true,contains:'2:00 p',audit:0}},
  {text:'Pero q oran son las 14?',check:{slot:'time',time:null,date:'$DATE',noProposal:true,contains:'2:00 p',audit:0}},
  {text:'Nono, cansela',check:{task:null,noProposal:true,appointments:0,audit:0}}
 ]},
 {id:'H02',capability:'question-during-reason',user:'otherPatient',setup:'reason',severity:'critical',steps:[
  {text:'qué significa 15:30',check:{slot:'reason',time:'14:30',noReason:true,noProposal:true,contains:'3:30 p',audit:0}},
  {text:'Nono, cansela',check:{task:null,noProposal:true,appointments:0,audit:0}}
 ]},
 {id:'H03',capability:'negation-and-recovery',user:'otherPatient',setup:'reason',severity:'critical',steps:[
  {text:'No canceles, solo estoy preguntando',check:{task:'reserve',noReason:true,noProposal:true,audit:0}},
  {text:'Revisión periódica',check:{reason:'Revisión periódica',proposal:'reserve',audit:0}},
  {action:'dismiss',check:{task:null,noProposal:true,audit:0}}
 ]},
 {id:'H04',capability:'question-during-proposal',user:'patient',severity:'critical',steps:[
  {text:'Cancelar mi cita',check:{proposal:'cancel',audit:0}},
  {text:'¿Cómo se lee 15:00?',check:{proposal:'cancel',sameProposal:true,contains:'3:00 p',audit:0}},
  {text:'Nono',check:{task:null,noProposal:true,appointmentStatus:'PRE_RESERVED',audit:0}}
 ]},
 {id:'H05',capability:'question-before-choice',user:'patient',severity:'critical',steps:[
  {text:'Reprogramar mi cita',check:{slot:'date'}},{text:'El próximo',check:{slot:'time',date:'$DATE'}},
  {text:'¿Las 14 están libres?',check:{slot:'time',time:null,date:'$DATE',noProposal:true,audit:0}},
  {text:'14:30',check:{proposal:'reschedule',time:'14:30',date:'$DATE',audit:0}}
 ]},
 {id:'H06',capability:'abandon-variant',user:'otherPatient',setup:'reason',severity:'critical',steps:[
  {text:'mejor descata la gestión',check:{task:null,noProposal:true,appointments:0,audit:0}}
 ]}
];
module.exports={version:'telecus-checklist-v3',cases:[...previous.cases,...cases],flows:[...previous.flows,...flows]};
