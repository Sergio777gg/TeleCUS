require('reflect-metadata');
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),path=require('node:path');
async function fixture(){
 const [{Database},{Repository,demoIds},{DemoReservationHolds},{DemoAdministrationStore},{AdministrationService},{FileKnowledgeCatalog},{DatabasePaymentReceiptStore},{PaymentService},{DomainService},{SqlSessionRepository},{resolveConversation}]=await Promise.all(['database','repository','adapters/reservation-holds','adapters/administration','application/administration','adapters/managed-knowledge','adapters/payment-receipts','application/payments','domain','adapters/sessions','conversation'].map(p=>import('../apps/backend/dist/'+p+'.js')));
 const db=new Database('',':memory:');await db.initialize();const holds=new DemoReservationHolds(db);let store;
 const repo=new Repository(db,{mode:'demo'},undefined,async cx=>{if(!cx)return store.schedules();const [r]=await cx.query("SELECT * FROM telecus_demo_admin_state WHERE resource='schedule'");return {...JSON.parse(r.data_json),version:String(r.version)};},holds);await repo.seed();
 const receiptStore=new DatabasePaymentReceiptStore(db,holds);await receiptStore.initialize();await holds.initialize();const catalog=new FileKnowledgeCatalog(path.resolve('knowledge/telecus'));store=new DemoAdministrationStore(db,repo,holds);await store.initialize(catalog.documents());
 const admin=new AdministrationService(store,catalog),payments=new PaymentService(receiptStore),domain=new DomainService(repo,new SqlSessionRepository(db),db);const users={};for(const [k,id]of Object.entries(demoIds))users[k]={...(await db.query('SELECT * FROM telecus_demo_profiles WHERE id=$1',[id]))[0],active:true};
 const write=(expected,payload,requestId=randomUUID())=>admin.write(users.admin,{requestId,resource:'schedule',expected,payload});
 const future=new Date();future.setUTCDate(future.getUTCDate()+14+(2-future.getUTCDay()+7)%7);const date=future.toISOString().slice(0,10),today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota'}).format(new Date());
 const input=(text,sessionId='schedule-test')=>({action:'sendMessage',chatInput:text,sessionId,requestId:randomUUID()});
 const policy={days:[2],start:'09:00',end:'11:00',effective_from:today,hold_hours:24};
 const file=()=>({file_name:'prueba.pdf',content_type:'application/pdf',data:Buffer.from('%PDF-1.7\nFICTICIO\n%%EOF\n')});
 const reserve=(user=users.otherPatient,time='09:00')=>db.transaction(cx=>repo.execute(user,'reserve',{doctor_id:users.otherDoctor.id,date,time,reason:'Consulta general'},cx,randomUUID()));
 return {db,holds,repo,store,admin,payments,domain,users,write,date,today,input,policy,file,reserve,resolveConversation,close:()=>db.close()};
}
test('horarios: permisos, validación, idempotencia y conflicto entre dos administradores',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.admin.read(f.users.patient,'schedule'),e=>e.getStatus()===403);
  const book=await f.store.schedules();for(const extra of [{days:[]},{days:[2,2]},{days:[7]},{start:'09:15'},{end:'08:00'},{effective_from:'2026-02-31'},{hold_hours:0},{hold_hours:169}])await assert.rejects(f.write(book.version,{...f.policy,...extra}),e=>e.getStatus()===400);
  const id=randomUUID();await f.write(book.version,f.policy,id);assert.deepEqual(await f.write(book.version,f.policy,id),{status:'saved'});
  await assert.rejects(f.write(book.version,{...f.policy,start:'10:00'}),e=>e.getStatus()===409);
  assert.equal((await f.db.query("SELECT COUNT(*) AS n FROM telecus_audit WHERE operation='admin:schedule'"))[0].n,1);
 }finally{await f.close();}
});
test('chat, elipsis y disponibilidad usan el martes configurado y horas de 12 horas',async()=>{
 const f=await fixture();try{
  await f.write('1',f.policy);let r=await f.domain.process(f.users.otherPatient,f.input('Quiero una cita'),{intent:'reserve',doctor_name:f.users.otherDoctor.full_name});assert.match(r.reply,/Qué martes/);assert.doesNotMatch(r.reply,/lunes|14:00/);
  const context=await f.domain.grounding(f.users.otherPatient,f.input('el próximo'));assert.equal(context.dialogue.requestedWeekday,2);
  const understood=f.resolveConversation('el próximo',context);assert.equal(new Date(understood.date+'T12:00:00Z').getUTCDay(),2);
  r=await f.domain.process(f.users.otherPatient,f.input('martes'),{intent:'reserve',date:f.date});assert.match(r.reply,/9:00 a\. m\./);assert.doesNotMatch(r.reply,/2:00|14:00/);
  assert.deepEqual(await f.repo.availability(f.users.otherPatient,f.users.otherDoctor.id,f.date),['09:00','09:30','10:00','10:30']);
  const monday=new Date(f.date);monday.setUTCDate(monday.getUTCDate()-1);assert.deepEqual(await f.repo.availability(f.users.otherPatient,f.users.otherDoctor.id,monday.toISOString().slice(0,10)),[]);
 }finally{await f.close();}
});
test('un cupo no se vende dos veces: vence sin comprobante, libera y permite reservar a otro paciente',async()=>{
 const f=await fixture();try{
  await f.write('1',f.policy);await f.reserve();const a=(await f.repo.appointments(f.users.otherPatient))[0];
  await assert.rejects(f.reserve(f.users.patient),e=>e.getStatus()===409);
  await f.db.query('UPDATE telecus_demo_holds SET expires_at=$1 WHERE appointment_id=$2',[new Date(Date.now()-1000).toISOString(),a.id]);
  await assert.rejects(f.payments.upload(f.users.otherPatient,a.id,randomUUID(),f.file()),e=>e.getStatus()===409);
  assert.equal(await f.holds.expire(),1);assert.equal(await f.holds.expire(),0);
  // The seeded patient already has a different appointment; close only that synthetic fixture.
  await f.db.query("UPDATE telecus_demo_appointments SET status='CANCELLED' WHERE patient_id=$1",[f.users.patient.id]);
  await f.reserve(f.users.patient);assert.equal((await f.repo.appointments(f.users.patient)).filter(a=>a.status==='PRE_RESERVED').length,1);
 }finally{await f.close();}
});
test('comprobante recibido conserva el cupo; corregirlo da margen y no confirma el pago',async()=>{
 const f=await fixture();try{
  await f.write('1',f.policy);await f.reserve();const a=(await f.repo.appointments(f.users.otherPatient))[0];
  const receipt=await f.payments.upload(f.users.otherPatient,a.id,randomUUID(),f.file());await f.db.query('UPDATE telecus_demo_holds SET expires_at=$1 WHERE appointment_id=$2',[new Date(Date.now()-1000).toISOString(),a.id]);
  assert.equal(await f.holds.expire(),0);assert.equal((await f.repo.appointments(f.users.otherPatient))[0].payment_status,'PENDING');
  await f.payments.withdraw(f.users.otherPatient,receipt.id,randomUUID());const h=await f.holds.info(a.id);assert.ok(new Date(h.expires_at)>new Date());assert.ok(new Date(h.expires_at)<=new Date(Date.now()+901000));
  await f.payments.upload(f.users.otherPatient,a.id,randomUUID(),f.file());assert.equal((await f.payments.list(f.users.otherPatient)).items[0].receipt!==null,true);
 }finally{await f.close();}
});
test('un cambio de horario invalida la propuesta previa y conserva citas y plazos existentes',async()=>{
 const f=await fixture();try{
  await f.write('1',f.policy);await f.reserve();const a=(await f.repo.appointments(f.users.otherPatient))[0],hold=await f.holds.info(a.id);
  await f.db.query("UPDATE telecus_demo_appointments SET status='CANCELLED' WHERE patient_id=$1",[f.users.patient.id]);
  const r=await f.domain.process(f.users.patient,f.input('reservar'),{intent:'reserve',doctor_name:f.users.otherDoctor.full_name,date:f.date,time:'09:30',reason:'Consulta general'});assert.ok(r.proposal);
  await f.write('2',{...f.policy,start:'13:00',end:'15:00',hold_hours:2});
  await assert.rejects(f.domain.process(f.users.patient,{...f.input(''),action:'confirm',proposalId:r.proposal.id},null),e=>e.getStatus()===409);
  assert.equal((await f.repo.appointments(f.users.otherPatient))[0].start_time,a.start_time);assert.deepEqual(await f.holds.info(a.id),hold);
 }finally{await f.close();}
});

test('el horario operativo se responde desde la política y no consulta el RAG',async()=>{
 const f=await fixture();try{await f.write('1',f.policy);let calls=0;const {DomainService}=await import('../apps/backend/dist/domain.js'),{SqlSessionRepository}=await import('../apps/backend/dist/adapters/sessions.js');const domain=new DomainService(f.repo,new SqlSessionRepository(f.db),f.db,{answer:async()=>{calls++;throw Error('Unexpected RAG');}}),input=f.input('¿Cuál es el horario de atención?');assert.equal(await domain.prepareKnowledge(f.users.otherPatient,input,{intent:'knowledge'}),undefined);const reply=await domain.process(f.users.otherPatient,input,{intent:'knowledge'});assert.match(reply.reply,/martes/);assert.match(reply.reply,/9:00 a\. m\./);assert.equal(calls,0);}finally{await f.close();}
});
