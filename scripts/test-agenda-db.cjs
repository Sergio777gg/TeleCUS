// Real PostgreSQL integration tests: all fixture data and DDL roll back together.
const fs=require('node:fs/promises'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const path=require('node:path');process.chdir(path.resolve(__dirname,'..'));
async function main(){
 const client=await require('./db-admin.cjs')(); let passed=0;
 const query=(s,a=[])=>client.query(s,a);
 const call=async(name,args=[])=> (await query(`SELECT telecus_integration.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS r`,args)).rows[0].r;
 const expectFailure=async(fn,code)=>{await query('SAVEPOINT expected_error');let caught=false;try{await fn();}catch(e){caught=true;assert.equal(e.code,code);}finally{await query('ROLLBACK TO SAVEPOINT expected_error');}assert.ok(caught);passed++;};
 try {
  await query('BEGIN'); await query("SET LOCAL statement_timeout='25s'");
  await query(await fs.readFile('scripts/sql/001-agenda-integration.sql','utf8'));
  const p=randomUUID(),p2=randomUUID(),d=randomUUID(),d2=randomUUID(),a=randomUUID();
  for(const [id,role] of [[p,'PATIENT'],[p2,'PATIENT'],[d,'DOCTOR'],[d2,'DOCTOR'],[a,'ADMIN']]){
   await query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',[id,`telecus-test-${id}@example.test`,JSON.stringify({full_name:'PRUEBA TeleCUS'})]);
   await query('UPDATE public.profiles SET role=$1 WHERE id=$2',[role,id]);
  }
  const day=new Date();day.setUTCDate(day.getUTCDate()+((8-day.getUTCDay())%7||7)+7);const date=day.toISOString().slice(0,10);
  const reserve={doctor_id:d,date,time:'14:00',reason:'PRUEBA TeleCUS'};const id=randomUUID();
  const first=await call('execute',[p,id,'reserve',reserve]);assert.match(first,/Pre-reserva/);passed++;
  assert.equal(await call('execute',[p,id,'reserve',reserve]),first);passed++;
  assert.equal(Number((await query('SELECT count(*) FROM public.appointment_logs WHERE details->>\'operation_id\'=$1',[id])).rows[0].count),1);passed++;
  const ap=(await query('SELECT * FROM public.appointments WHERE patient_id=$1',[p])).rows[0];
  assert.match(ap.code,/^TCUS-\d{4}-[0-9A-F]{6}$/);passed++;
  assert.equal((await call('availability',[p2,d,date])).includes('14:00'),false);passed++;
  const {Client}=require('pg');const cp=client.connectionParameters;
  const concurrent=new Client({host:cp.host,port:cp.port,user:cp.user,database:cp.database,password:client.password,ssl:cp.ssl,connectionTimeoutMillis:10000});
  try{await concurrent.connect();const lock=(await concurrent.query("SELECT pg_try_advisory_xact_lock(hashtextextended('telecus-doctor:'||$1,0)) AS locked",[d])).rows[0].locked;assert.equal(lock,false);passed++;}finally{await concurrent.end();}
  await expectFailure(()=>call('execute',[p2,randomUUID(),'reserve',reserve]),'23P01');
  await expectFailure(()=>call('execute',[p,randomUUID(),'reserve',{...reserve,time:'14:30'}]),'23505');
  await expectFailure(()=>call('execute',[p2,randomUUID(),'cancel',{appointment_code:ap.code}]),'42501');
  await expectFailure(()=>call('execute',[p,randomUUID(),'verify_payment',{appointment_code:ap.code}]),'42501');
  await expectFailure(()=>call('execute',[d,randomUUID(),'cancel',{appointment_code:ap.code}]),'42501');
  await expectFailure(()=>call('execute',[p,randomUUID(),'reschedule',{appointment_code:ap.code,date,time:'16:00'}]),'22023');
  await call('execute',[a,randomUUID(),'verify_payment',{appointment_code:ap.code}]);
  assert.equal((await query('SELECT status FROM public.appointments WHERE id=$1',[ap.id])).rows[0].status,'PRE_RESERVED');passed++;
  const delivery=await call('claim_delivery');assert.equal(delivery.stage,'calendar');passed++;
  assert.equal(await call('claim_delivery'),null);passed++;
  await call('finish_calendar',[delivery.id,delivery.lease_token,{calendar_event_id:'test-event',meet_url:'https://meet.google.com/test-only'}]);
  const confirmed=(await query('SELECT status,payment_status FROM public.appointments WHERE id=$1',[ap.id])).rows[0];assert.deepEqual(confirmed,{status:'CONFIRMED',payment_status:'VERIFIED'});passed++;
  const mail=await call('claim_delivery');assert.equal(mail.stage,'mail');await call('arm_mail',[mail.id,mail.lease_token]);
  await query("UPDATE telecus_integration.deliveries SET lease_until=now()-interval '1 minute' WHERE id=$1",[mail.id]);
  assert.equal(await call('claim_delivery'),null);assert.equal((await query('SELECT status FROM telecus_integration.deliveries WHERE id=$1',[mail.id])).rows[0].status,'review');passed++;
  // Simulate an administrator resolving an uncertain send in this rollback-only test.
  await query("UPDATE telecus_integration.deliveries SET status='done' WHERE id=$1",[mail.id]);
  await call('execute',[p,randomUUID(),'reschedule',{appointment_code:ap.code,date,time:'15:00'}]);
  const req=(await query('SELECT * FROM public.appointment_change_requests WHERE appointment_id=$1',[ap.id])).rows[0];assert.equal(req.status,'PENDING');passed++;
  assert.equal(new Date((await query('SELECT start_time FROM public.appointments WHERE id=$1',[ap.id])).rows[0].start_time).getUTCHours(),19);passed++;
  await expectFailure(()=>call('execute',[p,randomUUID(),'cancel',{appointment_code:ap.code}]),'23505');
  await call('execute',[a,randomUUID(),'approve_change',{request_id:req.id}]);
  const reschedule=await call('claim_delivery');assert.equal(reschedule.operation,'reschedule');passed++;
  await expectFailure(()=>call('execute',[p2,randomUUID(),'reserve',{doctor_id:d,date,time:'15:00'}]),'23P01');
  await call('finish_calendar',[reschedule.id,reschedule.lease_token,{calendar_event_id:'test-event',meet_url:'https://meet.google.com/test-only'}]);
  assert.equal((await query('SELECT status FROM public.appointment_change_requests WHERE id=$1',[req.id])).rows[0].status,'APPROVED');passed++;
  const mail2=await call('claim_delivery');await call('arm_mail',[mail2.id,mail2.lease_token]);await call('finish_mail',[mail2.id,mail2.lease_token,'test-mail']);
  await expectFailure(()=>call('execute',[d,randomUUID(),'complete',{appointment_code:ap.code}]),'22023');
  await call('execute',[p,randomUUID(),'cancel',{appointment_code:ap.code}]);
  const rejected=(await query("SELECT id FROM public.appointment_change_requests WHERE appointment_id=$1 AND status='PENDING'",[ap.id])).rows[0];
  await call('execute',[a,randomUUID(),'reject_change',{request_id:rejected.id}]);assert.equal((await query('SELECT status FROM public.appointments WHERE id=$1',[ap.id])).rows[0].status,'RESCHEDULED');passed++;
  await query("UPDATE public.appointments SET start_time='2020-01-06T19:00:00Z',end_time='2020-01-06T19:30:00Z' WHERE id=$1",[ap.id]);
  await call('execute',[d,randomUUID(),'complete',{appointment_code:ap.code}]);
  assert.equal((await query('SELECT completed_by FROM public.appointments WHERE id=$1',[ap.id])).rows[0].completed_by,d);passed++;
  const completion=await call('claim_delivery');assert.equal(completion.operation,'complete');assert.equal(completion.stage,'mail');passed++;
  await call('arm_mail',[completion.id,completion.lease_token]);await call('finish_mail',[completion.id,completion.lease_token,'completion-mail']);
  await call('execute',[p2,randomUUID(),'reserve',{doctor_id:d2,date,time:'14:00'}]);
  const second=(await query('SELECT * FROM public.appointments WHERE patient_id=$1',[p2])).rows[0];
  await call('execute',[a,randomUUID(),'assign_doctor',{appointment_code:second.code,doctor_id:d}]);
  assert.equal((await query('SELECT doctor_id FROM public.appointments WHERE id=$1',[second.id])).rows[0].doctor_id,d);passed++;
  await call('execute',[p2,randomUUID(),'reschedule',{appointment_code:second.code,date,time:'14:30'}]);
  assert.equal((await query('SELECT status FROM public.appointments WHERE id=$1',[second.id])).rows[0].status,'PRE_RESERVED');passed++;
  await call('execute',[p2,randomUUID(),'cancel',{appointment_code:second.code}]);
  assert.equal((await query('SELECT status FROM public.appointments WHERE id=$1',[second.id])).rows[0].status,'CANCELLED');passed++;
  await call('execute',[p2,randomUUID(),'reserve',{doctor_id:d2,date,time:'14:00'}]);
  const third=(await query("SELECT * FROM public.appointments WHERE patient_id=$1 AND status='PRE_RESERVED'",[p2])).rows[0];
  await call('execute',[a,randomUUID(),'verify_payment',{appointment_code:third.code}]);
  const failed=await call('claim_delivery');await call('fail_delivery',[failed.id,failed.lease_token,'calendar_failed']);
  assert.equal((await query('SELECT status FROM public.appointments WHERE id=$1',[third.id])).rows[0].status,'PRE_RESERVED');passed++;
  await query("UPDATE telecus_integration.deliveries SET available_at=now()-interval '1 minute' WHERE id=$1",[failed.id]);
  const recovered=await call('claim_delivery');assert.notEqual(recovered.lease_token,failed.lease_token);passed++;
  await expectFailure(()=>call('finish_calendar',[failed.id,failed.lease_token,{calendar_event_id:'test-event',meet_url:'https://meet.google.com/test-only'}]),'40001');
  await query("UPDATE telecus_integration.deliveries SET expected_updated_at=expected_updated_at-interval '1 minute' WHERE id=$1",[failed.id]);
  assert.equal(await call('finish_calendar',[recovered.id,recovered.lease_token,{calendar_event_id:'test-event',meet_url:'https://meet.google.com/test-only'}]),false);passed++;
  assert.equal((await query('SELECT status FROM telecus_integration.deliveries WHERE id=$1',[failed.id])).rows[0].status,'review');passed++;
  await query('UPDATE public.profiles SET active=false WHERE id=$1',[p2]);
  await expectFailure(()=>call('doctors',[p2]),'42501');
  await query('GRANT telecus_backend TO postgres'); // Rolled back with the test transaction.
  await query('SET LOCAL ROLE telecus_backend');
  assert.equal(await call('version'),1);passed++;
  await expectFailure(()=>query('SELECT * FROM public.appointments LIMIT 0'),'42501');
  await query('RESET ROLE'); await query('SET LOCAL ROLE authenticated');
  await expectFailure(()=>call('doctors',[p]),'42501');
  await query('RESET ROLE');
  const accounts=(await query('SELECT email,role,active FROM public.profiles WHERE email=ANY($1)',[['sergioortizparra@gmail.com','sergioortiz@unicauca.edu.co','citascus@gmail.com']])).rows;
  console.log(JSON.stringify({status:'ok',checks:passed,fixtureData:'rolled_back',migration:'rolled_back',accounts}));
 } finally {await query('ROLLBACK').catch(()=>{});await client.end();}
}
main().catch(e=>{console.error(JSON.stringify({status:'failed',code:e.code||e.name,message:e.message}));process.exitCode=1;});
