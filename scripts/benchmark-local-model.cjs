// Synthetic, sequential measurements. Never reads application secrets or records.
// Usage: node scripts/benchmark-local-model.cjs [8192|4096] [1..5]
const {performance}=require('node:perf_hooks');
async function main(){
 const context=Number(process.argv[2]||8192),repeats=Number(process.argv[3]||3);
 if(![4096,8192].includes(context)||!Number.isInteger(repeats)||repeats<1||repeats>5)throw Error('arguments');
 const base=new URL(process.env.OLLAMA_URL||'http://127.0.0.1:11434');
 if(!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||base.username||base.password)throw Error('local endpoint required');
 const model=process.env.TELECUS_AI_MODEL||'telecus-local';
 const schema={type:'object',properties:{intent:{type:'string',enum:['reschedule']},appointment_code:{type:'string'},date:{type:'string'},time:{type:'string'}},required:['intent','appointment_code','date','time'],additionalProperties:false};
 const [tagsResponse,versionResponse]=await Promise.all([fetch(new URL('/api/tags',base),{signal:AbortSignal.timeout(5000)}),fetch(new URL('/api/version',base),{signal:AbortSignal.timeout(5000)})]);
 if(!tagsResponse.ok||!versionResponse.ok)throw Error('metadata unavailable');
 const tags=await tagsResponse.json(),version=await versionResponse.json();
 const selected=tags.models?.find(item=>item.name===model||item.name===model+':latest');
 if(!selected)throw Error('model missing');
 console.log(JSON.stringify({kind:'scope',synthetic:true,appointmentsChanged:0,model,modelDigest:selected.digest,ollamaVersion:version.version,context,repeats,qualityScope:'Extraction smoke test only; does not replace TeleCUS regression or security evaluation.'}));
 let failures=0;
 for(let index=0;index<repeats;index++){
  const started=performance.now();
  const response=await fetch(new URL('/api/chat',base),{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(180000),body:JSON.stringify({model,stream:false,think:false,keep_alive:'10m',format:schema,options:{temperature:0,num_ctx:context,num_predict:120},messages:[{role:'system',content:'Extrae la solicitud ficticia en el esquema JSON. Usa HH:mm y YYYY-MM-DD. No ejecutes operaciones.'},{role:'user',content:'Reprogramar TCUS-DEMO-001 para el 2030-06-10 a las 3 de la tarde.'}]})});
  if(!response.ok)throw Error('model request failed');
  const result=await response.json();let parsed;try{parsed=JSON.parse(result.message?.content||'');}catch{}
  const pass=parsed?.intent==='reschedule'&&parsed?.appointment_code==='TCUS-DEMO-001'&&parsed?.date==='2030-06-10'&&parsed?.time==='15:00';
  if(!pass)failures++;
  const seconds=value=>Math.round((Number(value)||0)/1e6)/1000;
  console.log(JSON.stringify({kind:'sample',sample:index+1,wallSeconds:Math.round(performance.now()-started)/1000,totalSeconds:seconds(result.total_duration),loadSeconds:seconds(result.load_duration),promptTokens:result.prompt_eval_count,promptSeconds:seconds(result.prompt_eval_duration),outputTokens:result.eval_count,outputSeconds:seconds(result.eval_duration),tokensPerSecond:result.eval_duration>0?Math.round(result.eval_count/result.eval_duration*1e11)/100:null,extractionPass:pass}));
 }
 if(failures)process.exitCode=1;
}
main().catch(()=>{console.error('No se pudo completar la medición local. Comprueba Ollama, el modelo y los argumentos; no se imprimieron respuestas ni secretos.');process.exitCode=1;});
