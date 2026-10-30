const {setTimeout:pause}=require('node:timers/promises');
const base='http://127.0.0.1:11434',model=process.env.TELECUS_AI_MODEL||'telecus-local';
(async()=>{
 let ready=false;
 for(let attempt=0;attempt<30;attempt++){
  try{const response=await fetch(base+'/api/tags',{signal:AbortSignal.timeout(3000)});if(response.ok){ready=true;break;}}catch{}
  await pause(1000);
 }
 if(!ready)throw Error('ollama-unavailable');
 const start=Date.now();
 const response=await fetch(base+'/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({model,stream:false,keep_alive:-1,options:{num_ctx:8192}}),signal:AbortSignal.timeout(600000)});
 if(!response.ok)throw Error('model-load-failed');
 const result=await response.json();
 if(!result.done)throw Error('model-not-ready');
 console.log(JSON.stringify({status:'ok',model,preloaded:true,elapsed_ms:Date.now()-start,externalRecordsUsed:0}));
})().catch(()=>{console.error('No se pudo precargar el modelo local. Revisar Ollama, memoria y tiempo de carga.');process.exitCode=1;});
