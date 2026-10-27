// Fictitious users and deliveries remain uncommitted and invisible to real workers.
require('./runtime-env.cjs')();
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function main(){
 let credential=await require('./read-secret.cjs')('Credencial de prueba transaccional (oculta): ');
 const client=await require('./db-admin.cjs')(credential);credential='';let checks=0;
 const query=(sql,args=[])=>client.query(sql,args),recover=require('./payment-recovery.cjs');
 try{
  await query('BEGIN');await query("SET LOCAL statement_timeout='20s'");
  const patient=randomUUID(),doctor=randomUUID(),admin=randomUUID();
  for(const [id,role] of [[patient,'PATIENT'],[doctor,'DOCTOR'],[admin,'ADMIN']]){
   await query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',[id,'fixture-'+id+'@example.test',{full_name:'Prueba recuperación'}]);
   await query('UPDATE public.profiles SET role=$1 WHERE id=$2',[role,id]);
  }
  const day=new Date();day.setUTCDate(day.getUTCDate()+((8-day.getUTCDay())%7||7)+7);
  await query('SELECT telecus_integration.execute($1,$2,$3,$4)',[patient,randomUUID(),'reserve',JSON.stringify({doctor_id:doctor,date:day.toISOString().slice(0,10),time:'14:00'})]);
  const a=(await query('SELECT id,code FROM public.appointments WHERE patient_id=$1',[patient])).rows[0],operation=randomUUID();
  await query('SELECT telecus_integration.execute($1,$2,$3,$4)',[admin,operation,'verify_payment',JSON.stringify({appointment_code:a.code})]);
  await query("UPDATE telecus_integration.deliveries SET status='review',last_error='calendar_failed',attempts=8 WHERE operation_id=$1",[operation]);
  const before=(await query('SELECT id,operation_id,appointment FROM telecus_integration.deliveries WHERE operation_id=$1',[operation])).rows[0];
  assert.equal((await recover(client,a.code)).recovered,true);checks++;
  const after=(await query('SELECT id,operation_id,appointment,status,attempts FROM telecus_integration.deliveries WHERE operation_id=$1',[operation])).rows[0];
  assert.equal(after.id,before.id);assert.equal(after.operation_id,before.operation_id);assert.deepEqual(after.appointment,before.appointment);checks++;
  assert.equal(after.status,'queued');assert.equal(after.attempts,0);checks++;
  assert.equal((await query("SELECT count(*)::int AS n FROM public.appointment_logs WHERE appointment_id=$1 AND action='verify_payment_RETRY_QUEUED'",[a.id])).rows[0].n,1);checks++;
  assert.equal((await recover(client,a.code)).recovered,false);checks++;
  await query("UPDATE telecus_integration.deliveries SET status='review',last_error='calendar_failed' WHERE operation_id=$1",[operation]);
  for(const [sql,args] of [
   ["UPDATE telecus_integration.deliveries SET stage='mail',last_error='mail_delivery_uncertain' WHERE operation_id=$1",[operation]],
   ['UPDATE public.profiles SET active=false WHERE id=$1',[admin]],
   ["UPDATE public.profiles SET role='PATIENT' WHERE id=$1",[admin]],
   ['UPDATE public.profiles SET active=false WHERE id=$1',[doctor]],
   ["UPDATE telecus_integration.deliveries SET last_error='agenda_changed_after_calendar' WHERE operation_id=$1",[operation]],
   ["UPDATE telecus_integration.deliveries SET expected_updated_at=expected_updated_at-interval '1 second' WHERE operation_id=$1",[operation]],
   ["UPDATE public.appointments SET status='CANCELLED' WHERE id=$1",[a.id]]
  ]){
   await query('SAVEPOINT rejected');await query(sql,args);assert.equal((await recover(client,a.code)).recovered,false);checks++;await query('ROLLBACK TO SAVEPOINT rejected');
  }
  assert.equal((await query('SELECT count(*)::int AS n FROM telecus_integration.deliveries WHERE operation_id=$1',[operation])).rows[0].n,1);checks++;
  console.log(JSON.stringify({status:'ok',checks,fixtures:'rolled_back',calendarCalls:0,emailsSent:0}));
 }finally{await query('ROLLBACK').catch(()=>{});await client.end();}
}
main().then(()=>process.exit(0)).catch(error=>{console.error('Falló la prueba transaccional de recuperación: '+(error.code||'assertion'));process.exit(1);});
