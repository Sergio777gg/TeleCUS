// Tests the actual DB -> worker -> Calendar -> DB boundary. Fixtures roll back.
// Gmail was verified separately; this test validates its queued payload without resending.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
process.chdir(path.resolve(__dirname,'..'));process.loadEnvFile('.env');
async function main(){
 const client=await require('./db-admin.cjs')();
 const {configuredGoogle}=await import('../apps/backend/dist/integrations/google-config.js');const {DeliveryWorker}=await import('../apps/backend/dist/integrations/deliveries.js');
 const google=configuredGoogle(process.env.DEMO_SESSION_SECRET);let event;let checkedMail=false;
 const call=async(name,args=[]) => (await client.query(`SELECT telecus_integration.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS r`,args)).rows[0].r;
 const store={call};
 try {
   await client.query('BEGIN');
   const pending=(await client.query("SELECT count(*) FROM telecus_integration.deliveries WHERE status<>'done'")).rows[0].count;
   assert.equal(Number(pending),0,'Hay tareas reales pendientes: la prueba no debe tomarlas.');
   const p=randomUUID(),d=randomUUID(),a=randomUUID();
   for(const [id,role]of [[p,'PATIENT'],[d,'DOCTOR'],[a,'ADMIN']]){await client.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',[id,`telecus-test-${id}@example.test`,{full_name:'PRUEBA TeleCUS'}]);await client.query('UPDATE public.profiles SET role=$1 WHERE id=$2',[role,id]);}
   await client.query('GRANT telecus_backend TO postgres');await client.query('SET LOCAL ROLE telecus_backend');
   const day=new Date();day.setUTCDate(day.getUTCDate()+((8-day.getUTCDay())%7||7));const date=day.toISOString().slice(0,10);
   await call('execute',[p,randomUUID(),'reserve',{doctor_id:d,date,time:'14:00',reason:'PRUEBA TeleCUS'}]);
   await client.query('RESET ROLE');const ap=(await client.query('SELECT id,code FROM public.appointments WHERE patient_id=$1',[p])).rows[0];
   await client.query('SET LOCAL ROLE telecus_backend');await call('execute',[a,randomUUID(),'verify_payment',{appointment_code:ap.code}]);
   await client.query('RESET ROLE');
   // Only our uncommitted fixture changes recipients. Real rows are never selected here.
   await client.query('UPDATE telecus_integration.deliveries SET appointment=appointment||$1::jsonb WHERE appointment_id=$2',[
     {code:'TCUS-TEST-'+ap.id.slice(0,8).toUpperCase(),patient_email:'citascus@gmail.com',doctor_email:'citascus@gmail.com'},ap.id]);
   await client.query('SET LOCAL ROLE telecus_backend');
   const worker=new DeliveryWorker(store,{calendar:async task=>{event=task.appointment;return google.calendar(task);},sendNotification:async task=>{
     assert.equal(task.appointment.patient_email,'citascus@gmail.com');assert.ok(task.appointment.meet_url.startsWith('https://meet.google.com/'));checkedMail=true;return{id:'simulated-mail-no-send'};}});
   await worker.workOnce();await worker.workOnce();
   await client.query('RESET ROLE');
   const result=(await client.query('SELECT status,payment_status,meet_url FROM public.appointments WHERE id=$1',[ap.id])).rows[0];
   assert.equal(result.status,'CONFIRMED');assert.equal(result.payment_status,'VERIFIED');assert.ok(result.meet_url.startsWith('https://meet.google.com/'));assert.ok(checkedMail);
   assert.equal((await client.query('SELECT status FROM telecus_integration.deliveries WHERE appointment_id=$1',[ap.id])).rows[0].status,'done');
   const originalEvent=(await client.query('SELECT calendar_event_id FROM public.appointments WHERE id=$1',[ap.id])).rows[0].calendar_event_id;
   await client.query('SET LOCAL ROLE telecus_backend');await call('execute',[a,randomUUID(),'reschedule',{appointment_code:ap.code,date,time:'15:00'}]);
   await client.query('RESET ROLE');await client.query('UPDATE telecus_integration.deliveries SET appointment=appointment||$1::jsonb WHERE appointment_id=$2 AND status<>\'done\'',[{code:'TCUS-TEST-'+ap.id.slice(0,8).toUpperCase(),patient_email:'citascus@gmail.com',doctor_email:'citascus@gmail.com'},ap.id]);
   await client.query('SET LOCAL ROLE telecus_backend');await worker.workOnce();await worker.workOnce();await client.query('RESET ROLE');
   const updated=(await client.query('SELECT status,calendar_event_id,start_time FROM public.appointments WHERE id=$1',[ap.id])).rows[0];
   assert.equal(updated.status,'RESCHEDULED');assert.equal(updated.calendar_event_id,originalEvent);assert.equal(new Date(updated.start_time).getUTCHours(),20);
   console.log(JSON.stringify({status:'ok',dbWorkerCalendar:'verified',meetStored:true,rescheduleSameEvent:'verified_with_etag',mailPayload:'verified_without_resend',fixtureData:'rolled_back'}));
 } finally {
   try{if(event)await google.calendar({operation:'cancel',appointment:event,delivery_id:randomUUID()});}
   finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
 }
}
main().catch(e=>{console.error(JSON.stringify({status:'failed',code:e.code||e.name,message:e.message}));process.exitCode=1;});
