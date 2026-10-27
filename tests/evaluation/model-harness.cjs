const fs=require('node:fs'),vm=require('node:vm'),{randomBytes}=require('node:crypto');
async function modelHarness(onCall=()=>{}){
 const address=new URL(process.env.OLLAMA_URL||'http://127.0.0.1:11434');
 if(!['127.0.0.1','localhost','[::1]'].includes(address.hostname))throw Error('Evaluation requires local Ollama');
 const token=randomBytes(32).toString('hex'),flows=JSON.parse(fs.readFileSync('node-red/flows.json','utf8'));
 const config={TELECUS_INTERNAL_TOKEN:token,OLLAMA_URL:address.href.replace(/\/$/,''),TELECUS_AI_MODEL:process.env.TELECUS_AI_MODEL||'telecus-local',TELECUS_AI_CONTEXT:Number(process.env.TELECUS_AI_CONTEXT||8192)};
 const fn=id=>vm.runInNewContext('(function(msg){'+flows.find(n=>n.id===id).func+'})',{env:{get:key=>config[key]}});
 const functions={prepare:fn('prepare'),parse:fn('parse'),answerPrepare:fn('answerPrepare'),answerParse:fn('answerParse')};
 const example=functions.prepare({req:{headers:{'x-telecus-internal':token}},payload:{message:'Hola',context:{role:'PATIENT'}}})[0].payload;
 const tags=await (await fetch(address.origin+'/api/tags',{signal:AbortSignal.timeout(5000)})).json();
 const selected=tags.models.find(m=>m.name===config.TELECUS_AI_MODEL||m.name===config.TELECUS_AI_MODEL+':latest');
 if(!selected)throw Error('Configured model is not installed');
 let version=null;try{version=(await (await fetch(address.origin+'/api/version',{signal:AbortSignal.timeout(5000)})).json()).version;}catch{}
 let callId=0;
 async function transport(endpoint,options){
  const body=JSON.parse(options.body),stage=endpoint.endsWith('/answer')?'knowledge':body.stage==='field'?'field':'interpretation',start=performance.now();
  const msg=functions[stage==='knowledge'?'answerPrepare':'prepare']({req:{headers:{'x-telecus-internal':options.headers['X-TeleCUS-Internal']}},payload:body})[0];
  if(!msg)throw Error('Generated flow rejected synthetic request');
  const id=++callId;
  try{
   const response=await fetch(msg.url,{method:'POST',headers:msg.headers,body:JSON.stringify(msg.payload),signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});
   const raw=await response.json(),parsed=functions[stage==='knowledge'?'answerParse':'parse']({statusCode:response.status,payload:raw});
   onCall({id,stage,input:body,prediction:parsed.payload,status:parsed.statusCode,latencyMs:performance.now()-start,
    promptTokens:raw.prompt_eval_count,outputTokens:raw.eval_count,loadMs:raw.load_duration/1e6,generationMs:raw.eval_duration/1e6});
   return new Response(JSON.stringify(parsed.payload),{status:parsed.statusCode});
  }catch(error){onCall({id,stage,input:body,error:error.name,latencyMs:performance.now()-start});throw error;}
 }
 const {NodeRedInterpreter}=await import('../../apps/backend/dist/adapters/interpretation.js');
 return {token,transport,interpreter:new NodeRedInterpreter('http://evaluation.invalid/interpret',token,120000,transport),schema:example.format,
  metadata:{model:selected.name,digest:selected.digest,bytes:selected.size,details:selected.details,ollamaVersion:version,options:example.options,think:example.think,nodeRedEngineTested:false},get callCount(){return callId;}};
}
module.exports={modelHarness};
