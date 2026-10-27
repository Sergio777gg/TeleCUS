// Fictitious fixtures only; always rolled back, no Calendar or Gmail calls.
require('./runtime-env.cjs')();
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const cleanup=require('./cleanup-test-history.cjs');
async function main(){
 let credential=await require('./read-secret.cjs')('Credencial de prueba transaccional (oculta): ');
 const client=await require('./db-admin.cjs')(credential);credential='';let checks=0;
 const q=(sql,args=[])=>client.query(sql,args);
 try{
  await q('BEGIN');await q("SET LOCAL statement_timeout='20s'");
  const patient=randomUUID(),other=randomUUID(),doctor=randomUUID(),admin=randomUUID(),email='fixture-'+patient+'@example.test';
  for(const [id,role] of [[patient,'PATIENT'],[other,'PATIENT'],[doctor,'DOCTOR'],[admin,'ADMIN']]){
   await q('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',[id,'fixture-'+id+'@example.test',{full_name:'Prueba mantenimiento'}]);
   await q('UPDATE public.profiles SET role=$1 WHERE id=$2',[role,id]);
  }
  const day=new Date();day.setUTCDate(day.getUTCDate()+((8-day.getUTCDay())%7||7)+14);const date=day.toISOString().slice(0,10);
  async function reserve(actor,time){await q('SELECT telecus_integration.execute($1,$2,$3,$4)',[actor,randomUUID(),'reserve',JSON.stringify({doctor_id:doctor,date,time})]);return (await q("SELECT id,code FROM public.appointments WHERE patient_id=$1 AND status='PRE_RESERVED'",[actor])).rows[0];}
  const closed=await reserve(patient,'14:00'),operation=randomUUID();
  await q('SELECT telecus_integration.execute($1,$2,$3,$4)',[admin,operation,'verify_payment',JSON.stringify({appointment_code:closed.code})]);
  // No worker sees these uncommitted fixtures; completed delivery is simulated.
  await q("UPDATE telecus_integration.deliveries SET status='done' WHERE operation_id=$1",[operation]);
  await q("UPDATE public.appointments SET status='CONFIRMED',payment_status='VERIFIED' WHERE id=$1",[closed.id]);
  await q('SELECT telecus_integration.execute($1,$2,$3,$4)',[patient,randomUUID(),'cancel',JSON.stringify({appointment_code:closed.code})]);
  await q("UPDATE public.appointment_change_requests SET status='APPROVED' WHERE appointment_id=$1",[closed.id]);
  await q("UPDATE public.appointments SET status='CANCELLED',payment_status='VERIFIED' WHERE id=$1",[closed.id]);
  const active=await reserve(patient,'14:30'),foreign=await reserve(other,'15:00');
  await q("UPDATE public.appointments SET status='CANCELLED' WHERE id=$1",[foreign.id]);
  for(const [scope,account] of [[[active.code],email],[[foreign.code],email],[[closed.code,active.code],email],[[closed.code],'missing@example.test']]){
   await q('SAVEPOINT guard');await assert.rejects(cleanup.plan(client,account,scope));checks++;await q('ROLLBACK TO SAVEPOINT guard');
  }
  for(const sql of ["UPDATE public.appointment_change_requests SET status='PENDING' WHERE appointment_id=$1","UPDATE telecus_integration.deliveries SET status='queued' WHERE appointment_id=$1"]){
   await q('SAVEPOINT unfinished');await q(sql,[closed.id]);await assert.rejects(cleanup.plan(client,email,[closed.code]));checks++;await q('ROLLBACK TO SAVEPOINT unfinished');
  }
  await q('SAVEPOINT pending_payment');await q("UPDATE public.appointments SET payment_status='PENDING' WHERE id=$1",[closed.id]);await assert.rejects(cleanup.plan(client,email,[closed.code]));checks++;await q('ROLLBACK TO SAVEPOINT pending_payment');
  const snapshot=await cleanup.plan(client,email,[closed.code]);assert.equal(snapshot.requests.length,1);assert.equal(snapshot.deliveries.length,1);assert.ok(snapshot.notifications.length>0);checks++;
  await assert.rejects(cleanup.remove(client,snapshot,async()=>{throw Error('backup unavailable');}));
  assert.equal((await q('SELECT count(*)::int AS n FROM public.appointments WHERE id=$1',[closed.id])).rows[0].n,1);checks++;
  const restored=cleanup.unseal(cleanup.seal(snapshot,'fictitious-maintenance-key'), 'fictitious-maintenance-key');assert.equal(restored.logs.length,snapshot.logs.length);checks++;
  // In-memory backup is suitable only for fixtures that will roll back.
  await cleanup.remove(client,snapshot,async()=> 'fictitious-memory-backup');
  assert.equal((await q('SELECT count(*)::int AS n FROM public.appointments WHERE id=$1',[closed.id])).rows[0].n,0);
  assert.equal((await q('SELECT count(*)::int AS n FROM public.appointment_change_requests WHERE appointment_id=$1',[closed.id])).rows[0].n,0);checks++;
  assert.equal((await q('SELECT count(*)::int AS n FROM telecus_integration.operations WHERE id=$1',[operation])).rows[0].n,1);checks++;
  assert.equal((await q('SELECT count(*)::int AS n FROM public.appointments WHERE id=ANY($1::uuid[])',[[active.id,foreign.id]])).rows[0].n,2);checks++;
  assert.equal((await q("SELECT count(*)::int AS n FROM telecus_integration.notification_events WHERE payload->>'code'=$1",[closed.code])).rows[0].n,0);checks++;
  console.log(JSON.stringify({status:'ok',checks,fixtures:'rolled_back',calendarCalls:0,emailsSent:0}));
 }finally{await q('ROLLBACK').catch(()=>{});await client.end();}
}
main().then(()=>process.exit(0)).catch(error=>{console.error('Falló la prueba de mantenimiento: '+(error.code||'assertion'));console.error((error.stack||'').split('\n').filter(line=>/^\s+at /.test(line)).slice(0,2).join('\n'));process.exit(1);});
