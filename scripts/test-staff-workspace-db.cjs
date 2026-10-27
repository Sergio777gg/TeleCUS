// Actual restricted-role integration, synthetic records, always rolled back. Google is never called.
const fs=require('node:fs/promises'),crypto=require('node:crypto'),path=require('node:path'),assert=require('node:assert/strict');
process.chdir(path.resolve(__dirname,'..'));
async function main(){
 const client=await require('./db-admin.cjs')();let checks=0;const q=(s,a=[])=>client.query(s,a),check=(a,b)=>{assert.deepEqual(a,b);checks++;};
 const call=async(name,args=[])=>{await q('SAVEPOINT staff_call');try{await q('SET LOCAL ROLE telecus_backend');const r=(await q('SELECT telecus_integration.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') AS result',args)).rows[0].result;await q('RESET ROLE');await q('RELEASE SAVEPOINT staff_call');return r;}catch(e){await q('ROLLBACK TO SAVEPOINT staff_call');await q('RELEASE SAVEPOINT staff_call');throw e;}};
 const denied=async(fn,code)=>{await q('SAVEPOINT staff_denied');try{await assert.rejects(fn,e=>e.code===code);checks++;}finally{await q('ROLLBACK TO SAVEPOINT staff_denied');await q('RELEASE SAVEPOINT staff_denied');}};
 try{
  await q('BEGIN');await q("SET LOCAL statement_timeout='30s'");await q('GRANT telecus_backend,authenticated TO postgres');
  if(!(await q("SELECT to_regprocedure('telecus_integration.workspace_version()') IS NOT NULL AS yes")).rows[0].yes)await q(await fs.readFile('scripts/sql/007-staff-workspace.sql','utf8'));
  check(await call('workspace_version'),1);const ids={};for(const role of ['patient','other','doctor','foreignDoctor','admin']){const id=crypto.randomUUID();ids[role]=id;await q("INSERT INTO auth.users(id,email,created_at,email_confirmed_at,raw_user_meta_data) VALUES($1,$2,now(),now(),'{}')",[id,'staff-'+id+'@example.test']);await q('UPDATE public.profiles SET role=$1,active=true,full_name=$2 WHERE id=$3',[role==='admin'?'ADMIN':role.includes('octor')?'DOCTOR':'PATIENT','PRUEBA_PANEL_'+role,id]);}
  await denied(()=>call('workspace_appointments',[ids.patient,'{}']),'42501');
  await denied(()=>call('workspace_requests',[ids.doctor,'{}']),'42501');
  await denied(async()=>{await q('SET LOCAL ROLE authenticated');await q('SELECT telecus_integration.workspace_appointments($1,$2)',[ids.admin,'{}']);},'42501');
  await denied(()=>call('execute_before007',[ids.admin,crypto.randomUUID(),'cancel','{}']),'42501');
  const future=new Date();future.setUTCDate(future.getUTCDate()+((8-future.getUTCDay())%7||7)+7);const date=future.toISOString().slice(0,10),book=await call('service_schedules');
  await call('execute',[ids.patient,crypto.randomUUID(),'reserve',JSON.stringify({doctor_id:ids.doctor,date,time:'14:00',reason:'PRUEBA PANEL',schedule_version:book.version})]);
  const a=(await q('SELECT * FROM public.appointments WHERE patient_id=$1',[ids.patient])).rows[0];
  check((await call('workspace_appointments',[ids.doctor,'{}'])).items.length,0);
  const adminPage=await call('workspace_appointments',[ids.admin,JSON.stringify({q:a.code})]);check(adminPage.items.length,1);check(adminPage.items[0].meet_url,undefined);
  await denied(()=>call('staff_snapshot',[ids.doctor,'cancel',JSON.stringify({appointment_code:a.code})]),'42501');
  await q("UPDATE public.appointments SET status='CONFIRMED',payment_status='VERIFIED',calendar_event_id='synthetic-test-event',meet_url='https://meet.google.com/aaa-bbbb-ccc' WHERE id=$1",[a.id]);
  check((await call('workspace_appointments',[ids.doctor,'{}'])).items[0].meet_url,'https://meet.google.com/aaa-bbbb-ccc');check((await call('workspace_appointments',[ids.foreignDoctor,'{}'])).items.length,0);
  await denied(()=>call('staff_snapshot',[ids.foreignDoctor,'complete',JSON.stringify({appointment_code:a.code})]),'42501');
  await denied(()=>call('staff_snapshot',[ids.doctor,'complete',JSON.stringify({appointment_code:a.code})]),'22023');
  const snap=await call('staff_snapshot',[ids.admin,'cancel',JSON.stringify({appointment_code:a.code})]);
  await q('UPDATE public.appointments SET doctor_id=$1 WHERE id=$2',[ids.foreignDoctor,a.id]);
  await denied(()=>call('execute',[ids.admin,crypto.randomUUID(),'cancel',JSON.stringify({appointment_code:a.code,expected_snapshot:snap.snapshot})]),'P0002');
  await q('UPDATE public.appointments SET doctor_id=$1 WHERE id=$2',[ids.doctor,a.id]);
  const past=new Date(future);past.setUTCDate(past.getUTCDate()-28);const pastDate=past.toISOString().slice(0,10);
  await q("UPDATE public.appointments SET start_time=($1||' 14:00')::timestamp AT TIME ZONE 'America/Bogota',end_time=($1||' 14:30')::timestamp AT TIME ZONE 'America/Bogota' WHERE id=$2",[pastDate,a.id]);
  const ready=await call('staff_snapshot',[ids.doctor,'complete',JSON.stringify({appointment_code:a.code})]),id=crypto.randomUUID(),payload=JSON.stringify({appointment_code:a.code,expected_snapshot:ready.snapshot});const result=await call('execute',[ids.doctor,id,'complete',payload]);check(await call('execute',[ids.doctor,id,'complete',payload]),result);
  check((await q('SELECT status FROM public.appointments WHERE id=$1',[a.id])).rows[0].status,'COMPLETED');
  check((await call('workspace_appointments',[ids.doctor,'{}'])).items.length,0);check((await call('workspace_appointments',[ids.doctor,JSON.stringify({view:'history'})])).items[0].code,a.code);
  check((await call('workspace_appointments',[ids.admin,JSON.stringify({view:'history',q:a.code})])).items[0].meet_url,undefined);
  const deliveries=(await q('SELECT count(*)::integer AS n FROM telecus_integration.deliveries WHERE operation_id=$1',[id])).rows[0].n;check(deliveries,1);
  await q('ROLLBACK');console.log(JSON.stringify({status:'ok',checks,fixtures:'rolled_back',googleCalls:0,inferenceCalls:0}));
 }catch(e){await q('ROLLBACK').catch(()=>{});console.error(JSON.stringify({status:'failed',code:e.code||e.name,checks,context:e.where?.split('\n').filter(x=>x.startsWith('PL/pgSQL function')).join(';'),detail:['42702','42703','42883','23502'].includes(e.code)?e.message:undefined,fixtures:'rolled_back'}));process.exitCode=1;}finally{await client.end();}
}
main().catch(e=>{console.error(JSON.stringify({status:'setup_failed',code:e.code||e.name}));process.exitCode=1;});
