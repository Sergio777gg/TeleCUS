// Real PostgreSQL, restricted backend functions, synthetic fixtures, no Google calls. ALWAYS rollback.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
process.chdir(path.resolve(__dirname,'..'));
async function main(){
 const client=await require('./db-admin.cjs')();let checks=0;
 const query=(s,a=[])=>client.query(s,a),check=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
 const call=async(name,args=[])=>{
   await query('SAVEPOINT restricted_call');
   try{await query('SET LOCAL ROLE telecus_backend');const result=(await query(`SELECT telecus_integration.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS result`,args)).rows[0].result;await query('RESET ROLE');await query('RELEASE SAVEPOINT restricted_call');return result;}
   catch(e){await query('ROLLBACK TO SAVEPOINT restricted_call');await query('RELEASE SAVEPOINT restricted_call');throw e;}
 };
 const denied=async(fn,code)=>{await query('SAVEPOINT denied');try{await assert.rejects(fn,e=>e.code===code);checks++;}finally{await query('ROLLBACK TO SAVEPOINT denied');await query('RELEASE SAVEPOINT denied');}};
 const page=(actor,before=null,limit=50)=>call('list_notifications',[actor,before,limit]);
 try{
  await query('BEGIN');await query("SET LOCAL statement_timeout='25s'");
  // Supabase's postgres is not superuser. Temporary membership enables testing the exact
  // restricted role, including its denied table access; this grant also rolls back.
  await query('GRANT telecus_backend TO postgres');
  await query(await fs.readFile('scripts/sql/002-notifications.sql','utf8'));
  await query(await fs.readFile('scripts/sql/003-notification-inputs.sql','utf8'));
  const p=randomUUID(),other=randomUUID(),doctor=randomUUID(),newDoctor=randomUUID(),admin=randomUUID();
  for(const [id,role]of [[p,'PATIENT'],[other,'PATIENT'],[doctor,'DOCTOR'],[newDoctor,'DOCTOR'],[admin,'ADMIN']]){
   await query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',[id,`telecus-test-${id}@example.test`,JSON.stringify({full_name:'PRUEBA TeleCUS'})]);
   await query('UPDATE public.profiles SET role=$1,active=true WHERE id=$2',[role,id]);
  }
  check(await call('notification_version'),2);
  await denied(async()=>{await query('SET LOCAL ROLE telecus_backend');await query('SELECT * FROM telecus_integration.notifications');},'42501');
  await denied(async()=>{await query('SET LOCAL ROLE authenticated');await query('SELECT telecus_integration.list_notifications($1,NULL,20)',[p]);},'42501');
  const future=new Date();future.setUTCDate(future.getUTCDate()+((8-future.getUTCDay())%7||7));const date=future.toISOString().slice(0,10);
  const reservation=randomUUID(),payload=JSON.stringify({doctor_id:doctor,date,time:'14:00',reason:'NOTIFICATION_TEST_SECRET_REASON'});
  await call('execute',[p,reservation,'reserve',payload]);
  const appointment=(await query('SELECT * FROM public.appointments WHERE patient_id=$1',[p])).rows[0];
  check((await page(p)).items.map(n=>n.event_type),['appointment_requested']);check((await page(doctor)).unread,0);check((await page(admin)).items[0].event_type,'appointment_requested');check((await page(other)).unread,0);
  const count=(await page(p)).unread;await call('execute',[p,reservation,'reserve',payload]);check((await page(p)).unread,count);
  check(JSON.stringify(await page(p)).includes('NOTIFICATION_TEST_SECRET_REASON'),false);
  await query('SAVEPOINT atomic_event');await query('UPDATE public.appointments SET status=\'CANCELLED\' WHERE id=$1',[appointment.id]);check((await page(p)).items[0].event_type,'appointment_cancelled');await query('ROLLBACK TO SAVEPOINT atomic_event');check((await page(p)).unread,1);check((await query('SELECT status FROM public.appointments WHERE id=$1',[appointment.id])).rows[0].status,'PRE_RESERVED');
  async function finish(operationId,cancel=false){
   const token=randomUUID();const delivery=(await query("UPDATE telecus_integration.deliveries SET status='running',lease_token=$2,lease_until=now()+interval '3 minutes' WHERE operation_id=$1 RETURNING id",[operationId,token])).rows[0];
   check(await call('finish_calendar',[delivery.id,token,JSON.stringify(cancel?{}:{calendar_event_id:'telecus-notification-test-'+operationId.replaceAll('-',''),meet_url:'https://meet.google.com/abc-defg-hij'})]),true);
   await query("UPDATE telecus_integration.deliveries SET status='done',lease_token=NULL,lease_until=NULL WHERE id=$1",[delivery.id]);
   return delivery.id;
  }
  const verification=randomUUID();await call('execute',[admin,verification,'verify_payment',JSON.stringify({appointment_code:appointment.code})]);
  check((await page(p)).unread,1);check((await page(doctor)).unread,0);const confirmedDelivery=await finish(verification);
  check((await page(p)).items[0].event_type,'appointment_confirmed');check((await page(doctor)).items[0].event_type,'appointment_confirmed');
  const mailLease=randomUUID();await query("UPDATE telecus_integration.deliveries SET status='sending',lease_token=$2,lease_until=now()+interval '3 minutes' WHERE id=$1",[confirmedDelivery,mailLease]);
  check(await call('fail_delivery',[confirmedDelivery,mailLease,'simulated_mail_failure']),true);check((await page(admin)).items[0].event_type,'integration_attention');
  const alerts=(await page(admin)).items.filter(n=>n.event_type==='integration_attention').length;
  check(await call('fail_delivery',[confirmedDelivery,mailLease,'retry']),false);check((await page(admin)).items.filter(n=>n.event_type==='integration_attention').length,alerts);
  await query("UPDATE telecus_integration.deliveries SET status='done' WHERE id=$1",[confirmedDelivery]);
  const assigned=randomUUID();await call('execute',[admin,assigned,'assign_doctor',JSON.stringify({appointment_code:appointment.code,doctor_id:newDoctor})]);await finish(assigned);
  check((await page(newDoctor)).items[0].event_type,'doctor_assigned');check((await page(doctor)).items[0].event_type,'appointment_unassigned');
  await call('execute',[p,randomUUID(),'cancel',JSON.stringify({appointment_code:appointment.code})]);
  const rejected=(await query("SELECT * FROM public.appointment_change_requests WHERE appointment_id=$1 AND status='PENDING'",[appointment.id])).rows[0];
  await call('execute',[admin,randomUUID(),'reject_change',JSON.stringify({request_id:rejected.id})]);
  check((await page(p)).items[0].event_type,'change_rejected');check((await query('SELECT status FROM public.appointments WHERE id=$1',[appointment.id])).rows[0].status,'CONFIRMED');check((await page(newDoctor)).unread,1);
  await call('execute',[p,randomUUID(),'cancel',JSON.stringify({appointment_code:appointment.code})]);
  const request=(await query("SELECT * FROM public.appointment_change_requests WHERE appointment_id=$1 AND status='PENDING'",[appointment.id])).rows[0];
  check((await page(p)).items[0].event_type,'change_requested');check((await page(admin)).items[0].event_type,'change_requested');
  const approval=randomUUID();await call('execute',[admin,approval,'approve_change',JSON.stringify({request_id:request.id})]);check((await page(p)).items[0].event_type,'change_requested');await finish(approval,true);
  check((await query('SELECT status FROM public.appointment_change_requests WHERE id=$1',[request.id])).rows[0].status,'APPROVED');
  check((await page(p)).items.slice(0,2).map(n=>n.event_type),['change_approved','appointment_cancelled']);check((await page(newDoctor)).items[0].event_type,'appointment_cancelled');
  const first=await page(p,null,2),second=await page(p,first.next_cursor,2);check(first.items.length,2);check(second.items.length,2);check(first.items.some(n=>second.items.some(m=>m.id===n.id)),false);
  check(await call('read_notifications',[other,JSON.stringify([first.items[0].id])]),0);
  check(await call('read_notifications',[p,JSON.stringify([first.items[0].id])]),1);check((await page(p)).items[0].read_at!==null,true);
  const unread=(await page(p)).unread;await call('read_notifications',[p,JSON.stringify([first.items[0].id])]);check((await page(p)).unread,unread);
  await denied(()=>page(p,null,1000),'22023');await denied(()=>page(p,null,null),'22023');
  await denied(()=>call('read_notifications',[p,'["bad-id"]']),'22023');await denied(()=>call('read_notifications',[p,null]),'22023');await denied(()=>call('read_notifications',[p,'[null]']),'22023');
  await query("UPDATE public.profiles SET role='ADMIN' WHERE id=$1",[p]);check((await page(p)).unread,0);
  await query('UPDATE public.profiles SET active=false WHERE id=$1',[p]);await denied(()=>page(p),'42501');
  await query('ROLLBACK');console.log(JSON.stringify({status:'ok',checks,storage:'real_postgresql',fixtures:'rolled_back',googleCalls:0}));
 }catch(e){await query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({status:'failed',checks,code:e.code||e.name,message:e.message}));process.exitCode=1;}finally{await client.end();}
}
main().catch(e=>{console.error(JSON.stringify({status:'connection_failed',code:e.code||e.name,reason:/timeout/i.test(e.message)?'connection_timeout':'setup_failed'}));process.exitCode=1;});
