require('reflect-metadata');
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),path=require('node:path');
async function fixture(){
 const [{Database},{Repository,demoIds},{DemoAdministrationStore},{AdministrationService},{FileKnowledgeCatalog,ManagedKnowledgeSearch},{DatabasePaymentReceiptStore},{PaymentService}]=await Promise.all(['database','repository','adapters/administration','application/administration','adapters/managed-knowledge','adapters/payment-receipts','application/payments'].map(p=>import('../apps/backend/dist/'+p+'.js')));
 const db=new Database('',':memory:');await db.initialize();const repo=new Repository(db,{mode:'demo'});await repo.seed();
 const receipts=new DatabasePaymentReceiptStore(db);await receipts.initialize();const catalog=new FileKnowledgeCatalog(path.resolve('knowledge/telecus')),store=new DemoAdministrationStore(db,repo);await store.initialize(catalog.documents(),true);
 const users={};for(const [name,id]of Object.entries(demoIds)){const [p]=await db.query('SELECT * FROM telecus_demo_profiles WHERE id=$1',[id]);users[name]={...p,active:true};}
 const service=new AdministrationService(store,catalog),payments=new PaymentService(receipts),input=()=>({file_name:'prueba.pdf',content_type:'application/pdf',data:Buffer.from('%PDF-1.7\nPRUEBA SIN VALOR\n%%EOF\n')});
 const write=(resource,expected,payload,requestId=randomUUID())=>service.write(users.admin,{resource,expected,payload,requestId});
 return {db,repo,users,store,service,payments,catalog,input,write,ManagedKnowledgeSearch,close:()=>db.close()};
}
test('historial conserva comprobante después de verificar, cancelar o finalizar y mantiene los permisos',async()=>{
 const f=await fixture();try{
  const receipt=await f.payments.upload(f.users.patient,'demo-appointment-1',randomUUID(),f.input());
  assert.equal((await f.service.read(f.users.admin,'payments',{view:'history'})).items.length,0);
  const review=await f.service.prepareReview(f.users.admin,'demo-appointment-1',randomUUID());await f.service.confirmReview(f.users.admin,review.id,true);
  assert.equal((await f.service.read(f.users.admin,'payments',{view:'received'})).items.length,0);
  for(const status of ['CONFIRMED','CANCELLED','COMPLETED']){
   await f.db.query('UPDATE telecus_demo_appointments SET status=$1 WHERE id=$2',[status,'demo-appointment-1']);
   const page=await f.service.read(f.users.admin,'payments',{view:'history'});assert.equal(page.items.length,1);assert.equal(page.items[0].receipt.id,receipt.id);assert.equal(page.items[0].payment_status,'VERIFIED');assert.equal(page.items[0].status,status);assert.equal(page.items[0].receipt.content_base64,undefined);
   assert.deepEqual((await f.payments.download(f.users.admin,receipt.id)).data,f.input().data);
  }
  for(const user of [f.users.patient,f.users.doctor,{...f.users.admin,active:false}])await assert.rejects(f.service.read(user,'payments',{view:'history'}),e=>e.status===403);
  await assert.rejects(f.payments.download(f.users.otherPatient,receipt.id),e=>e.status===404);await assert.rejects(f.payments.download(f.users.doctor,receipt.id),e=>e.status===403);
  await assert.rejects(f.service.prepareReview(f.users.admin,'demo-appointment-1',randomUUID()),e=>e.status===409);
 }finally{await f.close();}
});

