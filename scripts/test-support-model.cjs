// Targeted behavioral probe: synthetic text only, generated prompt + actual local Ollama.
const fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
process.chdir(path.resolve(__dirname,'..'));
async function main(){
 const {NodeRedInterpreter}=await import('../apps/backend/dist/adapters/interpretation.js');
 const {resolveConversation,resolveInterpretation}=await import('../apps/backend/dist/conversation.js');
 const flow=await fs.readFile('node-red/flows.json','utf8'),prepare=JSON.parse(flow).find(n=>n.id==='prepare').func;
 const transport=async(_url,options)=>{
  const data=JSON.parse(options.body),context={msg:{payload:data,req:{headers:{'x-telecus-internal':'synthetic-support-check'}}},env:{get:key=>({TELECUS_INTERNAL_TOKEN:'synthetic-support-check',TELECUS_AI_MODEL:'telecus-local',OLLAMA_URL:'http://127.0.0.1:11434',TELECUS_AI_CONTEXT:'8192'})[key]}};
  const result=new vm.Script('(function(){'+prepare+'})()').runInNewContext(context,{timeout:2000}),message=result[0];
  if(!message)throw Error('Prompt preparation failed');
  const response=await fetch(message.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message.payload),signal:options.signal});
  const raw=await response.json();if(!response.ok)throw Error('Local model unavailable');
  const parsed=JSON.parse(raw.message.content);
  return new Response(JSON.stringify(data.stage==='field'?{field_understanding:parsed}:parsed));
 };
 const interpreter=new NodeRedInterpreter('http://synthetic/interpret','synthetic-support-check',60000,transport);
 const cases=[
  {id:'inconformidad_contexto',text:'Esto no me ayuda y ya estoy cansado de repetir lo mismo',slot:'reason',support:true},
  {id:'persona_solicitada',text:'Necesito que me atienda una persona de verdad',slot:null,support:true},
  {id:'fallo_reportado',text:'La página se queda trabada cada vez que intento seguir',slot:'date',support:true},
  {id:'privacidad_no_es_queja',text:'No me siento cómodo dando el motivo de la cita',slot:'reason',support:false},
  {id:'motivo_no_es_fallo',text:'Tengo dolor de cabeza',slot:'reason',support:false},
  {id:'explicacion_no_es_fallo',text:'No entiendo qué hora son las 14',slot:'time',support:false},
  {id:'asistencia_general_menu',text:'Necesito ayuda',slot:null,support:true},
  {id:'asistencia_breve',text:'Ayúdame',slot:'reason',support:true},
  {id:'persona_menu',text:'Quiero hablar con un humano',slot:null,support:true},
  {id:'reparacion_comunicacion',text:'No, no me estás entendiendo',slot:null,support:true},
  {id:'bloqueo_parafrasis',text:'Ya te lo expliqué varias veces y sigo sin poder avanzar',slot:null,support:true},
  {id:'canal_alternativo',text:'¿Me podrías poner en contacto con alguien del equipo?',slot:null,support:true},
  {id:'negativa_contacto',text:'No quiero hablar con una persona, prefiero seguir aquí',slot:null,support:false},
  {id:'otra_tarea_ayuda',text:'Necesito ayuda para elegir un médico',slot:null,support:false},
  {id:'fallo_resuelto',text:'Ya no tengo problemas con el chat',slot:null,support:false},
  {id:'menu_explicito',text:'Muéstrame las opciones del menú',slot:null,support:false}
 ],rows=[];
 for(const c of cases){
  const grounding={role:'PATIENT',today:'2026-10-18',doctors:[],selection:{type:'menu',choices:[{label:'Solicitar una cita',intent:'reserve'},{label:'Ver mis citas',intent:'list_appointments'}]},...(c.slot?{awaiting:c.slot,draft:{intent:'reserve',doctor_name:'Médico de prueba'},dialogue:{expectedSlot:c.slot,activeTask:'reserve',lastQuestion:c.slot==='reason'?'¿Cuál es el motivo general de tu cita?':c.slot==='date'?'¿Qué lunes prefieres?':'¿A qué hora?'}}:{})};
  try{const raw=await interpreter.interpret(c.text,grounding),direct=resolveConversation(c.text,grounding),result=direct||resolveInterpretation(c.text,raw,grounding),support=result.intent==='support';rows.push({id:c.id,input:c.text,expectedSupport:c.support,rawIntent:raw.intent,rawPassed:(raw.intent==='support')===c.support,resolution:direct?'server':'semantic',actualIntent:result.intent,dialogue_act:result.dialogue_act,passed:support===c.support});}catch(e){rows.push({id:c.id,passed:false,error:e.name});}
  console.log(JSON.stringify(rows[rows.length-1]));
 }
 const report={at:new Date().toISOString(),model:'telecus-local',promptSha256:crypto.createHash('sha256').update(flow).digest('hex'),passed:rows.filter(r=>r.passed).length,total:rows.length,rawPassed:rows.filter(r=>r.rawPassed).length,cases:rows,scope:'synthetic_targeted_probe_not_general_accuracy'};
 await fs.writeFile(process.argv.includes('--steps-regression')?'docs/verification/SOPORTE_AYUDA_V3_REGRESION.json':'docs/verification/SOPORTE_AYUDA_V2.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,total:report.total}));if(report.passed!==report.total)process.exitCode=1;
}
main().catch(()=>{console.error('No se pudo completar la prueba local de soporte.');process.exitCode=1;});
