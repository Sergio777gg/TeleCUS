// Owner credential only via private stdin. Every fixture and schema trial is rolled back.
const fs=require('node:fs/promises'),crypto=require('node:crypto'),assert=require('node:assert/strict'),path=require('node:path');
process.chdir(path.resolve(__dirname,'..'));
async function main(){
 const client=await require('./db-admin.cjs')();let checks=0;
 const query=(sql,args=[])=>client.query(sql,args),check=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
 const call=async(name,args=[])=>{
  await query('SAVEPOINT admin_call');
  try{await query('SET LOCAL ROLE telecus_backend');const result=(await query('SELECT telecus_integration.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') AS result',args)).rows[0].result;await query('RESET ROLE');await query('RELEASE SAVEPOINT admin_call');return result;}
  catch(e){await query('ROLLBACK TO SAVEPOINT admin_call');await query('RELEASE SAVEPOINT admin_call');throw e;}
 };
 const denied=async(fn,code)=>{await query('SAVEPOINT denied_admin');try{await assert.rejects(fn,e=>e.code===code);checks++;}finally{await query('ROLLBACK TO SAVEPOINT denied_admin');await query('RELEASE SAVEPOINT denied_admin');}};
 try{
  await query('BEGIN');await query("SET LOCAL statement_timeout='30s'");await query('GRANT telecus_backend,authenticated,anon TO postgres');
  await query(await fs.readFile('scripts/sql/005-administration.sql','utf8'));
  const patient=crypto.randomUUID(),other=crypto.randomUUID(),doctor=crypto.randomUUID(),admin=crypto.randomUUID(),admin2=crypto.randomUUID();
  for(const [id,role]of [[patient,'PATIENT'],[other,'PATIENT'],[doctor,'DOCTOR'],[admin,'ADMIN'],[admin2,'ADMIN']]){
   await query("INSERT INTO auth.users(id,email,created_at,email_confirmed_at,raw_user_meta_data) VALUES($1,$2,now(),now(),$3)",[id,'telecus-admin-'+id+'@example.test',JSON.stringify({full_name:'PRUEBA_ADMIN_'+id})]);
   await query('UPDATE public.profiles SET role=$1,active=true,full_name=$2 WHERE id=$3',[role,'PRUEBA_ADMIN_'+id,id]);
  }
  check(await call('administration_version'),1);check(await call('payment_receipts_version'),2);
  await denied(()=>call('administration_read',[patient,'people','{}']),'42501');
  await denied(async()=>{await query('SET LOCAL ROLE telecus_backend');await query('SELECT * FROM telecus_integration.admin_audit');},'42501');
  await denied(async()=>{await query('SET LOCAL ROLE authenticated');await query('SELECT telecus_integration.administration_read($1,$2,$3)',[admin,'people','{}']);},'42501');
  const read=(resource,filter={})=>call('administration_read',[admin,resource,JSON.stringify(filter)]);
  const write=(resource,expected,payload,request=crypto.randomUUID(),actor=admin)=>call('administration_write',[actor,request,resource,expected,JSON.stringify(payload)]);
  const cfg=await read('settings'),cfgRequest=crypto.randomUUID(),cfgBody={payment_url:'https://pago.example.test/prueba',support_phone:'573148336862'};
  const saved=await write('settings',cfg.version,cfgBody,cfgRequest);check(await write('settings',cfg.version,cfgBody,cfgRequest),saved);
  check((await call('portal_settings')).payment_url,cfgBody.payment_url);
  await denied(()=>write('settings',cfg.version,cfgBody),'P0002');
  await denied(()=>write('settings',String(Number(cfg.version)+1),{...cfgBody,payment_url:'javascript:alert(1)'}),'22023');
  await denied(()=>write('settings',cfg.version,cfgBody,crypto.randomUUID(),patient),'42501');
  const future=new Date();future.setUTCDate(future.getUTCDate()+((8-future.getUTCDay())%7||7));const date=future.toISOString().slice(0,10);
  await call('execute',[patient,crypto.randomUUID(),'reserve',JSON.stringify({doctor_id:doctor,date,time:'14:00',reason:'PRUEBA ADMIN SIN VALOR FINANCIERO'})]);
  const appointment=(await query('SELECT id,code FROM public.appointments WHERE patient_id=$1',[patient])).rows[0];
  let people=await read('people',{role:'DOCTOR',q:doctor}),target=people.items.find(p=>p.id===doctor);check(Boolean(target),true);
  await denied(()=>write('profile',target.version,{id:doctor,full_name:target.full_name,role:'DOCTOR',active:false}),'P0002');
  await write('profile',target.version,{id:doctor,full_name:'PRUEBA_ADMIN_nombre_actualizado',role:'DOCTOR',active:true});
  await denied(()=>write('profile',target.version,{id:doctor,full_name:target.full_name,role:'DOCTOR',active:true}),'P0002');
  await denied(()=>write('profile','fake',{id:admin,full_name:'No autorizado',role:'PATIENT',active:true}),'42501');
  await denied(()=>write('profile','fake',{id:doctor,full_name:'No autorizado',role:'ADMIN',active:true}),'22023');
  const newId=crypto.randomUUID(),email='telecus-registration-'+newId+'@example.test';
  const registration=await write('registration','new',{email,full_name:'PRUEBA_REGISTRO',role:'DOCTOR'});check(registration.status,'registered');
  await denied(()=>write('registration','new',{email,full_name:'Duplicada',role:'PATIENT'}),'23505');
  await query("INSERT INTO auth.users(id,email,created_at,email_confirmed_at,raw_user_meta_data) VALUES($1,$2,now()+interval '1 second',NULL,'{}')",[newId,email]);
  await call('claim_registration',[newId]);check((await query('SELECT role FROM public.profiles WHERE id=$1',[newId])).rows[0].role,'PATIENT');
  await query('UPDATE auth.users SET email_confirmed_at=now() WHERE id=$1',[newId]);await call('claim_registration',[newId]);
  check((await query('SELECT role FROM public.profiles WHERE id=$1',[newId])).rows[0].role,'DOCTOR');
  await call('claim_registration',[newId]);check((await query("SELECT count(*)::integer AS n FROM telecus_integration.admin_audit WHERE action='registration_activated' AND target=$1",[newId])).rows[0].n,1);
  const catalog=[{file:'98_PRUEBA_ADMIN.md',title:'PRUEBA RAG',roles:['admin'],body:'# Documento sintético\nContenido inicial sin datos personales.'}];
  await call('seed_knowledge_catalog',[JSON.stringify(catalog)]);
  let detail=await read('knowledge',{file:catalog[0].file}),oldPublished=detail.published_id;
  await write('knowledge_save',detail.version,{file:detail.file,body:'# Prueba de publicación\nTexto sintético de la nueva versión.'});
  check((await call('published_knowledge')).find(d=>d.file===detail.file).body,catalog[0].body);
  detail=await read('knowledge',{file:detail.file});const revision=detail.versions.find(v=>v.id!==oldPublished).id;
  await write('knowledge_publish',detail.version,{file:detail.file,revision_id:revision});
  check((await call('published_knowledge')).find(d=>d.file===detail.file).version,revision);
  detail=await read('knowledge',{file:detail.file});await write('knowledge_publish',detail.version,{file:detail.file,revision_id:oldPublished});
  check((await call('published_knowledge')).find(d=>d.file===detail.file).version,oldPublished);
  await denied(()=>write('knowledge_save',String(Number(detail.version)+1),{file:detail.file,body:'# Sección\n'+'x'.repeat(4600)}),'22023');
  const bytes=Buffer.from('%PDF-1.7\nPRUEBA FICTICIA\n%%EOF\n'),digest=crypto.createHash('sha256').update(bytes).digest('hex'),file={file_name:'prueba.pdf',content_type:'application/pdf',size:bytes.length,sha256:digest,storage_key:crypto.createHash('sha256').update(patient+'\0'+appointment.id+'\0'+digest).digest('hex')},uploadRequest=crypto.randomUUID();
  const receipt=await call('upload_payment_receipt',[patient,appointment.id,uploadRequest,JSON.stringify(file)]);
  const review=await call('prepare_payment_review',[admin,appointment.id,crypto.randomUUID()]);check(review.receipt.id,receipt.id);
  await denied(()=>call('confirm_payment_review',[admin2,review.id]),'42501');
  await denied(()=>call('withdraw_payment_receipt',[other,receipt.id,crypto.randomUUID()]),'42501');
  const withdrawRequest=crypto.randomUUID();await call('withdraw_payment_receipt',[patient,receipt.id,withdrawRequest]);check((await call('withdraw_payment_receipt',[patient,receipt.id,withdrawRequest])).withdrawn,true);
  await denied(()=>call('confirm_payment_review',[admin,review.id]),'P0002');
  await denied(()=>call('upload_payment_receipt',[patient,appointment.id,uploadRequest,JSON.stringify(file)]),'23505');
  const replacement=await call('upload_payment_receipt',[patient,appointment.id,crypto.randomUUID(),JSON.stringify(file)]);check(replacement.id!==receipt.id,true);
  check((await call('download_payment_receipt',[patient,receipt.id])).sha256,digest);
  const expired=await call('prepare_payment_review',[admin,appointment.id,crypto.randomUUID()]);
  await query("UPDATE telecus_integration.payment_reviews SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);await denied(()=>call('confirm_payment_review',[admin,expired.id]),'P0002');
  const fresh=await call('prepare_payment_review',[admin,appointment.id,crypto.randomUUID()]),result=await call('confirm_payment_review',[admin,fresh.id]);check(result.status,'queued');check(await call('confirm_payment_review',[admin,fresh.id]),result);
  check((await query('SELECT payment_status FROM public.appointments WHERE id=$1',[appointment.id])).rows[0].payment_status,'PENDING');
  check((await query("SELECT count(*)::integer AS n FROM telecus_integration.deliveries WHERE appointment_id=$1 AND operation='confirm'",[appointment.id])).rows[0].n,1);
  await denied(()=>call('withdraw_payment_receipt',[patient,replacement.id,crypto.randomUUID()]),'P0002');
  await query('UPDATE public.profiles SET active=false WHERE id=$1',[admin]);await denied(()=>read('settings'),'42501');
  await query('ROLLBACK');console.log(JSON.stringify({status:'ok',checks,migration:'rolled_back',fixtures:'rolled_back',googleCalls:0,emailsSent:0,inferenceCalls:0}));
 }catch(e){await query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({status:'failed',checks,code:e.code||e.name,message:e.message}));process.exitCode=1;}finally{await client.end();}
}
main().catch(e=>{console.error(JSON.stringify({status:'connection_failed',code:e.code||e.name}));process.exitCode=1;});
