require('reflect-metadata');
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),path=require('node:path');
async function fixture(){
 const [{Database},{Repository,demoIds},{DemoReservationHolds},{DatabasePaymentReceiptStore},{DemoAdministrationStore},{FileKnowledgeCatalog},{WorkspaceService},{DemoWorkspaceStore,DatabaseUsageMetrics},{SignedStaffReview}]=await Promise.all(['database','repository','adapters/reservation-holds','adapters/payment-receipts','adapters/administration','adapters/managed-knowledge','application/workspace','adapters/workspace','adapters/review-signer'].map(p=>import('../apps/backend/dist/'+p+'.js')));
 const db=new Database('',':memory:');await db.initialize();const repo=new Repository(db,{mode:'demo'});await repo.seed();const receiptStore=new DatabasePaymentReceiptStore(db);await receiptStore.initialize();const administration=new DemoAdministrationStore(db,repo);await administration.initialize(new FileKnowledgeCatalog(path.resolve('knowledge/telecus')).documents());
 const store=new DemoWorkspaceStore(db,repo);await store.initialize();const signer=new SignedStaffReview('synthetic-staff-tests-private-key-only-'.repeat(2)),metrics=new DatabaseUsageMetrics(db);await metrics.initialize();const service=new WorkspaceService(repo,store,signer,metrics,administration),users={};for(const [k,id]of Object.entries(demoIds))users[k]={...(await db.query('SELECT * FROM telecus_demo_profiles WHERE id=$1',[id]))[0],active:true};
 const code='TCUS-DEMO-001';await db.query("UPDATE telecus_demo_appointments SET status='CONFIRMED',payment_status='VERIFIED',start_time=$1,end_time=$2,meet_url='https://meet.google.com/aaa-bbbb-ccc' WHERE code=$3",[new Date(Date.now()-3600000).toISOString(),new Date(Date.now()-1800000).toISOString(),code]);
 const prepare=(actor,kind,fields={})=>service.prepare(actor,{kind,appointment_code:code,requestId:randomUUID(),...fields});const confirm=(actor,review)=>service.action(actor,{token:review.token,confirmed:true,attended:true});
 return {db,repo,store,signer,metrics,service,users,code,prepare,confirm,close:()=>db.close()};
}

test('rechazar exige motivo público válido, revisión firmada y conserva exactamente la explicación aprobada',async()=>{
 const f=await fixture();try{
  const id=randomUUID(),reason='El horario solicitado no está disponible. Puedes elegir otra fecha.';
  await f.db.query("INSERT INTO telecus_demo_changes(id,appointment_id,patient_id,request_type,status,reason) VALUES($1,'demo-appointment-1',$2,'RESCHEDULE','PENDING','NOTA_PRIVADA')",[id,f.users.patient.id]);
  for(const fields of [{},{rejection_category:'other',public_reason:'No'},{rejection_category:'inventada',public_reason:reason}])await assert.rejects(f.prepare(f.users.admin,'reject_change',{request_id:id,...fields}),e=>e.getStatus()===400);
  await assert.rejects(f.db.transaction(cx=>f.repo.execute(f.users.admin,'reject_change',{request_id:id},cx,randomUUID())),e=>e.getStatus()===400);
  assert.equal((await f.repo.changes(f.users.patient))[0].status,'PENDING');
  const review=await f.prepare(f.users.admin,'reject_change',{request_id:id,rejection_category:'availability',public_reason:reason});
  assert.match(review.details.patient_notice.body,/Motivo: El horario solicitado/);assert.doesNotMatch(JSON.stringify(review.details),/NOTA_PRIVADA/);
  const old=f.signer.open(review.token);delete old.payload.public_reason;await assert.rejects(f.confirm(f.users.admin,{token:f.signer.seal(old)}),e=>e.getStatus()===400);
  await f.service.action(f.users.admin,{token:review.token,confirmed:true,public_reason:'TEXTO ALTERADO'});await f.confirm(f.users.admin,review);
  const details=await f.repo.changeDetails(f.users.patient);assert.equal(details[0].public_reason,reason);assert.equal((await f.repo.changeDetails(f.users.otherPatient)).length,0);
  const {NotificationsService}=await import('../apps/backend/dist/notifications.js'),{DatabaseNotificationInbox}=await import('../apps/backend/dist/adapters/notification-inbox.js');
  const notice=(await new NotificationsService(new DatabaseNotificationInbox(f.db)).list(f.users.patient)).items.find(n=>n.title==='Solicitud de reprogramación no aprobada');
  assert.ok(notice);assert.equal(notice.body,review.details.patient_notice.body);assert.doesNotMatch(notice.body,/NOTA_PRIVADA|TEXTO ALTERADO/);
  assert.equal((await f.db.query('SELECT COUNT(*) AS n FROM telecus_public_rejections'))[0].n,1);
  assert.equal((await f.service.requests(f.users.admin,{view:'history'})).items[0].public_reason,reason);
 }finally{await f.close();}
});

