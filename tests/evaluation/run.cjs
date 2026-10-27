require('reflect-metadata');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{randomUUID,randomBytes,createHash}=require('node:crypto');
const apiOnly=process.argv.includes('--api-only');
const root=require('../../scripts/runtime-env.cjs')(),corpusName=process.argv.includes('--v4')?'cases-v4.cjs':process.argv.includes('--v3')?'cases-v3.cjs':process.argv.includes('--v2')?'cases-v2.cjs':'cases-v1.cjs',baseCorpus=require('./'+corpusName),corpus=apiOnly?{...baseCorpus,version:baseCorpus.version+'-api-only',cases:[]}:baseCorpus,{score,schemaErrors}=require('./oracles.cjs');
const sha=s=>createHash('sha256').update(s).digest('hex');
let current={phase:'setup'},activeFixture,model;
const flowsFirst=process.argv.includes('--flows-first');
async function main(){
 const [{roleChoices},{calendarAnswer},{Database},{Repository,demoIds},{DomainService},{AuthService},{JobsService},{SqlSessionRepository},{KnowledgeIndex,LocalKnowledge},{NestFactory},{ApiModule},{NotificationsService},{DatabaseNotificationInbox}]=await Promise.all([
  'conversation','calendar','database','repository','domain','auth','jobs','adapters/sessions','knowledge'
 ].map(p=>import('../../apps/backend/dist/'+p+'.js')).concat([import('@nestjs/core'),import('../../apps/backend/dist/http/app.module.js'),import('../../apps/backend/dist/notifications.js'),import('../../apps/backend/dist/adapters/notification-inbox.js')]));
 const contexts=require('./contexts.cjs')(roleChoices),calls=[];
 model=await require('./model-harness.cjs').modelHarness(call=>{calls.push({...current,...call,id:calls.length+1});if(output)save();});
 const flowOrder=flowsFirst?corpus.flows.toReversed():corpus.flows;
 const repeatIds=apiOnly?[]:['M05','M09','M11','I05b','D02b','D03a'];
 const sourceFiles=['apps/backend/src/conversation.ts','apps/backend/src/domain.ts','apps/backend/src/jobs.ts','apps/backend/src/calendar.ts','apps/backend/src/application/dialogue-state.ts','apps/backend/src/types.ts','apps/backend/src/knowledge.ts','apps/backend/src/repository.ts','apps/backend/dist/conversation.js','apps/backend/dist/domain.js','apps/backend/dist/jobs.js','apps/backend/dist/calendar.js','scripts/build-flow.cjs','node-red/flows.json','models/Telecus.Modelfile','tests/evaluation/cases-v1.cjs','tests/evaluation/contexts.cjs','tests/evaluation/oracles.cjs','tests/evaluation/model-harness.cjs','tests/evaluation/run.cjs','tests/evaluation/report.cjs',...fs.readdirSync('knowledge/telecus').map(n=>'knowledge/telecus/'+n)];
 const sources=Object.fromEntries(sourceFiles.map(p=>[p,sha(fs.readFileSync(p))]));
 for(const p of ['apps/backend/src/application/dialogue-policy.ts','apps/backend/src/application/time-expression.ts','apps/backend/src/adapters/interpretation.ts','apps/backend/dist/application/dialogue-policy.js','apps/backend/dist/application/time-expression.js','apps/backend/dist/adapters/interpretation.js',...(corpusName==='cases-v2.cjs'?['tests/evaluation/cases-v2.cjs']:[])])sources[p]=sha(fs.readFileSync(p));
 for(const p of ['apps/backend/src/application/language-signals.ts','apps/backend/dist/application/language-signals.js',...(corpusName==='cases-v3.cjs'?['tests/evaluation/cases-v2.cjs','tests/evaluation/cases-v3.cjs']:[])])sources[p]=sha(fs.readFileSync(p));
 if(corpusName==='cases-v4.cjs')for(const p of ['tests/evaluation/cases-v2.cjs','tests/evaluation/cases-v3.cjs','tests/evaluation/cases-v4.cjs','apps/backend/src/application/appointments.ts','apps/backend/dist/application/appointments.js','apps/backend/dist/knowledge.js'])sources[p]=sha(fs.readFileSync(p));
 const protocol={executionOrder:{phase:flowsFirst?'flows-before-cases':'cases-before-flows',flowIds:flowOrder.map(f=>f.id)},version:corpus.version,method:'CheckList-adapted MFT/INV/DIR + scripted API integration',model:model.metadata,contexts,cases:corpus.cases,flows:corpus.flows,repeatIds,repetitionsPerSelectedCase:3,sources,
  thresholds:{criticalFailures:0,schemaPassRate:1,casePassRate:.95,flowPassRate:.90,pairPassRate:.95},
  scope:{modelReal:true,apiReal:true,database:'SQLite in memory, new fixture per flow',nodeRedFunctions:'VM',nodeRedEngine:false,google:false,supabase:false,browserUI:false,humanUsabilityPanel:false,interpretation:'Model plus adapter, bounded language signals and read-only time conversion; active slots use a reduced act contract before general classification when needed',fieldNumPredict:180},
  oracleReview:'Authored before execution by the coding agent. Not independently reviewed by clinical/administrative stakeholders. Diagnostic set, not a representative or independent holdout benchmark.'};
 protocol.scope.flowStabilityRepetitions=corpus.flows.filter(f=>f.repeatOf).map(f=>({id:f.id,repeatOf:f.repeatOf,attempt:f.attempt}));
 protocol.scope.apiOnly=apiOnly;
 const fingerprint=sha(JSON.stringify(protocol)),parent=path.resolve('docs/verification/chatbot-evaluations');fs.mkdirSync(parent,{recursive:true});
 const resume=process.argv.indexOf('--resume');let output;
 if(resume>=0){output=path.resolve(process.argv[resume+1]);if(path.dirname(output)!==parent)throw Error('Resume directory outside evaluation root');}
 else {output=path.join(parent,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));fs.mkdirSync(output);}
 const resultFile=path.join(output,'results.json');
 let results={status:'running',startedAt:new Date().toISOString(),protocolHash:fingerprint,environment:{node:process.version,cpu:os.cpus()[0]?.model,totalRamBytes:os.totalmem()},direct:[],repetitions:[],flows:[],calls};
 if(resume>=0){const oldProtocol=JSON.parse(fs.readFileSync(path.join(output,'protocol.json'),'utf8'));if(sha(JSON.stringify(oldProtocol))!==fingerprint)throw Error('Frozen protocol or model/source changed');results=JSON.parse(fs.readFileSync(resultFile,'utf8'));calls.push(...results.calls);results.calls=calls;results.status='running';}
 else fs.writeFileSync(path.join(output,'protocol.json'),JSON.stringify(protocol,null,2));
 function save(){fs.writeFileSync(resultFile+'.tmp',JSON.stringify(results,null,2));fs.renameSync(resultFile+'.tmp',resultFile);}
 console.log(JSON.stringify({run:path.relative(root,output),protocolHash:fingerprint,directCases:corpus.cases.length,flows:corpus.flows.length,repeatCalls:repeatIds.length*2}));save();
 if(process.argv.includes('--prepare-only')){results.status='prepared';save();return;}
 async function direct(c,phase){
  current={phase,caseId:c.id};const start=performance.now();let prediction={},error=null,validation=[];
  try{prediction=await model.interpreter.interpret(c.message,contexts[c.context]);validation=schemaErrors(prediction,model.schema);}catch(e){error=e.name;validation=['inference_error'];}
  let resolvedDate=null;try{resolvedDate=prediction.date||calendarAnswer(prediction.date_expression||'',contexts[c.context].today,contexts[c.context].dialogue.requestedWeekday);}catch{}
  const checks=score(prediction,c.expect,resolvedDate);checks.unshift({key:'schema',pass:!validation.length});
  return {id:c.id,type:c.type,capability:c.capability,severity:c.severity,prediction,resolvedDate,error,validation,checks,pass:checks.every(x=>x.pass),latencyMs:performance.now()-start};
 }
 async function runDirect(){
 for(const c of corpus.cases){if(results.direct.some(r=>r.id===c.id))continue;const r=await direct(c,'direct');results.direct.push(r);save();console.log('Direct '+results.direct.length+'/'+corpus.cases.length+' '+c.id+' '+(r.pass?'PASS':'FAIL'));}
 for(const id of repeatIds)for(let attempt=2;attempt<=3;attempt++){
  if(results.repetitions.some(r=>r.id===id&&r.attempt===attempt))continue;
  results.repetitions.push({...await direct(corpus.cases.find(c=>c.id===id),'repeat'),attempt});save();console.log('Repeat '+id+' #'+attempt);
 }
 }
 if(!flowsFirst)await runDirect();
 async function fixture(flow){
  const cfg={mode:'demo',databaseUrl:'',databaseFile:':memory:',demoSecret:randomBytes(32).toString('hex'),internalToken:model.token,worker:true,modelTimeoutMs:120000};
  const db=new Database('',':memory:');await db.initialize();const repo=new Repository(db,cfg);await repo.seed();
  const knowledge=new LocalKnowledge(new KnowledgeIndex('knowledge/telecus'),'http://evaluation.invalid/answer',model.token,120000,model.transport);
  const domain=new DomainService(repo,new SqlSessionRepository(db),db,knowledge),identity=new AuthService(db,cfg),jobs=new JobsService(db,cfg,domain,identity,model.interpreter);
  const users={};for(const [name,id]of Object.entries(demoIds))users[name]=(await db.query('SELECT * FROM telecus_demo_profiles WHERE id=$1',[id]))[0];
  const date=(await db.query('SELECT start_time FROM telecus_demo_appointments'))[0].start_time.slice(0,10),session='evaluation-'+flow.id;
  if(flow.setup==='reason')await domain.process(users[flow.user],{action:'sendMessage',chatInput:'Solicitar una cita',sessionId:session,requestId:randomUUID()},{intent:'reserve',doctor_name:users.otherDoctor.full_name,date,time:'14:30',appointment_code:null,reason:null,request_id:null});
  if(flow.setup==='paid')await db.transaction(cx=>repo.execute(users.admin,'verify_payment',{appointment_code:'TCUS-DEMO-001'},cx));
  const auditStart=(await db.query('SELECT count(*) AS n FROM telecus_audit'))[0].n;
  const notifications=new NotificationsService(new DatabaseNotificationInbox(db));
  const bindings={identity,chat:jobs,notifications,deliveries:{list:async()=>[]},system:{configuration:()=>({mode:'demo'}),health:async()=>({status:'ok',mode:'demo'})}};
  const app=await NestFactory.create(ApiModule.register(bindings),{logger:false});await app.listen(0,'127.0.0.1');const base=await app.getUrl();jobs.start();
  return {db,domain,jobs,app,identity,users,date,session,auditStart,base,last:{},async close(){await jobs.stop();await app.close();await db.close();}};
 }
 async function apiStep(f,flow,step,index){
  const name=step.user||flow.user,user=f.users[name],before=f.last[name],start=performance.now();
  const input={action:step.action||'sendMessage',chatInput:(step.text||'').replaceAll('$DATE',f.date),sessionId:f.session,requestId:randomUUID()};
  if(input.action==='confirm'){
   if(!before?.result?.proposal)return {index,input,pass:false,blocked:true,checks:[{key:'confirmation_precondition',pass:false}]};
   input.proposalId=before.result.proposal.id;
  }
  const headers={'Content-Type':'application/json'};
  // The real fixture identity issues a token; credentials are never written to results.
  const authToken=f.identity.issueDemo(user.id);headers.Authorization='Bearer '+authToken;
  let response=await fetch(f.base+'/api/chat/jobs',{method:'POST',headers,body:JSON.stringify(input)}),job=await response.json();
  if(response.status!==202)return {index,input:{action:input.action,chatInput:input.chatInput},pass:false,error:'enqueue_'+response.status,checks:[{key:'enqueued',pass:false}]};
  const jobId=job.id;
  while(performance.now()-start<150000){response=await fetch(f.base+'/api/chat/jobs/'+jobId,{headers});job=await response.json();if(['done','failed'].includes(job.status))break;await new Promise(r=>setTimeout(r,100));}
  const state=await f.domain.state(user,f.session),ground=await f.domain.grounding(user,input),draft=state.draft||state.proposal?.payload||{};
  const appointment=(await f.db.query('SELECT * FROM telecus_demo_appointments WHERE patient_id=$1 ORDER BY code',[flow.user==='otherPatient'?f.users.otherPatient.id:f.users.patient.id]))[0];
  const change=(await f.db.query('SELECT status FROM telecus_demo_changes LIMIT 1'))[0];
  const observed={status:job.status,reply:job.result?.reply||null,error:job.error||null,task:draft.intent||null,slot:ground.dialogue.expectedSlot,date:draft.date||null,time:draft.time||null,reason:draft.reason||null,proposal:state.proposal?.kind||null,appointments:(await f.db.query('SELECT count(*) AS n FROM telecus_demo_appointments WHERE patient_id=$1',[user.id]))[0].n,payment:appointment?.payment_status,appointmentStatus:appointment?.status,changeState:change?.status||null,audit:(await f.db.query('SELECT count(*) AS n FROM telecus_audit'))[0].n-f.auditStart};
  const checks=[],add=(key,pass)=>checks.push({key,pass:Boolean(pass)}),wanted=step.check;
  if(wanted.denied)add('denied',job.status==='failed'&&/rol no permite|Solo un administrativo|Solo el paciente|requiere un administrativo/i.test(job.error||''));else add('job_done',job.status==='done');
  for(const [key,value]of Object.entries(wanted)){
   if(key==='denied')continue;
   if(key==='noProposal')add(key,!state.proposal&&!job.result?.proposal);
   else if(key==='noReason')add(key,!draft.reason);
   else if(key==='absentTime')add(key,!draft.time);
   else if(key==='contains')add(key,(observed.reply||'').includes(value));
   else if(key==='noSources')add(key,!observed.reply?.includes('Fuentes:'));
   else if(key==='sources')add(key,observed.reply?.includes('Fuentes:'));
   else if(key==='notSameReply')add(key,observed.reply!==before?.result?.reply);
   else if(key==='sameProposal')add(key,Boolean(state.proposal?.id&&state.proposal.id===before?.result?.proposal?.id));
   else add(key,observed[key]===(value==='$DATE'?f.date:value));
  }
  f.last[name]=job;
  return {index,user:name,input:{action:input.action,chatInput:input.chatInput},observed,checks,pass:checks.every(c=>c.pass),latencyMs:performance.now()-start};
 }
 for(const flow of flowOrder){
  if(results.flows.some(r=>r.id===flow.id))continue;
  const f=await fixture(flow);activeFixture=f;const rows=[];
  try{for(const [index,step]of flow.steps.entries()){current={phase:'flow',caseId:flow.id,step:index};rows.push(await apiStep(f,flow,step,index));}}
  finally{await f.close();activeFixture=null;}
  results.flows.push({id:flow.id,...(flow.repeatOf?{repeatOf:flow.repeatOf,attempt:flow.attempt}:{}),capability:flow.capability,severity:flow.severity||'major',steps:rows,pass:rows.every(s=>s.pass)});save();console.log('Flow '+flow.id+' '+(rows.every(r=>r.pass)?'PASS':'FAIL'));
 }
 if(flowsFirst)await runDirect();
 for(const [file,digest]of Object.entries(sources))if(sha(fs.readFileSync(file))!==digest)throw Error('Source changed during evaluation: '+file);
 results.status='completed';results.finishedAt=new Date().toISOString();save();
 require('./report.cjs')(output,protocol,results);console.log(JSON.stringify({status:'completed',report:path.relative(root,path.join(output,'REPORT.md')),modelCalls:calls.length}));
}
main().catch(async error=>{console.error('Evaluation interrupted: '+(error.code||error.message));await activeFixture?.close();process.exitCode=1;});
