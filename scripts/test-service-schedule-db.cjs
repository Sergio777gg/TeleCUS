// Synthetic fixtures and migration trial in ONE transaction, always rolled back. No Google calls.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
process.chdir(path.resolve(__dirname,'..'));
async function main(){
 const client=await require('./db-admin.cjs')();let checks=0;const q=(s,a=[])=>client.query(s,a),check=(a,b)=>{assert.deepEqual(a,b);checks++;};
 const call=async(name,args=[])=>{await q('SAVEPOINT schedule_call');try{await q('SET LOCAL ROLE telecus_backend');const r=(await q('SELECT telecus_integration.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') AS result',args)).rows[0].result;await q('RESET ROLE');await q('RELEASE SAVEPOINT schedule_call');return r;}catch(e){await q('ROLLBACK TO SAVEPOINT schedule_call');await q('RELEASE SAVEPOINT schedule_call');throw e;}};
 const denied=async(fn,code)=>{await q('SAVEPOINT schedule_denied');try{await assert.rejects(fn,e=>e.code===code);checks++;}finally{await q('ROLLBACK TO SAVEPOINT schedule_denied');await q('RELEASE SAVEPOINT schedule_denied');}};
 try{
  await q('BEGIN');await q("SET LOCAL statement_timeout='30s'");await q('GRANT telecus_backend,authenticated,anon TO postgres');
  const installed=(await q("SELECT to_regprocedure('telecus_integration.schedule_version()') IS NOT NULL AS yes")).rows[0].yes;
  if(!installed)await q(await fs.readFile('scripts/sql/006-service-schedule.sql','utf8'));
  check(await call('schedule_version'),1);
  const users={};for(const role of ['patient','other','third','doctor','admin']){const id=crypto.randomUUID();users[role]=id;await q("INSERT INTO auth.users(id,email,created_at,email_confirmed_at,raw_user_meta_data) VALUES($1,$2,now(),now(),'{}')",[id,'schedule-'+id+'@example.test']);await q('UPDATE public.profiles SET role=$1,active=true,full_name=$2 WHERE id=$3',[role==='admin'?'ADMIN':role==='doctor'?'DOCTOR':'PATIENT','PRUEBA_HORARIO_'+role,id]);}
  const book=await call('service_schedules');check(Array.isArray(book.items),true);
  await denied(async()=>{await q('SET LOCAL ROLE telecus_backend');await q('SELECT * FROM telecus_integration.reservation_holds');},'42501');
  await denied(async()=>{await q('SET LOCAL ROLE authenticated');await q('SELECT telecus_integration.service_schedules()');},'42501');
  await denied(()=>call('execute_before006',[users.patient,crypto.randomUUID(),'reserve','{}']),'42501');
  const today=(await q("SELECT (now() AT TIME ZONE 'America/Bogota')::date::text AS d")).rows[0].d;
  const d=new Date(today+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+14+(2-d.getUTCDay()+7)%7);const date=d.toISOString().slice(0,10);
  const monday=new Date(d);monday.setUTCDate(monday.getUTCDate()-1);
  const body={days:[2,4],start:'09:00',end:'11:00',effective_from:today,hold_hours:24};const request=crypto.randomUUID();
  const save=(expected,payload=body,id=crypto.randomUUID(),actor=users.admin)=>call('save_service_schedule',[actor,id,expected,JSON.stringify(payload)]);
  await denied(()=>save(book.version,body,crypto.randomUUID(),users.patient),'42501');
  const saved=await save(book.version,body,request);check(await save(book.version,body,request),saved);
  await denied(()=>save(book.version),'P0002');
  await denied(()=>save(saved.version,{...body,days:[2,2]}),'22023');
  await denied(()=>save(saved.version,{...body,start:'08:15'}),'22023');
  await denied(()=>save(saved.version,{...body,effective_from:'2026-02-31'}),'22023');
  await denied(()=>save(saved.version,{...body,hold_hours:0}),'22023');
  check(await call('availability',[users.patient,users.doctor,date]),['09:00','09:30','10:00','10:30']);
  check(await call('availability',[users.patient,users.doctor,monday.toISOString().slice(0,10)]),[]);
  const reserve=(actor,time='09:00',version=saved.version,id=crypto.randomUUID())=>call('execute',[actor,id,'reserve',JSON.stringify({doctor_id:users.doctor,date,time,reason:'PRUEBA SIN DATOS CLINICOS',schedule_version:version})]);
  const operation=crypto.randomUUID();const result=await reserve(users.patient,'09:00',saved.version,operation);check(await reserve(users.patient,'09:00',saved.version,operation),result);
  const a=(await q('SELECT id,code,start_time,end_time FROM public.appointments WHERE patient_id=$1',[users.patient])).rows[0];
  const hold=(await q('SELECT expires_at,created_at FROM telecus_integration.reservation_holds WHERE appointment_id=$1',[a.id])).rows[0];check(Number(new Date(hold.expires_at)-new Date(hold.created_at)),86400000);
  await denied(()=>reserve(users.other),'23P01');
  const fileFor=(patient,appointment)=>{const digest=crypto.createHash('sha256').update('SYNTHETIC').digest('hex');return JSON.stringify({file_name:'prueba.pdf',content_type:'application/pdf',size:9,sha256:digest,storage_key:crypto.createHash('sha256').update(patient+'\0'+appointment+'\0'+digest).digest('hex')});};
  await q("UPDATE telecus_integration.reservation_holds SET expires_at=now()-interval '1 second' WHERE appointment_id=$1",[a.id]);
  await denied(()=>call('upload_payment_receipt',[users.patient,a.id,crypto.randomUUID(),fileFor(users.patient,a.id)]),'P0002');
  check(await call('expire_holds'),1);check(await call('expire_holds'),0);
  check((await q('SELECT status FROM public.appointments WHERE id=$1',[a.id])).rows[0].status,'CANCELLED');
  check((await q("SELECT count(*)::integer AS n FROM public.appointment_logs WHERE appointment_id=$1 AND action='PRE_RESERVATION_EXPIRED'",[a.id])).rows[0].n,1);
  await reserve(users.other);const b=(await q('SELECT id,code,start_time FROM public.appointments WHERE patient_id=$1',[users.other])).rows[0];
  const receipt=await call('upload_payment_receipt',[users.other,b.id,crypto.randomUUID(),fileFor(users.other,b.id)]);
  await q("UPDATE telecus_integration.reservation_holds SET expires_at=now()-interval '1 second' WHERE appointment_id=$1",[b.id]);check(await call('expire_holds'),0);
  check((await q('SELECT status FROM public.appointments WHERE id=$1',[b.id])).rows[0].status,'PRE_RESERVED');
  const withdrawal=crypto.randomUUID();await call('withdraw_payment_receipt',[users.other,receipt.id,withdrawal]);
  const grace=(await q('SELECT expires_at FROM telecus_integration.reservation_holds WHERE appointment_id=$1',[b.id])).rows[0].expires_at;
  check(new Date(grace)>new Date(),true);await call('withdraw_payment_receipt',[users.other,receipt.id,withdrawal]);check((await q('SELECT expires_at FROM telecus_integration.reservation_holds WHERE appointment_id=$1',[b.id])).rows[0].expires_at,grace);
  await call('upload_payment_receipt',[users.other,b.id,crypto.randomUUID(),fileFor(users.other,b.id)]);
  const updated=await save(saved.version,{...body,start:'13:00',end:'15:00',hold_hours:2});
  check((await q('SELECT start_time FROM public.appointments WHERE id=$1',[b.id])).rows[0].start_time,b.start_time);
  await denied(()=>reserve(users.third,'13:00',saved.version),'P0002');
  const review=await call('prepare_payment_review',[users.admin,b.id,crypto.randomUUID()]);check((await call('confirm_payment_review',[users.admin,review.id])).status,'queued');
  check((await q("SELECT count(*)::integer AS n FROM telecus_integration.deliveries WHERE appointment_id=$1 AND operation='confirm'",[b.id])).rows[0].n,1);
  await reserve(users.third,'13:00',updated.version);check((await call('list_payment_receipts',[users.third])).items[0].expires_at!==undefined,true);
  check((await call('administration_read',[users.admin,'payments','{}'])).items.every(x=>x.expires_at!==undefined),true);
  await q('ROLLBACK');console.log(JSON.stringify({status:'ok',checks,fixtures:'rolled_back',googleCalls:0,inferenceCalls:0}));
 }catch(e){await q('ROLLBACK').catch(()=>{});console.error(JSON.stringify({status:'failed',code:e.code||e.name,context:e.where?.split('\n').filter(x=>x.startsWith('PL/pgSQL function')).join(';'),detail:['42702','42703','42883','23502'].includes(e.code)?e.message:undefined,checks,fixtures:'rolled_back'}));process.exitCode=1;}finally{await client.end();}
}
main().catch(e=>{console.error(JSON.stringify({status:'setup_failed',code:e.code||e.name}));process.exitCode=1;});
