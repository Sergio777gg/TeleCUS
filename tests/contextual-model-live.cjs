// Explicit local integration: Nest API, in-memory demo DB, generated Node-RED
// functions in a VM, and the real installed Ollama model. The Node-RED engine
// and its HTTP transport are not covered by this test. No Google or Supabase.
require('reflect-metadata');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto');
require('../scripts/runtime-env.cjs')();
let app,jobs,db,phase='startup',modelCalls=0;
const token=randomBytes(32).toString('hex'),secret=randomBytes(32).toString('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const ollama=new URL(process.env.OLLAMA_URL||'http://127.0.0.1:11434');if(!['127.0.0.1','localhost','[::1]'].includes(ollama.hostname))throw Error('Local model required');
 const flows=JSON.parse(fs.readFileSync('node-red/flows.json','utf8'));
 const settings={TELECUS_INTERNAL_TOKEN:token,OLLAMA_URL:ollama.href.replace(/\/$/,''),TELECUS_AI_MODEL:process.env.TELECUS_AI_MODEL||'telecus-local',TELECUS_AI_CONTEXT:8192};
 const fn=id=>vm.runInNewContext('(function(msg){'+flows.find(n=>n.id===id).func+'})',{env:{get:key=>settings[key]}});
 const prepare=fn('prepare'),parse=fn('parse');
 assert.equal(prepare({req:{headers:{}},payload:{}})[1].statusCode,401);
 async function generatedTransport(endpoint,options){
  const msg=prepare({req:{headers:{'x-telecus-internal':options.headers['X-TeleCUS-Internal']}},payload:JSON.parse(options.body)})[0];
  assert.ok(msg);modelCalls++;
  const response=await fetch(msg.url,{method:'POST',headers:msg.headers,body:JSON.stringify(msg.payload),signal:AbortSignal.timeout(120000)});
  const result=parse({statusCode:response.status,payload:await response.json()});
  console.log(JSON.stringify({modelCase:modelCalls,intent:result.payload.intent,act:result.payload.dialogue_act,time:result.payload.time,dateExpression:result.payload.date_expression}));
  return new Response(JSON.stringify(result.payload),{status:result.statusCode});
 }
 const [{NestFactory},{ApiModule},{Database},{Repository},{DomainService},{AuthService},{JobsService},{SqlSessionRepository},{NodeRedInterpreter},{calendarAnswer}]=await Promise.all([
  import('@nestjs/core'),import('../apps/backend/dist/http/app.module.js'),...['database','repository','domain','auth','jobs','adapters/sessions','adapters/interpretation','calendar'].map(p=>import('../apps/backend/dist/'+p+'.js'))
 ]);
 const interpreter=new NodeRedInterpreter('http://fictional.test/interpret',token,120000,generatedTransport);
 phase='real model contract';
 const context={role:'PATIENT',today:'2026-10-17',timezone:'America/Bogota',draft:{intent:'reschedule'},selection:null,
  dialogue:{activeTask:'reschedule',expectedSlot:'date',requestedWeekday:1,lastQuestion:'¿Qué lunes prefieres?',known:{},recentTurns:[{user:'Quiero cambiar la fecha de mi cita',assistant:'¿Qué lunes prefieres?'}]}};
 for(const message of ['El próximo','Si puedes, el siguiente']){
  const result=await interpreter.interpret(message,context);assert.equal(result.intent,'reschedule');assert.equal(result.dialogue_act,'answer');assert.equal(calendarAnswer(result.date_expression,context.today,1),'2026-10-19');
  console.log('Modelo local: respuesta contextual validada.');
 }
 const cfg={mode:'demo',databaseUrl:'',databaseFile:':memory:',demoSecret:secret,internalToken:token,worker:true,modelTimeoutMs:120000};
 db=new Database('',':memory:');await db.initialize();const repo=new Repository(db,cfg);await repo.seed();
 const domain=new DomainService(repo,new SqlSessionRepository(db),db),identity=new AuthService(db,cfg);jobs=new JobsService(db,cfg,domain,identity,interpreter);jobs.start();
 const bindings={identity,chat:jobs,notifications:{list:async()=>({items:[],unread:0,next_cursor:null}),read:async()=>({updated:0})},deliveries:{list:async()=>[]},system:{configuration:()=>({mode:'demo'}),health:async()=>({status:'ok',mode:'demo'})}};
 app=await NestFactory.create(ApiModule.register(bindings),{logger:false});await app.listen(0,'127.0.0.1');const api=await app.getUrl();
 async function request(url,auth,body){const r=await fetch(api+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,result:await r.json()};}
 const patient=(await request('/api/auth/demo',null,{role:'PATIENT'})).result.token,admin=(await request('/api/auth/demo',null,{role:'ADMIN'})).result.token;
 async function turn(auth,text,session){
  const queued=await request('/api/chat/jobs',auth,{action:'sendMessage',chatInput:text,sessionId:session,requestId:randomUUID()});assert.equal(queued.status,202);
  for(let n=0;n<600;n++){const job=await request('/api/chat/jobs/'+queued.result.id,auth);if(job.result.status==='done')return job.result.result;if(job.result.status==='failed')throw Error('Demo dialogue failed');await sleep(250);}throw Error('Demo dialogue timeout');
 }
 phase='concurrent API dialogue';const patientSession=randomUUID(),adminSession=randomUUID();
 for(const [auth,session]of [[patient,patientSession],[admin,adminSession]])assert.match((await turn(auth,'Reprogramar mi cita',session)).reply,/Qué lunes/);
 const dates=await Promise.all([turn(patient,'El próximo',patientSession),turn(admin,'Si puedes, el siguiente',adminSession)]);
 for(const result of dates)assert.match(result.reply,/qué hora/i);
 const time=await turn(patient,'Mejor a las tres',patientSession);assert.ok(time.proposal,time.reply);assert.equal(time.proposal.kind,'reschedule');assert.match(time.proposal.summary,/3:00/);
 const other=await turn(admin,'a las 3:30',adminSession);assert.equal(other.proposal.kind,'reschedule');assert.match(other.proposal.summary,/3:30/);assert.notEqual(time.proposal.id,other.proposal.id);
 assert.equal((await db.query('SELECT count(*) AS n FROM telecus_audit'))[0].n,0);
 console.log(JSON.stringify({status:'ok',realLocalInference:true,modelCalls,nodeRedFunctions:'VM',nodeRedEngineTested:false,concurrentUsers:2,appointmentsChanged:0,calendarCalls:0,emailsSent:0}));
}
main().catch(error=>{console.error('Falló la prueba contextual en '+phase+': '+(error.code||error.message?.slice(0,180)||error.name));process.exitCode=1;}).finally(async()=>{await jobs?.stop();await app?.close();await db?.close();});