test('historial paginado con búsqueda literal distingue pagos sin archivo, pendientes y citas gratuitas',async()=>{
 const f=await fixture();try{
  for(let n=0;n<27;n++)await f.db.query("INSERT INTO telecus_demo_appointments(id,code,patient_id,doctor_id,start_time,end_time,status,payment_status,reason) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED','VERIFIED','Prueba')",['history-'+n,'TCUS-HISTORY-'+String(n).padStart(2,'0'),f.users.otherPatient.id,f.users.doctor.id,new Date(Date.now()-n*3600000).toISOString(),new Date(Date.now()+1800000-n*3600000).toISOString()]);
  const first=await f.service.read(f.users.admin,'payments',{view:'history'}),next=await f.service.read(f.users.admin,'payments',{view:'history',offset:first.next_offset});assert.equal(first.items.length,25);assert.equal(first.next_offset,25);assert.equal(next.items.length,2);assert.equal(next.next_offset,null);assert.equal(new Set([...first.items,...next.items].map(a=>a.appointment_id)).size,27);assert.equal(first.items[0].receipt,null);
  assert.equal((await f.service.read(f.users.admin,'payments',{view:'history',q:'tcus-history-26'})).items.length,1);assert.equal((await f.service.read(f.users.admin,'payments',{view:'history',q:'%'})).items.length,0);
  await f.db.query("UPDATE telecus_demo_appointments SET payment_status='NOT_REQUIRED' WHERE id='history-0'");assert.equal((await f.service.read(f.users.admin,'payments',{view:'history',q:'TCUS-HISTORY-00'})).items.length,0);
  await assert.rejects(f.service.read(f.users.admin,'payments',{view:'other'}),e=>e.status===400);await assert.rejects(f.service.read(f.users.admin,'payments',{view:'history',offset:-1}),e=>e.status===400);
 }finally{await f.close();}
});

