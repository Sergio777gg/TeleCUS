const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function fixture(){
 const [{Database},{Repository,demoIds},{DomainService},{SqlSessionRepository},{DemoWorkspaceStore},{WorkspaceService},{SignedStaffReview},{resolveConversation}]=await Promise.all(['database','repository','domain','adapters/sessions','adapters/workspace','application/workspace','adapters/review-signer','conversation'].map(n=>import('../apps/backend/dist/'+n+'.js')));
 const db=new Database('',':memory:');await db.initialize();const policy={available:true,version:'1',payments_enabled:false};const repo=new Repository(db,{mode:'demo'},undefined,undefined,undefined,async()=>({...policy}));await repo.seed();await db.query("UPDATE telecus_demo_appointments SET status='CANCELLED'");
 const {DemoAdministrationStore}=await import('../apps/backend/dist/adapters/administration.js');await new DemoAdministrationStore(db,repo).initialize([]);const {DatabasePaymentReceiptStore}=await import('../apps/backend/dist/adapters/payment-receipts.js');await new DatabasePaymentReceiptStore(db).initialize();
 const users={};for(const [key,id]of Object.entries(demoIds))users[key]={...(await db.query('SELECT * FROM telecus_demo_profiles WHERE id=$1',[id]))[0],active:true};
 const domain=new DomainService(repo,new SqlSessionRepository(db),db),store=new DemoWorkspaceStore(db,repo);await store.initialize();const workspace=new WorkspaceService(repo,store,new SignedStaffReview('synthetic-visit-workflow-secret'.repeat(3)));
 const date=(await db.query('SELECT start_time FROM telecus_demo_appointments'))[0].start_time.slice(0,10);
 const input=(message='',sessionId='visit')=>({sessionId,chatInput:message,action:'sendMessage',requestId:randomUUID()});
 const turn=async(user,message,session='visit')=>{const i=input(message,session),grounding=await domain.grounding(user,i),intent=resolveConversation(message,grounding);assert.ok(intent,'Expected deterministic interpretation: '+message);return domain.process(user,i,intent);};
 const reserve=(user,type='FOLLOW_UP',time='15:00')=>db.transaction(cx=>repo.execute(user,'reserve',{date,time,appointment_type:type,visit_policy_version:policy.version,reason:'Consulta general',doctor_id:users.otherDoctor.id},cx,randomUUID()));
 return {db,repo,domain,workspace,users,date,turn,input,policy,reserve,close:()=>db.close()};
}
test('catálogo aplica los cinco motivos y conserva tipos históricos solo para lectura',async()=>{
 const {VISIT_TYPES,visitTypeAnswer,visitType,visitTypeQuestion}=await import('../apps/backend/dist/application/visit-policy.js');
 assert.equal(VISIT_TYPES.length,5);
 assert.deepEqual(VISIT_TYPES.map(t=>t.code),['NON_URGENT_GUIDANCE','RESULTS_REVIEW','FOLLOW_UP','REFERRALS_ORDERS','MEDICATION_PRESCRIPTION']);
 for(const t of VISIT_TYPES)assert.equal(visitTypeAnswer('Tipo de cita: '+t.code),t.code);
 assert.ok(visitType('GENERAL_CERTIFICATE'));assert.equal(visitTypeAnswer('Tipo de cita: GENERAL_CERTIFICATE'),null);
 for(const criterion of ['otoscopia','disminución de la orina','labios azulados','convulsión','sobredosis','agitación grave'])assert.ok(visitTypeQuestion.includes(criterion));
});
test('rutas presencial y urgente no proponen ni crean citas y descartan una reserva pendiente',async()=>{
 const f=await fixture();try{
  for(const [code,number,pattern]of [['IN_PERSON_PRIORITY','6',/mismo día/],['EMERGENCY','7',/inmediata en urgencias/]]){
   await f.turn(f.users.patient,'Solicitar una cita');
   const result=await f.turn(f.users.patient,number);assert.match(result.reply,pattern);assert.equal(result.proposal,undefined);
   assert.equal((await f.domain.state(f.users.patient,'visit')).draft,undefined);
   const proposed=await f.domain.process(f.users.patient,f.input(),{intent:'reserve',appointment_type:'FOLLOW_UP',date:f.date,time:'14:00',reason:'Control'});
   assert.ok(proposed.proposal);
   const routed=await f.domain.process(f.users.patient,f.input('Tipo de cita: '+code),null);
   assert.equal(routed.proposal,undefined);
   await assert.rejects(f.domain.process(f.users.patient,{...f.input(),action:'confirm',proposalId:proposed.proposal.id},null),e=>e.status===409);
  }
  assert.equal((await f.db.query("SELECT count(*) AS n FROM telecus_demo_appointments WHERE status='PRE_RESERVED'"))[0].n,0);
 }finally{await f.close();}
});
test('paciente elige tipo, fecha y hora; no médico; no se consume una explicación como elección',async()=>{
 const f=await fixture();try{
  const first=await f.turn(f.users.patient,'Solicitar una cita');assert.equal(first.choices.length,7);assert.doesNotMatch(first.reply,/Elige un médico/);
  const type=await f.turn(f.users.patient,'4');assert.match(type.reply,/fecha|lunes/);assert.doesNotMatch(type.reply,/Elige un médico/);
  const s=await f.domain.state(f.users.patient,'visit');assert.equal(s.draft.appointment_type,'REFERRALS_ORDERS');assert.equal(s.draft.doctor_id,undefined);
  const i=f.input('fecha y hora');const proposed=await f.domain.process(f.users.patient,i,{intent:'reserve',date:f.date,time:'15:00',reason:'Consulta general'});assert.ok(proposed.proposal);assert.match(proposed.reply,/remisión u orden/);assert.match(proposed.reply,/No debes pagar/);assert.match(proposed.reply,/asignará un médico disponible/);assert.doesNotMatch(proposed.proposal.summary,/Médico:/);
  await f.domain.process(f.users.patient,{...f.input(),action:'confirm',proposalId:proposed.proposal.id},null);const [a]=await f.db.query("SELECT * FROM telecus_demo_appointments WHERE status='PRE_RESERVED'");assert.equal(a.payment_status,'NOT_REQUIRED');assert.equal(a.appointment_type,'REFERRALS_ORDERS');
 }finally{await f.close();}
});
test('balanceo usa disponibilidad y menor carga; dos solicitudes simultáneas ocupan médicos distintos',async()=>{
 const f=await fixture();try{
  const results=await Promise.allSettled([f.reserve(f.users.patient),f.reserve(f.users.otherPatient)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
  const rows=await f.db.query("SELECT doctor_id FROM telecus_demo_appointments WHERE status='PRE_RESERVED'");assert.equal(new Set(rows.map(a=>a.doctor_id)).size,2);assert.equal((await f.repo.serviceAvailability(f.users.patient,f.date)).includes('15:00'),false);
  const third={...f.users.patient,id:randomUUID()};await f.db.query('INSERT INTO telecus_demo_profiles VALUES($1,$2,$3,$4,1)',[third.id,'PATIENT','Sintético','third@example.test']);await assert.rejects(f.reserve(third),e=>e.status===400||e.status===409);
 }finally{await f.close();}
});
test('modalidad se congela por cita; nueva configuración invalida confirmación pendiente',async()=>{
 const f=await fixture();try{await f.reserve(f.users.patient);f.policy.payments_enabled=true;f.policy.version='2';await f.reserve(f.users.otherPatient,'MEDICATION_PRESCRIPTION','15:30');const free=(await f.repo.appointments(f.users.patient)).find(a=>a.status!=='CANCELLED'),paid=(await f.repo.appointments(f.users.otherPatient)).find(a=>a.status!=='CANCELLED');assert.equal(free.payment_status,'NOT_REQUIRED');assert.equal(paid.payment_status,'PENDING');
  await f.db.query("UPDATE telecus_demo_appointments SET status='CANCELLED'");const reply=await f.domain.process(f.users.patient,f.input(),{intent:'reserve',appointment_type:'FOLLOW_UP',date:f.date,time:'14:00',reason:'Consulta general'});f.policy.version='3';await assert.rejects(f.domain.process(f.users.patient,{...f.input(),action:'confirm',proposalId:reply.proposal.id},null),e=>e.status===409);
 }finally{await f.close();}
});
test('admisión gratuita es directa, requiere Administrador y declaración; médico puede finalizar sin simular pago',async()=>{
 const f=await fixture();try{await f.reserve(f.users.patient);const a=(await f.repo.appointments(f.users.patient)).find(a=>a.status!=='CANCELLED');const review=await f.workspace.prepare(f.users.admin,{kind:'confirm_free',appointment_code:a.code,requestId:randomUUID()});await assert.rejects(f.workspace.action(f.users.admin,{token:review.token,confirmed:true}),e=>e.status===400);await assert.rejects(f.workspace.prepare(f.users.patient,{kind:'confirm_free',appointment_code:a.code,requestId:randomUUID()}),e=>e.status===403);
  const result=await f.workspace.action(f.users.admin,{token:review.token,confirmed:true,admission_checked:true});assert.ok(result.message);await f.workspace.action(f.users.admin,{token:review.token,confirmed:true,admission_checked:true});assert.equal((await f.db.query("SELECT count(*) AS n FROM telecus_audit WHERE operation='confirm_free'"))[0].n,1);
  const assigned=(await f.repo.appointments(f.users.patient)).find(a=>a.status!=='CANCELLED');assert.equal(assigned.status,'CONFIRMED');assert.equal(assigned.payment_status,'NOT_REQUIRED');const doctor=Object.values(f.users).find(u=>u.id===assigned.doctor_id);assert.equal((await f.workspace.appointments(doctor)).items.length,1);
  await f.db.query('UPDATE telecus_demo_appointments SET start_time=$1,end_time=$2 WHERE id=$3',[new Date(Date.now()-3600000).toISOString(),new Date(Date.now()-1000).toISOString(),a.id]);await f.db.transaction(cx=>f.repo.execute(doctor,'complete',{appointment_code:a.code},cx));assert.equal((await f.db.query('SELECT status FROM telecus_demo_appointments WHERE id=$1',[a.id]))[0].status,'COMPLETED');
 }finally{await f.close();}
});
