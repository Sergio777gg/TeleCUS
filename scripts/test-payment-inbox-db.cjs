// Actual restricted-role integration, synthetic records, always rolled back. Google is never called.
const fs=require('node:fs/promises'),crypto=require('node:crypto'),path=require('node:path'),assert=require('node:assert/strict');
process.chdir(path.resolve(__dirname,'..'));
async function main(){
 const client=await require('./db-admin.cjs')();let checks=0;const q=(s,a=[])=>client.query(s,a),check=(a,b)=>{assert.deepEqual(a,b);checks++;};
 const call=async(name,args=[])=>{await q('SAVEPOINT staff_call');try{await q('SET LOCAL ROLE telecus_backend');const r=(await q('SELECT telecus_integration.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') AS result',args)).rows[0].result;await q('RESET ROLE');await q('RELEASE SAVEPOINT staff_call');return r;}catch(e){await q('ROLLBACK TO SAVEPOINT staff_call');await q('RELEASE SAVEPOINT staff_call');throw e;}};
 const denied=async(fn,code)=>{await q('SAVEPOINT staff_denied');try{await assert.rejects(fn,e=>e.code===code);checks++;}finally{await q('ROLLBACK TO SAVEPOINT staff_denied');await q('RELEASE SAVEPOINT staff_denied');}};
 try{
  await q('BEGIN');await q("SET LOCAL statement_timeout='30s'");await q('GRANT telecus_backend,authenticated TO postgres');await q(await fs.readFile('scripts/sql/009-payment-inbox.sql','utf8'));
  const ids={};for(const role of ['doctor','admin','patient']){ids[role]=crypto.randomUUID();await q("INSERT INTO auth.users(id,email,created_at,email_confirmed_at,raw_user_meta_data) VALUES($1,$2,now(),now(),'{}')",[ids[role],'inbox-'+ids[role]+'@example.test']);await q('UPDATE public.profiles SET role=$1,active=true,full_name=$2 WHERE id=$3',[role==='admin'?'ADMIN':role==='doctor'?'DOCTOR':'PATIENT','PRUEBA_BANDEJA',ids[role]]);}
  const read=(view='received',offset=0,actor=ids.admin)=>call('administration_read',[actor,'payments',JSON.stringify({view,offset})]);
  await denied(()=>read('received',0,ids.patient),'42501');await denied(()=>read('wrong'),'22023');await denied(()=>read('received',-1),'22023');
  const before=(await call('workspace_appointments',[ids.admin,'{}'])).counts,book=await call('service_schedules'),today=(await q("SELECT (now() AT TIME ZONE 'America/Bogota')::date::text AS d")).rows[0].d;
  const policy=await call('save_service_schedule',[ids.admin,crypto.randomUUID(),book.version,JSON.stringify({days:[0,1,2,3,4,5,6],start:'09:00',end:'23:00',hold_hours:24,effective_from:today})]);
  const future=new Date(today+'T12:00:00Z');future.setUTCDate(future.getUTCDate()+30);const date=future.toISOString().slice(0,10),appointments=[],receipts=[];
  for(let i=0;i<29;i++){
   const patient=crypto.randomUUID();await q("INSERT INTO auth.users(id,email,created_at,email_confirmed_at,raw_user_meta_data) VALUES($1,$2,now(),now(),'{}')",[patient,'inbox-'+patient+'@example.test']);await q("UPDATE public.profiles SET role='PATIENT',active=true WHERE id=$1",[patient]);
   const d=new Date(future);d.setUTCDate(d.getUTCDate()+Math.floor(i/28));const n=9*60+(i%28)*30,time=String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
   await call('execute',[patient,crypto.randomUUID(),'reserve',JSON.stringify({doctor_id:ids.doctor,date:d.toISOString().slice(0,10),time,reason:'PRUEBA BANDEJA',schedule_version:policy.version})]);
   const a=(await q('SELECT id,code FROM public.appointments WHERE patient_id=$1',[patient])).rows[0];appointments.push({...a,patient});
   if(i!==27){const digest=crypto.createHash('sha256').update('SYNTHETIC').digest('hex'),meta={file_name:'prueba.pdf',content_type:'application/pdf',size:9,sha256:digest,storage_key:crypto.createHash('sha256').update(patient+'\0'+a.id+'\0'+digest).digest('hex')};receipts.push(await call('upload_payment_receipt',[patient,a.id,crypto.randomUUID(),JSON.stringify(meta)]));}
  }
  const first=await read();check(first.items.length,25);check(first.next_offset,25);
  async function all(view){const out=[];let offset=0;for(let i=0;i<100;i++){const page=await read(view,offset);out.push(...page.items);if(page.next_offset==null)return out;offset=page.next_offset;}throw Error('Pagination loop');}
  const owned=new Set(appointments.map(a=>a.id)),own=items=>items.filter(a=>owned.has(a.appointment_id));
  check(own(await all('received')).length,28);check(own(await all('awaiting')).length,1);check(own(await all('processing')).length,0);check(new Set((await all('received')).map(a=>a.appointment_id)).size,(await all('received')).length);
  const after=(await call('workspace_appointments',[ids.admin,'{}'])).counts;check(after.pending_payments-before.pending_payments,28);check(after.awaiting_receipt-before.awaiting_receipt,1);
  await call('withdraw_payment_receipt',[appointments[0].patient,receipts[0].id,crypto.randomUUID()]);check(own(await all('received')).length,27);check(own(await all('awaiting')).length,2);
  const prepared=await call('prepare_payment_review',[ids.admin,appointments[28].id,crypto.randomUUID()]);await call('confirm_payment_review',[ids.admin,prepared.id]);
  check(own(await all('processing')).length,1);check(own(await all('received')).length,26);check(own(await all('awaiting')).length,2);
  const final=(await call('workspace_appointments',[ids.admin,'{}'])).counts;check(final.pending_payments-before.pending_payments,26);check(final.awaiting_receipt-before.awaiting_receipt,2);
  check((await q("SELECT count(*)::int AS n FROM public.appointments WHERE patient_id=ANY($1::uuid[]) AND payment_status='PENDING'",[appointments.map(a=>a.patient)])).rows[0].n,29);
  const def=(await q("SELECT pg_get_functiondef('telecus_integration.administration_read(uuid,text,jsonb)'::regprocedure) AS body")).rows[0].body;check(/expire_holds/.test(def),false);
  await q('ROLLBACK');console.log(JSON.stringify({status:'ok',checks,fixtures:'rolled_back',googleCalls:0,inferenceCalls:0}));
 }catch(e){await q('ROLLBACK').catch(()=>{});console.error(JSON.stringify({status:'failed',code:e.code||e.name,checks,detail:['42702','42703','42883','23502'].includes(e.code)?e.message:undefined,context:e.where?.split('\n').filter(x=>x.startsWith('PL/pgSQL function')).join(';'),fixtures:'rolled_back'}));process.exitCode=1;}finally{await client.end();}
}
main().catch(e=>{console.error(JSON.stringify({status:'setup_failed',code:e.code||e.name}));process.exitCode=1;});