test('administración: autorización, perfiles con versión y protección de citas e historial',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.service.read(f.users.patient,'people'),e=>e.getStatus()===403);
  const doctors=await f.service.read(f.users.admin,'people',{role:'DOCTOR'}),doctor=doctors.items.find(p=>p.id===f.users.doctor.id);
  await assert.rejects(f.write('profile',doctor.version,{...doctor,active:false}),e=>e.getStatus()===409);
  const available=doctors.items.find(p=>p.id===f.users.otherDoctor.id),requestId=randomUUID(),payload={id:available.id,full_name:'Médico de prueba actualizado',role:'DOCTOR',active:false};
  await f.write('profile',available.version,payload,requestId);assert.deepEqual(await f.write('profile',available.version,payload,requestId),{status:'saved'});
  await assert.rejects(f.write('profile',available.version,{...payload,active:true}),e=>e.getStatus()===409);
  await assert.rejects(f.write('profile','fake',{id:f.users.admin.id,full_name:'No autorizado',role:'PATIENT',active:false}),e=>e.getStatus()===403);
  assert.equal((await f.db.query('SELECT id FROM telecus_demo_appointments')).length,1);
 }finally{await f.close();}
});
test('preinscripciones: alta pendiente, duplicados y retiro auditable sin inventar identidades',async()=>{
 const f=await fixture();try{
  const before=(await f.db.query('SELECT id FROM telecus_demo_profiles')).length;
  const result=await f.write('registration','new',{full_name:'Persona ficticia',email:'nuevo@example.test',role:'DOCTOR'});
  assert.equal((await f.db.query('SELECT id FROM telecus_demo_profiles')).length,before);
  const page=await f.service.read(f.users.admin,'registrations'),entry=page.items.find(p=>p.id===result.id);assert.equal(entry.status,'PENDING');
  await assert.rejects(f.write('registration','new',{full_name:'Duplicado',email:'nuevo@example.test',role:'PATIENT'}),e=>e.getStatus()===409);
  await f.write('registration_cancel',entry.version,{id:entry.id});assert.equal((await f.service.read(f.users.admin,'registrations')).items[0].status,'CANCELLED');
  await assert.rejects(f.write('registration','new',{full_name:'Ya existente',email:f.users.patient.email,role:'DOCTOR'}),e=>e.getStatus()===409);
 }finally{await f.close();}
});
test('configuración: URL y teléfono validados; concurrencia, permisos y modo consulta',async()=>{
 const f=await fixture();try{
  const cfg=await f.service.read(f.users.admin,'settings');
  for(const url of ['javascript:alert(1)','http://pago.example.test','https://user:secret@pago.example.test','https://127.0.0.1/','https://pago.example.test/#x'])await assert.rejects(f.write('settings',cfg.version,{payment_url:url,support_phone:'3148336862'}),e=>e.getStatus()===400);
  await f.write('settings',cfg.version,{payment_url:'https://pago.example.test/pagar',support_phone:'3148336862'});assert.equal((await f.store.settings()).support_phone,'573148336862');
  await assert.rejects(f.write('settings',cfg.version,{payment_url:'https://otro.example.test/',support_phone:'3148336862'}),e=>e.getStatus()===409);
  const {AdministrationService}=await import('../apps/backend/dist/application/administration.js'),readOnly=new AdministrationService(f.store,f.catalog,false);await assert.rejects(readOnly.write(f.users.admin,{requestId:randomUUID(),resource:'settings',expected:'2',payload:{}}),e=>e.getStatus()===403);
 }finally{await f.close();}
});
test('RAG: borrador privado, publicación versionada, audiencia fija y reversión',async()=>{
 const f=await fixture();try{
  const file='09_OPERACION_ADMINISTRATIVA_AGENDAMIENTO.md',initial=await f.service.read(f.users.admin,'knowledge',{file}),oldId=initial.published_id;
  const body='# Documento de prueba\nTokenpruebainstitucional: revisión administrativa de prueba.';
  await f.write('knowledge_save',initial.version,{file,body});let detail=await f.service.read(f.users.admin,'knowledge',{file});
  assert.equal((await f.store.published()).find(d=>d.file===file).body.includes('Tokenprueba'),false);
  await f.write('knowledge_publish',detail.version,{file,revision_id:detail.versions[0].id});
  const search=new f.ManagedKnowledgeSearch(path.resolve('knowledge/telecus'),f.store);
  assert.equal((await search.search('Tokenpruebainstitucional','PATIENT')).length,0);assert.ok((await search.search('Tokenpruebainstitucional','ADMIN')).some(d=>d.file===file));
  detail=await f.service.read(f.users.admin,'knowledge',{file});await f.write('knowledge_publish',detail.version,{file,revision_id:oldId});
  assert.equal((await f.store.published()).find(d=>d.file===file).body,initial.versions[0].body);
  await assert.rejects(f.write('knowledge_save','1',{file:'../../archivo',body}),e=>e.getStatus()===400);
  await assert.rejects(f.write('knowledge_save','1',{file,body:'# Sección\n'+'x'.repeat(4600)}),e=>e.getStatus()===400);
 }finally{await f.close();}
});
test('comprobantes: retirar permite corregir, conserva evidencia y no resucita un envío anterior',async()=>{
 const f=await fixture();try{
  const r=await f.payments.upload(f.users.patient,'demo-appointment-1',randomUUID(),f.input()),requestId=randomUUID();
  await assert.rejects(f.payments.withdraw(f.users.otherPatient,r.id,requestId),e=>e.getStatus()===403);
  await assert.rejects(f.payments.withdraw(f.users.admin,r.id,requestId),e=>e.getStatus()===403);
  await f.payments.withdraw(f.users.patient,r.id,requestId);assert.deepEqual(await f.payments.withdraw(f.users.patient,r.id,requestId),{id:r.id,withdrawn:true});
  assert.equal((await f.payments.list(f.users.patient)).items[0].receipt,null);
  const replacement=await f.payments.upload(f.users.patient,'demo-appointment-1',randomUUID(),f.input());assert.notEqual(replacement.id,r.id);
  assert.deepEqual((await f.payments.download(f.users.patient,r.id)).data,f.input().data);
  assert.equal((await f.db.query('SELECT id FROM telecus_demo_payment_receipts')).length,2);
 }finally{await f.close();}
});
test('pago directo: revisión vence, rechaza evidencia retirada y confirma una sola vez sin modelo',async()=>{
 const f=await fixture();try{
  const receipt=await f.payments.upload(f.users.patient,'demo-appointment-1',randomUUID(),f.input()),review=await f.service.prepareReview(f.users.admin,'demo-appointment-1',randomUUID());
  await f.payments.withdraw(f.users.patient,receipt.id,randomUUID());await assert.rejects(f.service.confirmReview(f.users.admin,review.id,true),e=>e.getStatus()===409);
  const expired=await f.service.prepareReview(f.users.admin,'demo-appointment-1',randomUUID()),[row]=await f.db.query("SELECT data_json FROM telecus_demo_admin_state WHERE resource='payment_reviews' AND object_key=$1",[expired.id]),old=JSON.parse(row.data_json);old.expires_at=new Date(Date.now()-1000).toISOString();await f.db.query("UPDATE telecus_demo_admin_state SET data_json=$1 WHERE resource='payment_reviews' AND object_key=$2",[JSON.stringify(old),expired.id]);
  await assert.rejects(f.service.confirmReview(f.users.admin,expired.id,true),e=>e.getStatus()===409);
  const fresh=await f.service.prepareReview(f.users.admin,'demo-appointment-1',randomUUID());
  await assert.rejects(f.service.confirmReview(f.users.patient,fresh.id,true),e=>e.getStatus()===403);
  await assert.rejects(f.service.confirmReview(f.users.admin,fresh.id,false),e=>e.getStatus()===400);
  const result=await f.service.confirmReview(f.users.admin,fresh.id,true);assert.deepEqual(await f.service.confirmReview(f.users.admin,fresh.id,true),result);
  const [appointment]=await f.db.query('SELECT status,payment_status FROM telecus_demo_appointments WHERE id=$1',['demo-appointment-1']);assert.equal(appointment.payment_status,'VERIFIED');assert.equal(appointment.status,'CONFIRMED');
  await assert.rejects(f.payments.withdraw(f.users.patient,receipt.id,randomUUID()),e=>e.getStatus()===409);
 }finally{await f.close();}
});
test('HTTP administrativo ejecuta pagos y configuración sin invocar chat, modelo ni Google',async()=>{
 const f=await fixture();const [{NestFactory},{ApiModule},{AuthService}]=await Promise.all([import('@nestjs/core'),import('../apps/backend/dist/http/app.module.js'),import('../apps/backend/dist/auth.js')]);let chatCalls=0;
 const auth=new AuthService(f.db,{mode:'demo',demoSecret:'synthetic-administration-secret'.repeat(3)});
 const app=await NestFactory.create(ApiModule.register({identity:auth,administration:f.service,payments:f.payments,chat:{enqueue:async()=>{chatCalls++;throw Error('No se usa IA para estas operaciones.');},get:async()=>{chatCalls++;}},notifications:{list:async()=>({items:[],unread:0}),read:async()=>0},deliveries:{list:async()=>[]},system:{configuration:()=>({mode:'demo'}),health:async()=>({status:'ok'})}}),{logger:false});
 try{
  await app.listen(0,'127.0.0.1');const base=await app.getUrl();
  const req=(route,body,user=f.users.admin)=>fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+auth.issueDemo(user.id),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await req('/api/admin/people',null,f.users.patient)).status,403);
  assert.equal((await req('/api/admin/settings')).status,200);
  const prepared=await req('/api/admin/payments/demo-appointment-1/review',{requestId:randomUUID()}),review=await prepared.json();assert.equal(prepared.status,200,JSON.stringify(review));
  assert.equal((await req('/api/admin/payment-reviews/'+review.id+'/confirm',{verified:false})).status,400);
  const confirmed=await req('/api/admin/payment-reviews/'+review.id+'/confirm',{verified:true});assert.equal(confirmed.status,200);assert.equal((await confirmed.json()).mode,'demo');
  assert.equal(chatCalls,0);
 }finally{await app.close();await f.close();}
});
test('soporte conserva contexto y la política de pago directo rechaza confirmaciones antiguas del chat',async()=>{
 const f=await fixture();const [{DomainService},{SqlSessionRepository},{emptyIntent},{NodeRedInterpreter}]=await Promise.all(['domain','adapters/sessions','conversation','adapters/interpretation'].map(p=>import('../apps/backend/dist/'+p+'.js')));
 try{
  const sessions=new SqlSessionRepository(f.db),domain=new DomainService(f.repo,sessions,f.db,undefined,{directPayments:true}),sessionId=randomUUID();
  const input=message=>({chatInput:message,sessionId,requestId:randomUUID(),action:'sendMessage'});
  const initial=await domain.process(f.users.admin,input('Quiero confirmar el pago'),emptyIntent('verify_payment'));assert.equal(initial.ui_action,'payments');assert.equal(initial.proposal,undefined);
  await f.db.transaction(cx=>sessions.save(f.users.admin,sessionId,{proposal:{id:'old-confirmation',kind:'verify_payment',expires_at:new Date(Date.now()+600000).toISOString(),payload:{appointment_code:'TCUS-DEMO-001'},summary:'Operación anterior'}},cx));
  const legacy=await domain.process(f.users.admin,{...input(''),action:'confirm',proposalId:'old-confirmation'},null);assert.equal(legacy.ui_action,'payments');
  assert.equal((await f.db.query("SELECT payment_status FROM telecus_demo_appointments WHERE id='demo-appointment-1'"))[0].payment_status,'PENDING');
  const patientSession=randomUUID(),userInput={...input('ayuda'),sessionId:patientSession};
  await f.db.transaction(cx=>sessions.save(f.users.patient,patientSession,{draft:{intent:'reserve',doctor_name:'Dra. Ana López'},awaiting:'date'},cx));
  const support=await domain.process(f.users.patient,userInput,emptyIntent('support'));assert.equal(support.handoff.reason,'requested');assert.equal((await domain.state(f.users.patient,patientSession)).draft.doctor_name,'Dra. Ana López');
  const doctorSupport=await domain.process(f.users.doctor,{...userInput,sessionId:randomUUID()},emptyIntent('support'));assert.equal(doctorSupport.handoff.reason,'requested');
  const adminSupport=await domain.process(f.users.admin,input('ayuda'),emptyIntent('support'));assert.equal(adminSupport.handoff,undefined);assert.match(adminSupport.reply,/Administración/);
  const interpreter=new NodeRedInterpreter('http://inference/interpret','synthetic',1000,async()=>new Response(JSON.stringify({field_understanding:{act:'support',value:null,target:'task'}})));
  assert.equal((await interpreter.interpret('Esto no me ayuda, prefiero que alguien me atienda',{draft:{intent:'reserve'},awaiting:'reason'})).intent,'support');
 }finally{await f.close();}
});


