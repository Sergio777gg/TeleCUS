// Reproducible, synthetic-only battery. No private config, real DB, Google or messaging.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');require('reflect-metadata');
const corpus=require('./behaviour-cases.cjs');
const root=path.resolve(__dirname,'../..');process.chdir(root);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
async function run({realModel=false,onRow=()=>{},timeoutMs=45000,holdout=false}={}){
 const [{roleChoices,resolveConversation,resolveInterpretation,emptyIntent},{calendarAnswer},{JobsService}]=await Promise.all(['conversation','calendar','jobs'].map(p=>import('../../apps/backend/dist/'+p+'.js')));
 const contexts=require('./contexts.cjs')(roleChoices);for(const c of Object.values(contexts))c.today=corpus.today;
 contexts.doctor=structuredClone(contexts.ambiguous);contexts.doctor.dialogue.lastQuestion='Elige un médico por su número o nombre.';
 const sourceFiles=['apps/backend/src/conversation.ts','apps/backend/src/calendar.ts','apps/backend/src/adapters/interpretation.ts','apps/backend/src/application/step-help.ts','apps/backend/src/application/language-signals.ts','scripts/build-flow.cjs','scripts/prompts/interpretation.cjs','node-red/flows.json'];
 const sourceHashes=Object.fromEntries(sourceFiles.map(f=>[f,sha(fs.readFileSync(f))]));
 const rows=[],calls=[];const match=(r,e)=>Object.entries(e).map(([key,value])=>({key,pass:key==='reasonContains'?typeof r.reason==='string'&&value.every(part=>r.reason.toLocaleLowerCase('es').includes(part.toLocaleLowerCase('es'))):key==='notIntent'?![].concat(value).includes(r.intent):Array.isArray(value)?value.includes(r[key]):(r[key]??null)===value}));
 for(const c of corpus.direct){const ctx=contexts[c.context],start=performance.now();let observed,error;
  try{observed=resolveConversation(c.text,ctx)||resolveInterpretation(c.text,emptyIntent(c.fallback.intent,c.fallback),ctx);}catch(e){error=e.name;observed={};}
  const checks=match(observed,c.expect);const row={id:c.id,family:c.family,kind:'deterministic',text:c.text,context:c.context,observed,checks,pass:!error&&checks.every(r=>r.pass),error,latencyMs:performance.now()-start};rows.push(row);onRow(row);
 }
 let calendarPassed=0;const calendarFailures=[];for(const c of corpus.calendar){const date=calendarAnswer(c.text,corpus.today);if(date===c.expect)calendarPassed++;else calendarFailures.push({...c,observed:date});}
 let metadata=null;
 if(realModel){
  const harness=await require('./model-harness.cjs').modelHarness(call=>calls.push(call));metadata=harness.metadata;let consecutiveErrors=0;
  const selected=holdout?require('./behaviour-holdout.cjs'):corpus.model;
  const ordered=[...selected].sort((a,b)=>['reason','doctor','empty','date'].indexOf(a.context)-['reason','doctor','empty','date'].indexOf(b.context));
  for(const c of ordered){const start=performance.now(),ctx=contexts[c.context];let observed={},error;
   try{const interpreter=new (await import('../../apps/backend/dist/adapters/interpretation.js')).NodeRedInterpreter('http://evaluation.invalid/interpret',harness.token,timeoutMs,harness.transport);
    const jobs=new JobsService({}, {},{grounding:async()=>ctx},{},interpreter);observed=await jobs.interpret({id:'synthetic-battery',role:'PATIENT',active:true},{chatInput:c.text});consecutiveErrors=0;
   }catch(e){error=e.name;consecutiveErrors++;}
   const checks=match(observed,c.expect),row={...c,kind:'real-model',observed,checks,error,pass:!error&&checks.every(x=>x.pass),latencyMs:performance.now()-start};rows.push(row);onRow(row);
   if(consecutiveErrors>=3){for(const blocked of ordered.slice(ordered.indexOf(c)+1))rows.push({...blocked,kind:'real-model',pass:false,blocked:'three_consecutive_inference_errors'});break;}
  }
 }
 for(const row of rows.filter(r=>r.kind==='real-model'))row.modelCalls=calls.filter(c=>c.input?.message===row.text).length;
 for(const [file,hash]of Object.entries(sourceHashes))if(sha(fs.readFileSync(file))!==hash)throw Error('Source changed during evaluation');
 return {protocol:{version:corpus.version,method:corpus.method,scope:{synthetic:true,realModel,nodeRedEngine:false,productionData:false,google:false},corpusSha256:sha(fs.readFileSync('tests/evaluation/behaviour-cases.cjs')),holdoutSha256:holdout?sha(fs.readFileSync('tests/evaluation/behaviour-holdout.cjs')):null,sources:sourceHashes,model:metadata},at:new Date().toISOString(),summary:{direct:{passed:rows.filter(r=>r.kind==='deterministic'&&r.pass).length,total:corpus.direct.length},calendar:{passed:calendarPassed,total:corpus.calendar.length},model:{passed:rows.filter(r=>r.kind==='real-model'&&r.pass).length,total:realModel?(holdout?require('./behaviour-holdout.cjs').length:corpus.model.length):0},modelCalls:calls.length},rows,calendarFailures,calls};
}
module.exports={run};
if(require.main===module){
 const tagIndex=process.argv.indexOf('--tag'),tag=(tagIndex>=0?process.argv[tagIndex+1]:'run').replace(/[^a-zA-Z0-9_-]/g,''),file=path.join('docs/verification','BATTERY_'+tag+'.json'),progress=[];
 run({realModel:process.argv.includes('--model'),holdout:process.argv.includes('--holdout'),onRow:r=>{progress.push(r);fs.writeFileSync(file+'.partial',JSON.stringify({status:'running',at:new Date().toISOString(),rows:progress},null,2));if(r.kind==='real-model'||!r.pass)console.log(JSON.stringify({id:r.id,kind:r.kind,pass:r.pass,failed:r.checks?.filter(c=>!c.pass).map(c=>c.key),error:r.error,ms:Math.round(r.latencyMs)}));}}).then(result=>{fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n');fs.writeFileSync(file+'.partial',JSON.stringify({status:'completed',report:file}));console.log(JSON.stringify({report:file,...result.summary}));if(result.rows.some(r=>!r.pass)||result.calendarFailures.length)process.exitCode=1;}).catch(e=>{console.error(JSON.stringify({status:'setup_failed',code:e.name}));process.exitCode=1;});
}
