// PostgreSQL integration with synthetic records, rollback only; never calls Google or inference.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
process.chdir(path.resolve(__dirname,'..'));
const migrations=['010-visit-workflow','011-clinical-documents','012-clinical-document-list','013-patient-workspace-and-change-notices','014-payment-history','015-public-rejection-reasons','016-notification-cleanup'];
async function run(client,{embedded=false}={}){
 let checks=0,stage='begin';const q=(s,a=[])=>client.query(s,a),eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
 const call=async(name,args=[])=>{await q('SAVEPOINT visit_call');try{await q('SET LOCAL ROLE telecus_backend');const r=await q('SELECT telecus_integration.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') AS result',args);await q('RESET ROLE');await q('RELEASE SAVEPOINT visit_call');return r.rows[0].result;}catch(e){await q('ROLLBACK TO SAVEPOINT visit_call');await q('RELEASE SAVEPOINT visit_call');throw e;}};
 const denied=async(fn,code)=>{await q('SAVEPOINT visit_denied');try{await assert.rejects(fn,e=>e.code===code);checks++;}finally{await q('ROLLBACK TO SAVEPOINT visit_denied');await q('RELEASE SAVEPOINT visit_denied');}};
 try{
  await q('BEGIN');await q("SET LOCAL statement_timeout='30s'");await q('GRANT telecus_backend,authenticated TO postgres');
  stage='migrations';for(const name of migrations){const capability=name.startsWith('010')?'visit_workflow_version':name.startsWith('011')?'clinical_documents_version':name.startsWith('012')?'clinical_document_list_version':name.startsWith('013')?'patient_workspace_version':name.startsWith('014')?'payment_history_version':name.startsWith('015')?'rejection_reasons_version':'notification_actions_version';const present=(await q('SELECT to_regprocedure($1) IS NOT NULL AS yes',['telecus_integration.'+capability+'()'])).rows[0].yes;if(!present)await q(await fs.readFile('scripts/sql/'+name+'.sql','utf8'));}
  eq(await call('visit_workflow_version'),1);eq(await call('clinical_documents_version'),1);
  stage='fixtures';const ids={};for(const role of ['patient','other','third','doctor','secondDoctor','admin']){const id=role.includes('Doctor')||role==='doctor'?'00000000-0000-4000-8000-'+crypto.randomBytes(6).toString('hex'):crypto.randomUUID();ids[role]=id;await q("INSERT INTO auth.users(id,email,created_at,email_confirmed_at,raw_user_meta_data) VALUES($1,$2,now(),now(),'{}')",[id,'visit-'+id+'@example.test']);await q('UPDATE public.profiles SET role=$1,active=true,full_name=$2 WHERE id=$3',[['doctor','secondDoctor'].includes(role)?'DOCTOR':role==='admin'?'ADMIN':'PATIENT','PRUEBA_TELECONSULTA',id]);}
  const book=await call('service_schedules'),today=(await q("SELECT (now() AT TIME ZONE 'America/Bogota')::date::text AS d")).rows[0].d;
  await call('save_service_schedule',[ids.admin,crypto.randomUUID(),book.version,JSON.stringify({days:[0,1,2,3,4,5,6],start:'14:00',end:'16:00',hold_hours:24,effective_from:today})]);
  const date=new Date(Date.now()+86400000*400).toISOString().slice(0,10);
  let settings=await call('portal_settings');
  const configure=async enabled=>{const before=await call('portal_settings');await call('administration_write',[ids.admin,crypto.randomUUID(),'settings',before.version,JSON.stringify({payment_url:before.payment_url,support_phone:before.support_phone,payments_enabled:enabled})]);settings=await call('portal_settings');};
  await denied(()=>call('administration_write',[ids.patient,crypto.randomUUID(),'settings',settings.version,JSON.stringify({...settings,payments_enabled:false})]),'42501');
  await configure(true);eq(settings.payments_enabled,true);
  const payload=()=>({date,time:'14:00',reason:'PRUEBA SINTETICA',appointment_type:'CHRONIC_FOLLOW_UP',visit_policy_version:settings.version});
  const reserve=async(actor,body=payload(),key=crypto.randomUUID())=>call('execute',[actor,key,'reserve',JSON.stringify(body)]);
  stage='free reservation';await configure(false);const body=payload(),key=crypto.randomUUID();const first=await reserve(ids.patient,body,key);eq(await reserve(ids.patient,body,key),first);
  const [a]=(await q('SELECT * FROM public.appointments WHERE patient_id=$1',[ids.patient])).rows;
  eq((await call('scoped_visit_appointments',[ids.patient,null]))[0].payment_status,'NOT_REQUIRED');eq(a.payment_status,'PENDING');
  eq((await q('SELECT count(*)::int AS n FROM telecus_integration.reservation_holds WHERE appointment_id=$1',[a.id])).rows[0].n,0);
  eq((await q("SELECT e.payload->>'payment_required' AS required FROM telecus_integration.notification_events e WHERE e.payload->>'code'=$1 ORDER BY e.id DESC LIMIT 1",[a.code])).rows[0].required,'false');
  const oldVersion=body.visit_policy_version;await configure(true);await denied(()=>reserve(ids.other,{...payload(),visit_policy_version:oldVersion}),'P0002');await reserve(ids.other);const [paid]=(await q('SELECT * FROM public.appointments WHERE patient_id=$1',[ids.other])).rows;eq(paid.doctor_id===a.doctor_id,false);eq((await call('scoped_visit_appointments',[ids.patient,null]))[0].payment_status,'NOT_REQUIRED');
  stage='security';await denied(()=>call('execute_free010',[ids.patient,crypto.randomUUID(),'reserve','{}']),'42501');await denied(async()=>{await q('SET LOCAL ROLE authenticated');await q('SELECT telecus_integration.execute($1,$2,$3,$4)',[ids.patient,crypto.randomUUID(),'reserve','{}']);},'42501');
  await denied(()=>call('prepare_payment_review',[ids.admin,a.id,crypto.randomUUID()]),'P0002');
  const file={file_name:'informe.pdf',content_type:'application/pdf',size:32,sha256:'a'.repeat(64),storage_key:'b'.repeat(64)},send={appointment_id:a.id,request_id:crypto.randomUUID(),...file};
  stage='clinical documents';const d=await call('clinical_documents',[ids.patient,'commit',JSON.stringify(send)]);eq((await call('clinical_documents',[ids.patient,'commit',JSON.stringify(send)])).id,d.id);
  eq((await call('clinical_documents',[a.doctor_id,'download',JSON.stringify({id:d.id})])).storage_key,file.storage_key);
  for(const actor of [ids.other,ids.admin])await denied(()=>call('clinical_documents',[actor,'download',JSON.stringify({id:d.id})]),'42501');
  await call('clinical_documents',[a.doctor_id,'review',JSON.stringify({id:d.id,version:1,status:'LEGIBLE'})]);await denied(()=>call('clinical_documents',[a.doctor_id,'review',JSON.stringify({id:d.id,version:1,status:'CORRECTION_REQUESTED'})]),'P0002');
  const notice=(await q("SELECT payload FROM telecus_integration.notification_events WHERE event_type='clinical_documents_updated' ORDER BY id DESC LIMIT 1")).rows[0].payload;eq(Object.keys(notice),['code']);
  stage='HTTP clinical attachments';const profile=(id,role)=>({id,role,active:true,full_name:'Synthetic test',email:'synthetic@example.test'});
  const {PostgresAgenda}=await import('../apps/backend/dist/integrations/agenda.js'),transportAgenda=Object.create(PostgresAgenda.prototype);transportAgenda.pool={query:async(sql,args)=>{try{return {rows:[{result:await call('clinical_documents',args)}]};}catch(e){if(['42702','42703','42883'].includes(e.code))console.error(JSON.stringify({syntheticDatabaseError:{code:e.code,message:e.message,context:e.where?.split('\n').filter(l=>l.startsWith('PL/pgSQL function')).join(';')}}));throw e;}}};
  const transport=await require('./verify-clinical-http.cjs')({metadata:{dispatch:(actor,action,input)=>transportAgenda.call('clinical_documents',[actor.id,action,JSON.stringify(input)])},patient:profile(ids.patient,'PATIENT'),otherPatient:profile(ids.other,'PATIENT'),doctor:profile(a.doctor_id,'DOCTOR'),admin:profile(ids.admin,'ADMIN'),appointmentId:a.id});checks+=transport.checks;
  stage='free confirmation';const snapshot=await call('staff_snapshot',[ids.admin,'confirm_free',JSON.stringify({appointment_code:a.code})]);const confirm={appointment_code:a.code,expected_snapshot:snapshot.snapshot};await call('execute',[ids.admin,crypto.randomUUID(),'confirm_free',JSON.stringify(confirm)]);
  eq((await q('SELECT status FROM public.appointments WHERE id=$1',[a.id])).rows[0].status,'PRE_RESERVED');
  // Simulate successful external I/O only: exercise the persisted DB completion callback.
  const delivery=(await q('SELECT id FROM telecus_integration.deliveries WHERE appointment_id=$1',[a.id])).rows[0];const lease=crypto.randomUUID();await q("UPDATE telecus_integration.deliveries SET status='running',lease_token=$1,lease_until=now()+interval '1 minute' WHERE id=$2",[lease,delivery.id]);
  eq(await call('finish_calendar',[delivery.id,lease,JSON.stringify({calendar_event_id:'synthetic-only',meet_url:'https://meet.google.com/aaa-bbbb-ccc'})]),true);
  const mapped=(await call('scoped_visit_appointments',[ids.patient,null]))[0];eq(mapped.status,'CONFIRMED');eq(mapped.payment_status,'NOT_REQUIRED');eq((await q('SELECT payment_status FROM public.appointments WHERE id=$1',[a.id])).rows[0].payment_status,'PENDING');
  eq((await call('workspace_appointments',[a.doctor_id,'{}'])).items.some(x=>x.id===a.id),true);
  stage='patient portal and cancellation notice';eq((await call('patient_workspace',[ids.patient,null])).items[0].id,a.id);eq((await call('patient_workspace',[ids.other,a.code])).items.length,0);await denied(()=>call('patient_workspace',[ids.admin,null]),'42501');
  eq((await call('clinical_documents',[ids.patient,'list',JSON.stringify({appointment_id:paid.id})])).items.length,0);
  await q("UPDATE telecus_integration.deliveries SET status='done' WHERE id=$1",[delivery.id]);await call('execute',[ids.patient,crypto.randomUUID(),'cancel',JSON.stringify({appointment_code:a.code})]);
  const change=(await q("SELECT id FROM public.appointment_change_requests WHERE appointment_id=$1 AND status='PENDING'",[a.id])).rows[0],approval=await call('staff_snapshot',[ids.admin,'approve_change',JSON.stringify({request_id:change.id})]);
  await call('execute',[ids.admin,crypto.randomUUID(),'approve_change',JSON.stringify({request_id:change.id,expected_snapshot:approval.snapshot})]);const cancelDelivery=(await q("SELECT id FROM telecus_integration.deliveries WHERE appointment_id=$1 AND operation='cancel'",[a.id])).rows[0];
  const noticeCount=async()=>Number((await q("SELECT count(*) AS n FROM telecus_integration.notifications n JOIN telecus_integration.notification_events e ON e.id=n.event_id WHERE n.recipient_id=$1 AND e.payload->>'code'=$2",[ids.admin,a.code])).rows[0].n),beforeNotices=await noticeCount();
  const cancelLease=crypto.randomUUID();await q("UPDATE telecus_integration.deliveries SET status='running',lease_token=$1,lease_until=now()+interval '1 minute' WHERE id=$2",[cancelLease,cancelDelivery.id]);eq(await call('finish_calendar',[cancelDelivery.id,cancelLease,'{}']),true);eq((await noticeCount())-beforeNotices,1);eq((await call('patient_workspace',[ids.patient,null])).items.length,0);eq((await call('patient_workspace',[ids.patient,a.code])).items[0].status,'CANCELLED');
  stage='payment history';eq(await call('payment_history_version'),1);
  const historyFilter=JSON.stringify({view:'history',q:paid.code}),history=()=>call('administration_read',[ids.admin,'payments',historyFilter]);
  eq((await history()).items.length,0);
  const digest='c'.repeat(64),storageKey=crypto.createHash('sha256').update(ids.other+'\0'+paid.id+'\0'+digest).digest('hex'),receipt=await call('upload_payment_receipt',[ids.other,paid.id,crypto.randomUUID(),JSON.stringify({...file,sha256:digest,storage_key:storageKey})]);
  await q("UPDATE public.appointments SET status='CONFIRMED',payment_status='VERIFIED' WHERE id=$1",[paid.id]);
  for(const status of ['CONFIRMED','COMPLETED','CANCELLED']){
   await q('UPDATE public.appointments SET status=$1 WHERE id=$2',[status,paid.id]);const page=await history();eq(page.items.length,1);eq(page.items[0].receipt.id,receipt.id);eq(page.items[0].status,status);eq(page.items[0].payment_status,'VERIFIED');eq(page.items[0].receipt.storage_key,undefined);eq((await call('download_payment_receipt',[ids.admin,receipt.id])).storage_key,storageKey);
  }
  await denied(()=>call('administration_read',[ids.patient,'payments',historyFilter]),'42501');await denied(()=>call('administration_read',[ids.doctor,'payments',historyFilter]),'42501');
  await denied(()=>call('download_payment_receipt',[ids.patient,receipt.id]),'42501');
  eq((await call('administration_read',[ids.admin,'payments',JSON.stringify({view:'history',q:'%',offset:0})])).items.length,0);
  eq((await call('administration_read',[ids.admin,'payments',JSON.stringify({view:'history',q:paid.code,offset:25})])).items.length,0);
  await denied(()=>call('administration_read',[ids.admin,'payments',JSON.stringify({view:'history',offset:-1})]),'22023');
  stage='public rejection reasons';eq(await call('rejection_reasons_version'),1);
  await configure(true);await reserve(ids.third,{...payload(),time:'15:00'});const rejectedAppointment=(await q('SELECT * FROM public.appointments WHERE patient_id=$1',[ids.third])).rows[0];
  await q("UPDATE public.appointments SET status='CONFIRMED',payment_status='VERIFIED' WHERE id=$1",[rejectedAppointment.id]);
  await call('execute',[ids.third,crypto.randomUUID(),'reschedule',JSON.stringify({appointment_code:rejectedAppointment.code,date,time:'15:30'})]);
  const pending=(await q("SELECT * FROM public.appointment_change_requests WHERE appointment_id=$1 AND status='PENDING'",[rejectedAppointment.id])).rows[0];
  const rejectSnapshot=await call('staff_snapshot',[ids.admin,'reject_change',JSON.stringify({request_id:pending.id})]),publicReason='El horario solicitado no está disponible. Puedes elegir otra fecha.',rejectBody={request_id:pending.id,expected_snapshot:rejectSnapshot.snapshot};
  await denied(()=>call('execute',[ids.admin,crypto.randomUUID(),'reject_change',JSON.stringify(rejectBody)]),'22023');
  await denied(()=>q("UPDATE public.appointment_change_requests SET status='REJECTED' WHERE id=$1",[pending.id]),'22023');
  await denied(()=>call('execute',[ids.third,crypto.randomUUID(),'reject_change',JSON.stringify({...rejectBody,rejection_category:'availability',public_reason:publicReason})]),'42501');
  const commandAgenda=Object.create(PostgresAgenda.prototype);commandAgenda.call=(name,args)=>call(name,args);
  const rejectKey=crypto.randomUUID(),fullReject={...rejectBody,rejection_category:'availability',public_reason:publicReason};const rejected=await commandAgenda.execute(profile(ids.admin,'ADMIN'),rejectKey,'reject_change',fullReject);eq(await commandAgenda.execute(profile(ids.admin,'ADMIN'),rejectKey,'reject_change',fullReject),rejected);
  eq((await call('public_rejections',[ids.third,JSON.stringify([pending.id])]))[0].public_reason,publicReason);eq((await call('public_rejections',[ids.patient,JSON.stringify([pending.id])])).length,0);await denied(()=>call('public_rejections',[ids.doctor,JSON.stringify([pending.id])]),'42501');
  eq((await call('workspace_requests',[ids.admin,JSON.stringify({view:'history',q:rejectedAppointment.code})])).items[0].public_reason,publicReason);
  eq((await q("SELECT e.payload->>'public_reason' AS reason FROM telecus_integration.notification_events e WHERE e.event_type='change_rejected' AND e.payload->>'code'=$1",[rejectedAppointment.code])).rows[0].reason,publicReason);
  eq((await q('SELECT status FROM public.appointments WHERE id=$1',[rejectedAppointment.id])).rows[0].status,'CONFIRMED');
  await denied(()=>call('execute_before015',[ids.admin,crypto.randomUUID(),'reject_change',JSON.stringify(rejectBody)]),'42501');
  stage='notification cleanup';eq(await call('notification_actions_version'),1);
  const inbox=()=>call('list_notifications',[ids.third,null,20]),initialInbox=await inbox();eq(initialInbox.unread>0,true);
  const readId=initialInbox.items[0].id;await call('read_notifications',[ids.third,JSON.stringify([readId])]);const readInbox=await inbox(),batch=crypto.randomUUID();
  const eventCount=Number((await q('SELECT count(*) AS n FROM telecus_integration.notification_events')).rows[0].n),rowCount=Number((await q('SELECT count(*) AS n FROM telecus_integration.notifications')).rows[0].n);
  eq(await call('dismiss_notifications',[ids.third,'[]',true,batch]),1);eq(await call('dismiss_notifications',[ids.third,'[]',true,batch]),1);eq((await inbox()).unread,readInbox.unread);eq((await inbox()).read_count,0);eq((await inbox()).items.some(n=>n.id===readId),false);
  await denied(()=>call('restore_notifications',[ids.other,batch]),'42501');await denied(()=>call('dismiss_notifications',[ids.other,'[]',true,batch]),'42501');
  const foreignInbox=await call('list_notifications',[ids.other,null,20]),foreignId=foreignInbox.items[0].id,foreignBatch=crypto.randomUUID();eq(await call('dismiss_notifications',[ids.third,JSON.stringify([foreignId]),false,foreignBatch]),0);eq((await call('list_notifications',[ids.other,null,20])).items.some(n=>n.id===foreignId),true);
  eq(await call('restore_notifications',[ids.third,batch]),1);eq(await call('restore_notifications',[ids.third,batch]),0);eq(await call('dismiss_notifications',[ids.third,'[]',true,batch]),1);eq((await inbox()).read_count,1);
  eq(Number((await q('SELECT count(*) AS n FROM telecus_integration.notification_events')).rows[0].n),eventCount);eq(Number((await q('SELECT count(*) AS n FROM telecus_integration.notifications')).rows[0].n),rowCount);
  eq((await q('SELECT status FROM public.appointments WHERE id=$1',[rejectedAppointment.id])).rows[0].status,'CONFIRMED');
  await q('ROLLBACK');return {status:'ok',engine:embedded?'embedded-postgresql':'supabase-postgresql',checks,fixtures:'rolled_back',googleCalls:0,inferenceCalls:0};
 }catch(e){await q('ROLLBACK').catch(()=>{});throw Object.assign(e,{stage,checks});}
}
module.exports={run,migrations};
if(require.main===module)(async()=>{const client=await require('./db-admin.cjs')();try{console.log(JSON.stringify(await run(client)));}finally{await client.end();}})().catch(e=>{console.error(JSON.stringify({status:'failed',stage:e.stage,checks:e.checks,code:e.code||e.name,detail:['42702','42703','42883','42P13'].includes(e.code)?e.message:undefined}));process.exitCode=1;});
