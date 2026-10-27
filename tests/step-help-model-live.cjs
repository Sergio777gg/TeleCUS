// Synthetic behavioural probe: real local model, generated Node-RED prompt, complete interpretation/domain boundary.
// No private configuration, Supabase, Google, messages or appointment writes.
const fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
process.chdir(path.resolve(__dirname,'..'));
async function main(){
 const [{NodeRedInterpreter},{JobsService},{DomainService}]=await Promise.all(['adapters/interpretation','jobs','domain'].map(p=>import('../apps/backend/dist/'+p+'.js')));
 const flow=await fs.readFile('node-red/flows.json','utf8'),prepare=JSON.parse(flow).find(n=>n.id==='prepare').func;
 let modelCalls=0,writes=0;
 const transport=async(_url,options)=>{
  modelCalls++;const data=JSON.parse(options.body),context={msg:{payload:data,req:{headers:{'x-telecus-internal':'synthetic-step-check'}}},env:{get:k=>({TELECUS_INTERNAL_TOKEN:'synthetic-step-check',TELECUS_AI_MODEL:'telecus-local',OLLAMA_URL:'http://127.0.0.1:11434',TELECUS_AI_CONTEXT:'8192'})[k]}};
  const [message]=new vm.Script('(function(){'+prepare+'})()').runInNewContext(context,{timeout:2000});if(!message)throw Error('Invalid synthetic prompt');
  const response=await fetch(message.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message.payload),signal:options.signal});if(!response.ok)throw Error('Local model unavailable');
  const result=JSON.parse((await response.json()).message.content);return new Response(JSON.stringify(data.stage==='field'?{field_understanding:result}:result));
 };
 const interpreter=new NodeRedInterpreter('http://synthetic/interpret','synthetic-step-check',60000,transport),user={id:'step-probe',role:'PATIENT',active:true};
 const cases=[
  {slot:'doctor',text:'Para qué? para la cita?',kind:'explain'},
  {slot:'doctor',text:'Pero para qué debo elegir un médico?',kind:'explain'},
  {slot:'doctor',text:'Antes de escoger a alguien, me gustaría que me contaras por qué me lo pides',kind:'explain'},
  {slot:'doctor',text:'Me gustaría comprender la lógica de este paso antes de responder',kind:'explain'},
  {slot:'doctor',text:'No veo el sentido de escoger a alguien aquí',kind:'explain'},
  {slot:'date',text:'¿Qué vas a hacer con esa fecha?',kind:'explain'},
  {slot:'time',text:'¿Cómo se supone que debo escoger el turno?',kind:'explain'},
  {slot:'reason',text:'¿Para qué necesitas ese motivo?',kind:'explain'},
  {slot:'confirmation',text:'¿Qué ocurre al pulsar confirmar?',kind:'explain'},
  {slot:'doctor',text:'Quiero hablar con un humano',kind:'support'},
  {slot:'doctor',text:'No me estás entendiendo',kind:'support'},
  {slot:'reason',text:'Prefiero no dar el motivo',kind:'refuse'},
  {slot:'doctor',text:'¿Para qué sirve Python?',kind:'other'}
 ],rows=[];
 for(const [index,c]of cases.entries()){
  let state={draft:{intent:'reserve'},awaiting:c.slot,prompt:{slot:c.slot,text:({doctor:'Elige un médico por su número o nombre.',date:'¿Qué lunes prefieres?',time:'¿A qué hora?',reason:'¿Cuál es el motivo general?',confirmation:'Revisa los datos y confirma.'})[c.slot]},context:{supportOffers:1},dialogue:{recentTurns:[{user:'Necesito ayuda',assistant:'Puedes contactar al equipo por WhatsApp.'}],known:{}}};
  if(c.slot==='doctor')state.selection={type:'doctor',choices:[{label:'Médico ficticio',doctor_name:'Médico ficticio',intent:'reserve'}]};
  if(c.slot==='confirmation')state.proposal={id:crypto.randomUUID(),kind:'reserve',summary:'Operación ficticia',expires_at:new Date(Date.now()+600000).toISOString(),payload:{intent:'reserve'}};
  const sessions={load:async()=>structuredClone(state),save:async(_u,_id,next)=>{state=structuredClone(next);},lock:async()=>{}},repo={mode:'demo',doctors:async()=>[{id:'doctor-synthetic',full_name:'Médico ficticio'}],execute:async()=>{writes++;throw Error('Writes are forbidden in this probe');}},domain=new DomainService(repo,sessions,{transaction:async f=>f({})}),jobs=new JobsService({}, {},domain,{},interpreter),input={action:'sendMessage',chatInput:c.text,sessionId:'probe-'+index,requestId:crypto.randomUUID()},before=modelCalls;
  try{
   const intent=await jobs.interpret(user,input),result=await domain.process(user,input,intent),isExplanation=intent.dialogue_act==='ask'&&intent.dialogue_target===(c.slot==='confirmation'?'task':c.slot)&&!result.handoff;
   const passed=c.kind==='explain'?isExplanation:c.kind==='support'?result.handoff?.reason==='requested':c.kind==='refuse'?intent.dialogue_act==='refuse'&&!result.handoff:!isExplanation&&!result.handoff;
   rows.push({slot:c.slot,input:c.text,expected:c.kind,intent:intent.intent,act:intent.dialogue_act,target:intent.dialogue_target,modelCalls:modelCalls-before,handoff:Boolean(result.handoff),passed});
  }catch(e){rows.push({slot:c.slot,input:c.text,expected:c.kind,passed:false,error:e.name});}
  console.log(JSON.stringify(rows.at(-1)));
 }
 const report={at:new Date().toISOString(),model:'telecus-local',flowSha256:crypto.createHash('sha256').update(flow).digest('hex'),scope:'synthetic_targeted_probe_not_general_accuracy',total:rows.length,passed:rows.filter(r=>r.passed).length,modelCalls,writes,cases:rows};await fs.writeFile('docs/verification/EXPLICACIONES_DE_PASO_MODELO.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,total:report.total,modelCalls,writes}));if(report.passed!==report.total||writes)process.exitCode=1;
}
main().catch(()=>{console.error('No se pudo completar la comprobación sintética de explicaciones.');process.exitCode=1;});
