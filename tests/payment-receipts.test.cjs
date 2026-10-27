const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const modules=Promise.all([import('../apps/backend/dist/database.js'),import('../apps/backend/dist/adapters/payment-receipts.js'),import('../apps/backend/dist/application/payments.js')]);
const pdf=()=>({file_name:'recibo.pdf',content_type:'application/pdf',data:Buffer.from('%PDF-1.7\ncontenido de prueba\n%%EOF\n')});
async function fixture(){
 const [{Database},{DatabasePaymentReceiptStore},{PaymentService}]=await modules;
 const db=new Database('',':memory:');await db.initialize();
 const profiles=Object.fromEntries(['patient','other','doctor','admin'].map((name,i)=>[name,{id:randomUUID(),role:i===2?'DOCTOR':i===3?'ADMIN':'PATIENT',active:true,email:name+'@example.test',full_name:name}]));
 for(const p of Object.values(profiles))await db.query('INSERT INTO telecus_demo_profiles(id,role,full_name,email,active) VALUES($1,$2,$3,$4,1)',[p.id,p.role,p.full_name,p.email]);
 const appointment=randomUUID(),otherAppointment=randomUUID(),future=new Date(Date.now()+86400000).toISOString();
 for(const [id,patient,code]of[[appointment,profiles.patient.id,'RECEIPT-ONE'],[otherAppointment,profiles.other.id,'RECEIPT-TWO']])await db.query('INSERT INTO telecus_demo_appointments(id,code,patient_id,doctor_id,start_time,end_time,status,payment_status,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,code,patient,profiles.doctor.id,future,new Date(Date.now()+88200000).toISOString(),'PRE_RESERVED','PENDING','Fixture']);
 const store=new DatabasePaymentReceiptStore(db);await store.initialize();return {db,profiles,appointment,otherAppointment,store,service:new PaymentService(store)};
}
test('comprobante privado conserva PENDING, deshabilita repetir pago y notifica a paciente y Administrador atómicamente',async()=>{
 const f=await fixture();try{
  const before=await f.service.list(f.profiles.patient);assert.equal(before.items.length,1);assert.equal(before.items[0].can_pay,true);assert.equal(before.items[0].can_upload,true);
  assert.equal((await f.service.list(f.profiles.admin)).items.length,0);
  const receipt=await f.service.upload(f.profiles.patient,f.appointment,randomUUID(),pdf());assert.equal(receipt.size,pdf().data.length);assert.equal(receipt.content_base64,undefined);
  const page=await f.service.list(f.profiles.patient);assert.equal(page.items[0].can_pay,false);assert.equal(page.items[0].can_upload,false);assert.equal(page.items[0].receipt.id,receipt.id);assert.equal(page.items[0].payment_status,'PENDING');assert.equal(page.items[0].status,'PRE_RESERVED');
  assert.equal((await f.service.list(f.profiles.admin)).items.find(i=>i.appointment_id===f.appointment).receipt.id,receipt.id);
  const notices=await f.db.query("SELECT recipient_id,event_type FROM telecus_notifications WHERE event_type='payment_receipt_received'");assert.deepEqual(notices.map(n=>n.recipient_id).sort(),[f.profiles.patient.id,f.profiles.admin.id].sort());
  assert.deepEqual((await f.service.download(f.profiles.admin,receipt.id)).data,pdf().data);
  await f.db.query("UPDATE telecus_demo_appointments SET status='CANCELLED' WHERE id=$1",[f.appointment]);assert.equal((await f.service.list(f.profiles.patient)).items.length,0);assert.deepEqual((await f.service.download(f.profiles.patient,receipt.id)).data,pdf().data);
 }finally{await f.db.close();}
});
test('mismo envío y contenido es idempotente; cambia de contenido/cita o segundo comprobante produce conflicto',async()=>{
 const f=await fixture();try{
  const request=randomUUID(),receipt=await f.service.upload(f.profiles.patient,f.appointment,request,pdf());
  assert.deepEqual(await f.service.upload(f.profiles.patient,f.appointment,request,pdf()),receipt);
  const changed=pdf();changed.data=Buffer.from('%PDF-1.7\nOtro contenido\n%%EOF');
  await assert.rejects(()=>f.service.upload(f.profiles.patient,f.appointment,request,changed),e=>e.getStatus()===409);
  await assert.rejects(()=>f.service.upload(f.profiles.patient,f.otherAppointment,request,pdf()),e=>e.getStatus()===409);
  await assert.rejects(()=>f.service.upload(f.profiles.patient,f.appointment,randomUUID(),pdf()),e=>e.getStatus()===409);
  assert.equal((await f.db.query('SELECT id FROM telecus_demo_payment_receipts')).length,1);assert.equal((await f.db.query("SELECT id FROM telecus_notifications WHERE event_type='payment_receipt_received'")).length,2);
 }finally{await f.db.close();}
});
test('aislamiento entre pacientes, médicos bloqueados y Administrador no puede subir en nombre del paciente',async()=>{
 const f=await fixture();try{
  await assert.rejects(()=>f.service.upload(f.profiles.other,f.appointment,randomUUID(),pdf()),e=>e.getStatus()===403);
  const receipt=await f.service.upload(f.profiles.patient,f.appointment,randomUUID(),pdf());
  assert.equal((await f.service.list(f.profiles.other)).items[0].receipt,null);
  await assert.rejects(()=>f.service.download(f.profiles.other,receipt.id),e=>e.getStatus()===404);
  await assert.rejects(()=>f.service.list(f.profiles.doctor),e=>e.getStatus()===403);
  await assert.rejects(()=>f.service.download(f.profiles.doctor,receipt.id),e=>e.getStatus()===403);
  await assert.rejects(()=>f.service.upload(f.profiles.admin,f.appointment,randomUUID(),pdf()),e=>e.getStatus()===403);
  await f.db.query('UPDATE telecus_demo_profiles SET active=0 WHERE id=$1',[f.profiles.patient.id]);
  await assert.rejects(()=>f.service.download(f.profiles.patient,receipt.id),e=>e.getStatus()===403);
 }finally{await f.db.close();}
});
test('cancelada, confirmada, pagada y pasada rechazan adjuntos sin cambiar pago',async()=>{
 for(const [field,value]of[['status','CANCELLED'],['status','CONFIRMED'],['payment_status','VERIFIED'],['start_time','2000-01-01T00:00:00Z']]){
  const f=await fixture();try{
   await f.db.query('UPDATE telecus_demo_appointments SET '+field+'=$1 WHERE id=$2',[value,f.appointment]);
   await assert.rejects(()=>f.service.upload(f.profiles.patient,f.appointment,randomUUID(),pdf()),e=>e.getStatus()===409);
   assert.equal((await f.db.query('SELECT id FROM telecus_demo_payment_receipts')).length,0);
   assert.equal((await f.db.query('SELECT payment_status FROM telecus_demo_appointments WHERE id=$1',[f.appointment]))[0].payment_status,field==='payment_status'?value:'PENDING');
  }finally{await f.db.close();}
 }
});
test('validación real de firma, MIME, tamaño, tipo de entrada y nombres seguros',async()=>{
 const [,,{validatePaymentFile,MAX_PAYMENT_RECEIPT_BYTES}]=await modules;
 for(const file of [
  {...pdf(),data:Buffer.from('MZ executable')},{...pdf(),content_type:'image/png'},
  {...pdf(),data:Buffer.alloc(MAX_PAYMENT_RECEIPT_BYTES+1)}, {...pdf(),data:Buffer.from('<svg></svg>')},
  {...pdf(),data:[]},{...pdf(),file_name:''},{...pdf(),data:Buffer.alloc(0)}
 ])assert.throws(()=>validatePaymentFile(file),e=>e.getStatus()===400);
 const sanitized=validatePaymentFile({...pdf(),file_name:'../carpeta\\mi\r\nrecibo.html'});assert.equal(/[\\/\r\n]/.test(sanitized.file_name),false);assert.equal(sanitized.file_name.endsWith('.pdf'),true);
 for(const content_type of ['', 'application/octet-stream'])assert.equal(validatePaymentFile({...pdf(),content_type}).content_type,'application/pdf');
 const jpg=validatePaymentFile({file_name:'foto.jpeg',content_type:'image/jpeg',data:Buffer.from('ffd8ff00ffd9','hex')});assert.equal(jpg.file_name,'foto.jpg');
 const png=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.write('IHDR',12);assert.equal(validatePaymentFile({file_name:'imagen.png',content_type:'image/png',data:png}).content_type,'image/png');
});
test('fallo al publicar notificación revierte comprobante, y consultas no permiten subir',async()=>{
 const f=await fixture();try{
  const [,,{PaymentService}]=await modules,readonly=new PaymentService(f.store,false);
  assert.equal((await readonly.list(f.profiles.patient)).items[0].can_upload,false);
  await assert.rejects(()=>readonly.upload(f.profiles.patient,f.appointment,randomUUID(),pdf()),e=>e.getStatus()===403);
  await f.db.query('DROP TABLE telecus_notifications');await assert.rejects(()=>f.service.upload(f.profiles.patient,f.appointment,randomUUID(),pdf()));assert.equal((await f.db.query('SELECT id FROM telecus_demo_payment_receipts')).length,0);
 }finally{await f.db.close();}
});
test('adaptador PostgreSQL distingue migración ausente de fallo de conexión y aplica fallback explícito',async()=>{
 const [, {PostgresPaymentReceiptStore}]=await modules;
 const disabled=new PostgresPaymentReceiptStore({call:async()=>null},async()=>({items:[{appointment_id:'fixture'}],receiptsAvailable:false}));await disabled.initialize();assert.equal(disabled.available(),false);assert.equal((await disabled.list({})).items.length,1);
 const offline=new PostgresPaymentReceiptStore({call:async()=>{throw Error('connection unavailable');}});await assert.rejects(()=>offline.initialize(),/connection unavailable/);
 const unavailable=new PostgresPaymentReceiptStore();await unavailable.initialize();assert.equal(unavailable.available(),false);
});