test('bandejas de pagos separan esperando comprobante, recibido y retirado sin cambiar el estado financiero',async()=>{
 const f=await fixture();try{
  assert.equal((await f.service.read(f.users.admin,'payments')).items.length,0);
  assert.equal((await f.service.read(f.users.admin,'payments',{view:'awaiting'})).items.length,1);
  assert.equal((await f.service.read(f.users.admin,'payments',{view:'processing'})).items.length,0);
  const receipt=await f.payments.upload(f.users.patient,'demo-appointment-1',randomUUID(),f.input());
  const inbox=await f.service.read(f.users.admin,'payments');assert.equal(inbox.items.length,1);assert.equal(inbox.items[0].receipt.id,receipt.id);
  assert.equal((await f.service.read(f.users.admin,'payments',{view:'awaiting'})).items.length,0);
  await f.payments.withdraw(f.users.patient,receipt.id,randomUUID());
  assert.equal((await f.service.read(f.users.admin,'payments')).items.length,0);
  assert.equal((await f.service.read(f.users.admin,'payments',{view:'awaiting'})).items.length,1);
  assert.equal((await f.db.query("SELECT payment_status FROM telecus_demo_appointments WHERE id='demo-appointment-1'"))[0].payment_status,'PENDING');
  await assert.rejects(f.service.read(f.users.admin,'payments',{view:'anything'}),e=>e.getStatus()===400);
 }finally{await f.close();}
});