test('dashboards: pacientes bloqueados, agenda médica propia y enlaces solo autorizados',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.service.appointments(f.users.patient),e=>e.getStatus()===403);await assert.rejects(f.prepare(f.users.patient,'complete'),e=>e.getStatus()===403);
  const own=await f.service.appointments(f.users.doctor);assert.equal(own.items.length,1);assert.match(own.items[0].meet_url,/meet.google/);assert.equal((await f.service.appointments(f.users.otherDoctor)).items.length,0);
  assert.equal((await f.service.appointments(f.users.admin)).items[0].meet_url,undefined);await assert.rejects(f.service.requests(f.users.doctor),e=>e.getStatus()===403);await assert.rejects(f.prepare(f.users.otherDoctor,'complete'),e=>e.getStatus()===403);
  await assert.rejects(f.prepare(f.users.doctor,'cancel'),e=>e.getStatus()===403);
 }finally{await f.close();}
});
test('finalizar exige revisión firmada, cuenta original, horario terminado y declaración expresa; reintento es idempotente',async()=>{
 const f=await fixture();try{
  await f.db.query('UPDATE telecus_demo_appointments SET end_time=$1 WHERE code=$2',[new Date(Date.now()+60000).toISOString(),f.code]);await assert.rejects(f.prepare(f.users.doctor,'complete'),e=>e.getStatus()===409);
  await f.db.query('UPDATE telecus_demo_appointments SET end_time=$1 WHERE code=$2',[new Date(Date.now()-1000).toISOString(),f.code]);const review=await f.prepare(f.users.doctor,'complete');
  await assert.rejects(f.service.action(f.users.doctor,{token:review.token,confirmed:true}),e=>e.getStatus()===400);
  const tampered=review.token.slice(0,-8)+'tampered';await assert.rejects(f.confirm(f.users.doctor,{token:tampered}),e=>e.getStatus()===400);
  await assert.rejects(f.confirm(f.users.otherDoctor,review),e=>e.getStatus()===403);
  const old=f.signer.open(review.token);old.expires_at=new Date(Date.now()-1).toISOString();await assert.rejects(f.confirm(f.users.doctor,{token:f.signer.seal(old)}),e=>e.getStatus()===409);
  const [a,b]=await Promise.all([f.confirm(f.users.doctor,review),f.confirm(f.users.doctor,review)]);assert.equal(a.message,b.message);assert.equal((await f.db.query("SELECT COUNT(*) AS n FROM telecus_audit WHERE operation='complete'"))[0].n,1);assert.equal((await f.service.appointments(f.users.doctor)).items.length,0);assert.equal((await f.service.appointments(f.users.doctor,{view:'history'})).items[0].status,'COMPLETED');
 }finally{await f.close();}
});
test('una cita modificada después de revisarse no admite la confirmación antigua',async()=>{
 const f=await fixture();try{const review=await f.prepare(f.users.admin,'cancel');await f.db.query('UPDATE telecus_demo_appointments SET doctor_id=$1 WHERE code=$2',[f.users.otherDoctor.id,f.code]);await assert.rejects(f.confirm(f.users.admin,review),e=>e.getStatus()===409);assert.equal((await f.db.query('SELECT status FROM telecus_demo_appointments WHERE code=$1',[f.code]))[0].status,'CONFIRMED');
  f.repo.cfg.mode='supabase-readonly';await assert.rejects(f.prepare(f.users.admin,'cancel'),e=>e.getStatus()===403);
 }finally{await f.close();}
});
test('solicitudes pendientes y revisadas conservan bandejas distintas y filtros paginados',async()=>{
 const f=await fixture();try{
  const change=randomUUID();await f.db.query("INSERT INTO telecus_demo_changes(id,appointment_id,patient_id,request_type,status,reason) VALUES($1,'demo-appointment-1',$2,'CANCEL','PENDING','Prueba')",[change,f.users.patient.id]);
  assert.equal((await f.service.requests(f.users.admin)).items.length,1);const review=await f.prepare(f.users.admin,'reject_change',{request_id:change,rejection_category:'other',public_reason:'La solicitud necesita una revisión adicional. Consulta al equipo de TeleCUS.'});await f.confirm(f.users.admin,review);assert.equal((await f.service.requests(f.users.admin)).items.length,0);assert.equal((await f.service.requests(f.users.admin,{view:'history'})).items[0].status,'REJECTED');
  for(let i=0;i<27;i++)await f.db.query("INSERT INTO telecus_demo_appointments(id,code,patient_id,doctor_id,start_time,end_time,status,payment_status,reason) VALUES($1,$2,$3,$4,$5,$6,'CANCELLED','PENDING','Prueba')",['page-'+i,'PAGE-'+i,f.users.patient.id,f.users.doctor.id,new Date(Date.now()-7200000-i*1000).toISOString(),new Date(Date.now()-5400000-i*1000).toISOString()]);
  const first=await f.service.appointments(f.users.admin,{view:'history',q:'PAGE-'}),second=await f.service.appointments(f.users.admin,{view:'history',q:'PAGE-',offset:25});assert.equal(first.items.length,25);assert.equal(first.next_offset,25);assert.equal(second.items.length,2);assert.equal(second.next_offset,null);
 }finally{await f.close();}
});
test('HTTP usa endpoints directos, rechaza chat del personal y no crea trabajos de inferencia',async()=>{
 const f=await fixture();const [{NestFactory},{ApiModule},{AuthService}]=await Promise.all([import('@nestjs/core'),import('../apps/backend/dist/http/app.module.js'),import('../apps/backend/dist/auth.js')]);let calls=0;const identity=new AuthService(f.db,{mode:'demo',demoSecret:'synthetic-http-staff-only'.repeat(3)}),app=await NestFactory.create(ApiModule.register({identity,workspace:f.service,chat:{enqueue:async()=>{calls++;throw Error('Unexpected chat');},get:async()=>({})},notifications:{list:async()=>({items:[],unread:0}),read:async()=>0},deliveries:{list:async()=>[]},system:{configuration:()=>({mode:'demo'}),health:async()=>({status:'ok'})}}),{logger:false});
 try{await app.listen(0,'127.0.0.1');const base=await app.getUrl(),token=(await identity.demoLogin('DOCTOR')).token,headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/workspace/appointments',{headers})).status,200);assert.equal((await fetch(base+'/api/chat/jobs',{method:'POST',headers,body:'{}'})).status,403);
  const review=await (await fetch(base+'/api/workspace/reviews',{method:'POST',headers,body:JSON.stringify({kind:'complete',appointment_code:f.code,requestId:randomUUID()})})).json();assert.ok(review.token);
  assert.equal((await fetch(base+'/api/workspace/actions',{method:'POST',headers,body:JSON.stringify({token:review.token,confirmed:true,attended:true})})).status,200);
  assert.equal(calls,0);assert.equal((await f.db.query('SELECT COUNT(*) AS n FROM telecus_jobs'))[0].n,0);const usage=await f.service.usage(f.users.admin);assert.ok(usage.direct.some(x=>x.route==='confirm'&&x.requests===1));await assert.rejects(f.service.usage(f.users.doctor),e=>e.getStatus()===403);
  const docs=await f.service.information(f.users.doctor);assert.ok(docs.items.length>0);
 }finally{await app.close();await f.close();}
});
