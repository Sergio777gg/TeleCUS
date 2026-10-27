// Privacy vs health, conversational interruptions and read-only scheduling questions.
// Earlier corpora and their oracles are retained without edits.
const previous=require('./cases-v3.cjs');
const rows=[
 ['S01','social','empty','Cómo estas?',{intent:['greeting'],fields:{dialogue_act:'social',reason:null}},'major'],
 ['S02','service-retrieval','empty','Qué servicios hay?',{intent:['knowledge'],fields:{reason:null}},'major'],
 ['S03','privacy-refusal','reason','No quiero decirlo',{fields:{dialogue_act:'refuse',dialogue_target:'reason',reason:null}}],
 ['S04','privacy-refusal','reason','No me siento cómo diciéndolo',{fields:{dialogue_act:'refuse',dialogue_target:'reason',reason:null}}],
 ['S05','privacy-refusal','reason','Es algo personal',{fields:{dialogue_act:'refuse',dialogue_target:'reason',reason:null}}],
 ['S06','health-not-refusal','reason','No me siento bien',{intent:['reserve'],fields:{reason:'No me siento bien',dialogue_act:'answer'}}],
 ['S07','health-not-refusal','reason','Me duele al orinar',{intent:['reserve'],fields:{reason:'Me duele al orinar'}}],
 ['S08','text-integrity','reason','Consulta general',{intent:['reserve'],fields:{reason:'Consulta general'}}],
 ['S09','time-question','date','Tipo 2:20 se puede?',{intent:['availability'],fields:{dialogue_act:'ask',reference_time:'14:20',time:null,date:null}}],
 ['S10','time-question','date','Entonces 2:30 se puede?',{intent:['availability'],fields:{dialogue_act:'ask',reference_time:'14:30',time:null,date:null}}],
 ['S11','privacy-refusal','reason','Prefiero hablar de eso cuando vea al médico',{fields:{dialogue_act:'refuse',dialogue_target:'reason',reason:null}}],
 ['S12','health-not-refusal','reason','No tengo apetito',{intent:['reserve'],fields:{reason:'No tengo apetito'}}]
].map(([id,capability,context,message,expect,severity='critical'])=>({id,type:'MFT',capability,context,message,expect,severity,origin:'reported-case-and-contrastive-variants-v4'}));
const flows=[
 {id:'J01',capability:'reported-privacy-and-service-loop',user:'otherPatient',severity:'critical',steps:[
  {text:'Hola',check:{noProposal:true,audit:0}},
  {text:'Cómo estas?',check:{contains:'Gracias por preguntar',notSameReply:true,noProposal:true,audit:0}},
  {text:'Qué servicios hay?',check:{contains:'medicina general',sources:true,noProposal:true,audit:0}},
  {text:'Qué puedo hacer?',check:{contains:'Solicitar una cita',noProposal:true}},
  {text:'Quiero solicitar una cita',check:{slot:'doctor'}},{text:'1',check:{slot:'date'}},
  {text:'Tipo 2:20 se puede?',check:{slot:'date',time:null,date:null,contains:'inicio no corresponde',noProposal:true}},
  {text:'Entonces 2:30 se puede?',check:{slot:'date',time:null,date:null,contains:'necesito el lunes',noProposal:true}},
  {text:'El siguiente',check:{slot:'time',date:'$DATE',time:null}},{text:'2:30 pm',check:{slot:'reason'}},
  {text:'No quiero decirlo',check:{slot:'reason',time:'14:30',noReason:true,noProposal:true,contains:'privado'}},
  {text:'No me siento cómo diciéndolo',check:{slot:'reason',noReason:true,noProposal:true,notSameReply:true}},
  {text:'Es algo personal',check:{slot:'reason',noReason:true,noProposal:true,audit:0}},
  {text:'Consulta general',check:{proposal:'reserve',reason:'Consulta general',appointments:0,audit:0}},
  {action:'dismiss',check:{task:null,noProposal:true,audit:0}}
 ]},
 {id:'J02',capability:'negative-health-description',user:'otherPatient',setup:'reason',severity:'critical',steps:[
  {text:'No me siento bien',check:{proposal:'reserve',reason:'No me siento bien',appointments:0,audit:0}},
  {action:'dismiss',check:{task:null,noProposal:true,audit:0}}
 ]},
 {id:'J03',capability:'privacy-and-voluntary-recovery',user:'otherPatient',setup:'reason',severity:'critical',steps:[
  {text:'Me da pena contarlo por acá',check:{noReason:true,noProposal:true,slot:'reason'}},
  {text:'Prefiero hablar de eso cuando vea al médico',check:{noReason:true,noProposal:true,slot:'reason'}},
  {text:'Control preventivo',check:{proposal:'reserve',reason:'Control preventivo',appointments:0,audit:0}}
 ]},
 {id:'J04',capability:'availability-during-existing-draft',user:'otherPatient',setup:'reason',severity:'critical',steps:[
  {text:'¿Las 14 están libres?',check:{slot:'reason',time:'14:30',contains:'según la agenda actual',noReason:true,noProposal:true,audit:0}},
  {text:'¿A las 2:20 se puede?',check:{slot:'reason',time:'14:30',contains:'inicio no corresponde',noReason:true,noProposal:true,audit:0}},
  {text:'Descarta la gestión',check:{task:null,noProposal:true,audit:0}}
 ]}
];
// Repeat the recovery scenario at different positions; these are stability
// repetitions, not two new independent scenarios.
const recovery=previous.flows.find(f=>f.id==='H03');
const repeats=[2,3].map(attempt=>({...recovery,id:'H03-repeat-'+attempt,repeatOf:'H03',attempt}));
module.exports={version:'telecus-checklist-v4',cases:[...previous.cases,...rows],flows:[...previous.flows,...flows,...repeats]};
