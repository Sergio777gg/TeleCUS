// Authorized test: one marked event, only citascus@gmail.com, one Gmail notification.
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
process.chdir(path.resolve(__dirname,'..'));process.loadEnvFile('.env');
const stateFile='data/google-integration-test.json';
async function main(){
 try{await fs.access(stateFile);throw new Error('La prueba ya tiene un registro; revisar su resultado antes de repetir envíos.');}catch(e){if(e.code!=='ENOENT')throw e;}
 const {configuredGoogle}=await import('../apps/backend/dist/integrations/google-config.js');
 const google=configuredGoogle(process.env.DEMO_SESSION_SECRET);
 const day=new Date();day.setUTCDate(day.getUTCDate()+((8-day.getUTCDay())%7||7));const date=day.toISOString().slice(0,10);
 const id=randomUUID();let appointment={id,code:'TCUS-TEST-'+id.slice(0,8).toUpperCase(),start_time:date+'T19:00:00Z',end_time:date+'T19:30:00Z',patient_email:'citascus@gmail.com',doctor_email:'citascus@gmail.com'};
 const state={id,stage:'starting',calendar:false,meet:false,reschedule:false,mail:false,cleaned:false};
 const save=()=>fs.writeFile(stateFile,JSON.stringify(state,null,2));await save();
 try {
   const result=await google.calendar({operation:'confirm',appointment,delivery_id:id});
   appointment={...appointment,...result};state.calendar=true;state.meet=Boolean(result.meet_url);state.stage='calendar_created';await save();
   const recovery=await google.calendar({operation:'confirm',appointment,delivery_id:id});
   if(recovery.calendar_event_id!==result.calendar_event_id)throw Error('El evento se duplicó.');
   appointment={...appointment,start_time:date+'T19:30:00Z',end_time:date+'T20:00:00Z'};
   const change={operation:'reschedule',appointment,delivery_id:randomUUID()};
   await google.calendar(change);await google.calendar(change);state.reschedule=true;state.stage='mail_sending';await save();
   const receipt=await google.sendNotification({operation:'confirm',appointment,delivery_id:id});
   if(!receipt.id)throw Error('Correo sin recibo de entrega.');
   state.mail=true;state.stage='mail_sent';await save();
 } finally {
   if(state.calendar){try{await google.calendar({operation:'cancel',appointment,delivery_id:id});state.cleaned=true;}catch{state.stage='cleanup_required';}}
   if(state.mail&&state.cleaned)state.stage='completed';await save();
 }
 console.log(JSON.stringify({status:state.stage,calendar:state.calendar,meet:state.meet,reschedule:state.reschedule,testEmailSent:state.mail,testEventRemoved:state.cleaned,recipient:'citascus@gmail.com'}));
}
main().catch(()=>{console.error('La prueba de Google necesita revisión. No se repetirá automáticamente el correo.');process.exitCode=1;});
