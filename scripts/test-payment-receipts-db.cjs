// Restricted PostgreSQL calls with synthetic fixtures. ALWAYS rolls back; no Google or email.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
process.chdir(path.resolve(__dirname,'..'));
async function main(){
 const client=await require('./db-admin.cjs')();let checks=0;
 const query=(sql,args=[])=>client.query(sql,args),check=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
 const call=async(name,args=[])=>{
  await query('SAVEPOINT restricted_receipt_call');
  try{await query('SET LOCAL ROLE telecus_backend');const result=(await query(`SELECT telecus_integration.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS result`,args)).rows[0].result;await query('RESET ROLE');await query('RELEASE SAVEPOINT restricted_receipt_call');return result;}
  catch(e){await query('ROLLBACK TO SAVEPOINT restricted_receipt_call');await query('RELEASE SAVEPOINT restricted_receipt_call');throw e;}
 };
 const denied=async(fn,code)=>{await query('SAVEPOINT denied_receipt');try{await assert.rejects(fn,e=>e.code===code);checks++;}finally{await query('ROLLBACK TO SAVEPOINT denied_receipt');await query('RELEASE SAVEPOINT denied_receipt');}};
 try{
  await query('BEGIN');await query("SET LOCAL statement_timeout='25s'");await query('GRANT telecus_backend,authenticated TO postgres');
  await query(await fs.readFile('scripts/sql/004-payment-receipts.sql','utf8'));
  const patient=crypto.randomUUID(),other=crypto.randomUUID(),doctor=crypto.randomUUID(),admin=crypto.randomUUID();
  for(const [id,role]of[[patient,'PATIENT'],[other,'PATIENT'],[doctor,'DOCTOR'],[admin,'ADMIN']]){
   await query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',[id,`telecus-receipt-${id}@example.test`,JSON.stringify({full_name:'PRUEBA TeleCUS recibos'})]);
   await query('UPDATE public.profiles SET role=$1,active=true WHERE id=$2',[role,id]);
  }
  const future=new Date();future.setUTCDate(future.getUTCDate()+((8-future.getUTCDay())%7||7));const date=future.toISOString().slice(0,10);
  for(const [id,time]of[[patient,'14:00'],[other,'14:30']])await call('execute',[id,crypto.randomUUID(),'reserve',JSON.stringify({doctor_id:doctor,date,time,reason:'Fixture de comprobante'})]);
  const appointment=(await query('SELECT * FROM public.appointments WHERE patient_id=$1',[patient])).rows[0],otherAppointment=(await query('SELECT * FROM public.appointments WHERE patient_id=$1',[other])).rows[0];
  check(await call('payment_receipts_version'),1);
  await denied(async()=>{await query('SET LOCAL ROLE telecus_backend');await query('SELECT * FROM telecus_integration.payment_receipts');},'42501');
  await denied(async()=>{await query('SET LOCAL ROLE authenticated');await query('SELECT telecus_integration.list_payment_receipts($1)',[patient]);},'42501');
  const content=Buffer.from('%PDF-1.7\nComprobante de prueba ficticio\n%%EOF\n'),request=crypto.randomUUID();
  const file={file_name:'recibo.pdf',content_type:'application/pdf',size:content.length,sha256:crypto.createHash('sha256').update(content).digest('hex')};
  const upload=(actor=patient,id=appointment.id,req=request,body=file)=>call('upload_payment_receipt',[actor,id,req,JSON.stringify({...body,storage_key:body.storage_key||crypto.createHash('sha256').update(actor+'\0'+id+'\0'+body.sha256).digest('hex')})]);
  let page=await call('list_payment_receipts',[patient]);check(page.items.length,1);check(page.items[0].can_pay,true);check(page.items[0].can_upload,true);
  await denied(()=>upload(other),'42501');await denied(()=>upload(doctor),'42501');await denied(()=>upload(admin),'42501');
  await denied(()=>upload(patient,appointment.id,crypto.randomUUID(),{...file,content_type:'image/png'}),'22023');
  await denied(()=>upload(patient,appointment.id,crypto.randomUUID(),{...file,storage_key:'0'.repeat(64)}),'22023');
  await denied(()=>upload(patient,appointment.id,crypto.randomUUID(),{...file,size:5242881}),'22023');
  await denied(()=>upload(patient,appointment.id,crypto.randomUUID(),{...file,file_name:'../escape.pdf'}),'22023');
  const receipt=await upload();check(receipt.content_base64,undefined);check(await upload(),receipt);
  await denied(()=>upload(patient,otherAppointment.id),'23505');
  await denied(()=>upload(patient,appointment.id,request,{...file,file_name:'otro.pdf'}),'23505');
  await denied(()=>upload(patient,appointment.id,crypto.randomUUID()),'23505');
  page=await call('list_payment_receipts',[patient]);check(page.items[0].can_pay,false);check(page.items[0].can_upload,false);check(page.items[0].receipt.id,receipt.id);
  check((await query('SELECT status,payment_status FROM public.appointments WHERE id=$1',[appointment.id])).rows[0],{status:'PRE_RESERVED',payment_status:'PENDING'});
  check((await call('list_notifications',[admin,null,50])).items.some(n=>n.event_type==='payment_receipt_received'),true);
  check((await call('list_notifications',[doctor,null,50])).items.some(n=>n.event_type==='payment_receipt_received'),false);
  check((await call('download_payment_receipt',[patient,receipt.id])).sha256,file.sha256);
  check((await call('download_payment_receipt',[admin,receipt.id])).sha256,file.sha256);
  check((await call('download_payment_receipt',[admin,receipt.id])).content_base64,undefined);
  await denied(()=>call('download_payment_receipt',[other,receipt.id]),'42501');await denied(()=>call('download_payment_receipt',[doctor,receipt.id]),'42501');
  await denied(()=>call('list_payment_receipts',[doctor]),'42501');
  await call('execute',[admin,crypto.randomUUID(),'verify_payment',JSON.stringify({appointment_code:otherAppointment.code})]);
  page=await call('list_payment_receipts',[other]);check(page.items[0].processing,true);check(page.items[0].can_pay,false);check(page.items[0].can_upload,false);
  await denied(()=>upload(other,otherAppointment.id,crypto.randomUUID()),'P0002');
  await query("UPDATE public.appointments SET status='CANCELLED' WHERE id=$1",[appointment.id]);check((await call('list_payment_receipts',[patient])).items.length,0);check((await call('download_payment_receipt',[patient,receipt.id])).sha256,file.sha256);
  await query('UPDATE public.profiles SET active=false WHERE id=$1',[patient]);await denied(()=>call('download_payment_receipt',[patient,receipt.id]),'42501');
  await query('ROLLBACK');
  if(process.argv.includes('--editor')){
   const editor=await fs.readFile('scripts/sql/004-payment-receipts-editor.sql','utf8');
   assert.equal(editor.split('\nCOMMIT;\n').length,2,'Expected one final editor commit');
   // Exercise the generated installer, but discard its entire transaction as well.
   await query(editor.replace('\nCOMMIT;\n','\nROLLBACK;\n'));checks++;
  }
  console.log(JSON.stringify({status:'ok',checks,storage:'real_postgresql_metadata',editor:process.argv.includes('--editor')?'verified_and_rolled_back':'not_requested',migration:'rolled_back',fixtures:'rolled_back',googleCalls:0,emailsSent:0}));
 }catch(e){await query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({status:'failed',checks,code:e.code||e.name,message:e.message}));process.exitCode=1;}finally{await client.end();}
}
main().catch(e=>{console.error(JSON.stringify({status:'connection_failed',code:e.code||e.name}));process.exitCode=1;});
