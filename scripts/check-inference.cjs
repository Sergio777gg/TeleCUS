require('./runtime-env.cjs')();
async function main(){
 const {calendarAnswer}=await import('../apps/backend/dist/calendar.js');const start=Date.now();
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota'}).format(new Date()),date=calendarAnswer('próximo lunes',today);
 const r=await fetch(process.env.INFERENCE_URL,{method:'POST',headers:{'Content-Type':'application/json','X-TeleCUS-Internal':process.env.TELECUS_INTERNAL_TOKEN},body:JSON.stringify({message:`Reprogramar mi cita TCUS-DEMO-001 para el ${date} a las 3 de la tarde`,context:{role:'PATIENT',today,timezone:'America/Bogota',doctors:[{id:'demo',full_name:'Dra. Ana López'}],draft:null,pendingConfirmation:false}}),signal:AbortSignal.timeout(120000)});
 if(!r.ok)throw Error('La inferencia no respondió correctamente.');const result=await r.json();
 if(result.intent!=='reschedule'||result.appointment_code!=='TCUS-DEMO-001'||result.date!==date||result.time!=='15:00')throw Error('La inferencia no interpretó correctamente el ejemplo ficticio.');
 console.log(JSON.stringify({status:'ok',interpretation:result,elapsed_ms:Date.now()-start,appointmentsChanged:0}));
}
main().catch(()=>{console.error('No se pudo verificar la inferencia con el ejemplo ficticio. Revisa el servicio, el modelo y su contrato.');process.exitCode=1;});
