const {test}=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const modules=Promise.all(['database','repository','domain','auth','jobs'].map(name=>import('../apps/backend/dist/'+name+'.js')));
async function fixture(){
 const [{Database},{Repository,demoIds},{DomainService,sessionKey},{AuthService},{JobsService,validateInput}]=await modules;
 const cfg={mode:'demo',databaseUrl:'',databaseFile:':memory:',demoSecret:'test-secret'.repeat(8),internalToken:'internal-secret'.repeat(4),worker:false,modelTimeoutMs:1000};
 const {SqlSessionRepository}=await import('../apps/backend/dist/adapters/sessions.js');
 const interpreter={interpret:async()=>{throw Error('Transporte de modelo no esperado en esta prueba');}};
 const db=new Database('',':memory:');await db.initialize();const repo=new Repository(db,cfg);await repo.seed();const domain=new DomainService(repo,new SqlSessionRepository(db),db),auth=new AuthService(db,cfg),jobs=new JobsService(db,cfg,domain,auth,interpreter);
 const users={};for(const [name,id]of Object.entries(demoIds))users[name]=(await db.query('SELECT * FROM telecus_demo_profiles WHERE id=$1',[id]))[0];
 const date=(await db.query('SELECT start_time FROM telecus_demo_appointments'))[0].start_time.slice(0,10);
 const input=(action='sendMessage',sessionId='conversation',extra={})=>({action,sessionId,requestId:randomUUID(),chatInput:'mensaje de prueba',...extra});
 const intent=(name,fields={})=>({intent:name,appointment_code:null,doctor_name:null,date:null,time:null,reason:null,request_id:null,...fields});
 const confirm=(user,proposal,sessionId='conversation')=>domain.process(user,input('confirm',sessionId,{proposalId:proposal.id}),null);
 return {db,repo,domain,auth,jobs,interpreter,validateInput,users,date,input,intent,confirm,sessionKey};
}
test('autenticación firmada, caducidad, rol del servidor y cuenta inactiva',async()=>{const f=await fixture();try{const token=f.auth.issueDemo(f.users.patient.id);assert.equal((await f.auth.authenticate('Bearer '+token)).role,'PATIENT');await assert.rejects(f.auth.authenticate('Bearer '+token+'a'));await f.db.query('UPDATE telecus_demo_profiles SET role=$1 WHERE id=$2',['ADMIN',f.users.patient.id]);assert.equal((await f.auth.authenticate('Bearer '+token)).role,'ADMIN');await f.db.query('UPDATE telecus_demo_profiles SET active=0 WHERE id=$1',[f.users.patient.id]);await assert.rejects(f.auth.authenticate('Bearer '+token));}finally{await f.db.close();}});
test('un paciente no puede verificar pagos ni consultar citas ajenas con un código',async()=>{const f=await fixture();try{await assert.rejects(f.domain.process(f.users.patient,f.input(),f.intent('verify_payment')),e=>e.status===403);const reply=await f.domain.process(f.users.otherPatient,f.input(),f.intent('list_appointments',{appointment_code:'TCUS-DEMO-001'}));assert.match(reply.reply,/No se encontraron/);await assert.rejects(f.db.transaction(cx=>f.repo.execute(f.users.otherPatient,'cancel',{appointment_code:'TCUS-DEMO-001'},cx)),e=>e.status===403);}finally{await f.db.close();}});
test('las sesiones se aíslan por usuario y rol aunque el cliente reutilice sessionId',async()=>{const f=await fixture();try{const r=await f.domain.process(f.users.patient,f.input(),f.intent('cancel'));assert.ok(r.proposal);assert.equal((await f.domain.state(f.users.otherPatient,'conversation')).proposal,undefined);assert.notEqual(f.sessionKey(f.users.patient,'conversation'),f.sessionKey({...f.users.patient,role:'ADMIN'},'conversation'));await assert.rejects(f.confirm(f.users.otherPatient,r.proposal),e=>e.status===409);}finally{await f.db.close();}});
test('la IA no confirma cambios; se exige el botón y el identificador de la propuesta',async()=>{const f=await fixture();try{const r=await f.domain.process(f.users.patient,f.input(),f.intent('cancel'));await f.domain.process(f.users.patient,f.input(),f.intent('confirm'));assert.equal((await f.repo.appointments(f.users.patient))[0].status,'PRE_RESERVED');await assert.rejects(f.domain.process(f.users.patient,f.input('confirm'),null));await f.confirm(f.users.patient,r.proposal);assert.equal((await f.repo.appointments(f.users.patient))[0].status,'CANCELLED');await assert.rejects(f.confirm(f.users.patient,r.proposal));}finally{await f.db.close();}});
test('otra conversación y una propuesta vencida no autorizan una cancelación',async()=>{const f=await fixture();try{const r=await f.domain.process(f.users.patient,f.input(),f.intent('cancel'));await assert.rejects(f.confirm(f.users.patient,r.proposal,'other'));const state=await f.domain.state(f.users.patient,'conversation');state.proposal.expires_at='2000-01-01T00:00:00Z';await f.db.query('UPDATE telecus_sessions SET state_json=$1 WHERE id=$2',[JSON.stringify(state),f.sessionKey(f.users.patient,'conversation')]);await assert.rejects(f.confirm(f.users.patient,r.proposal));assert.equal((await f.repo.appointments(f.users.patient))[0].status,'PRE_RESERVED');}finally{await f.db.close();}});
test('reprogramar exige lunes, horario del piloto y fecha futura',async()=>{const f=await fixture();try{const invalid=await f.domain.process(f.users.patient,f.input(),f.intent('reschedule',{date:f.date,time:'16:00'}));assert.match(invalid.reply,/fuera de la jornada/);assert.equal(invalid.proposal,undefined);for(const fields of [{date:'2026-10-13',time:'14:00'},{date:'2020-01-06',time:'14:00'}])await assert.rejects(f.domain.process(f.users.patient,f.input(),f.intent('reschedule',fields)));const r=await f.domain.process(f.users.patient,f.input(),f.intent('reschedule',{date:f.date,time:'15:00'}));assert.ok(r.proposal);await f.confirm(f.users.patient,r.proposal);assert.equal((await f.repo.appointments(f.users.patient))[0].start_time,f.date+'T20:00:00.000Z');}finally{await f.db.close();}});
test('una cita pagada conserva el horario hasta la aprobación administrativa',async()=>{const f=await fixture();try{await f.db.transaction(cx=>f.repo.execute(f.users.admin,'verify_payment',{appointment_code:'TCUS-DEMO-001'},cx));const r=await f.domain.process(f.users.patient,f.input(),f.intent('reschedule',{date:f.date,time:'15:30'}));await f.confirm(f.users.patient,r.proposal);let appointment=(await f.repo.appointments(f.users.patient))[0];assert.equal(appointment.start_time,f.date+'T19:00:00.000Z');const change=(await f.repo.changes(f.users.admin))[0];assert.equal(change.status,'PENDING');const approval=await f.domain.process(f.users.admin,f.input(),f.intent('approve_change',{request_id:change.id}));await f.confirm(f.users.admin,approval.proposal);appointment=(await f.repo.appointments(f.users.patient))[0];assert.equal(appointment.start_time,f.date+'T20:30:00.000Z');assert.equal((await f.db.query('SELECT status FROM telecus_demo_changes'))[0].status,'APPROVED');}finally{await f.db.close();}});
test('dos reservas concurrentes no ocupan el mismo espacio',async()=>{const f=await fixture();try{await f.db.query('UPDATE telecus_demo_appointments SET status=$1',['CANCELLED']);const fields={doctor_name:'Carlos Pérez',date:f.date,time:'15:00',reason:'Consulta general'};const a=await f.domain.process(f.users.patient,f.input(),f.intent('reserve',fields));const b=await f.domain.process(f.users.otherPatient,f.input(),f.intent('reserve',fields));const results=await Promise.allSettled([f.confirm(f.users.patient,a.proposal),f.confirm(f.users.otherPatient,b.proposal)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await f.db.query("SELECT COUNT(*) AS count FROM telecus_demo_appointments WHERE status='PRE_RESERVED'")).at(0).count,1);assert.equal((await f.db.query("SELECT COUNT(*) AS count FROM telecus_audit WHERE operation='reserve'")).at(0).count,1);}finally{await f.db.close();}});
test('una cita vigente impide iniciar otra reserva; una cita pasada no la bloquea',async()=>{const f=await fixture();try{const blocked=await f.domain.process(f.users.patient,f.input(),f.intent('reserve'));assert.match(blocked.reply,/Ya tienes una cita vigente/);assert.equal(blocked.proposal,undefined);await f.db.query('UPDATE telecus_demo_appointments SET end_time=$1',['2020-01-06T19:30:00Z']);const allowed=await f.domain.process(f.users.patient,f.input(),f.intent('reserve'));assert.match(allowed.reply,/Elige un médico/);}finally{await f.db.close();}});
test('médicos solo ven citas pagadas asignadas y no completan una cita futura',async()=>{const f=await fixture();try{assert.equal((await f.repo.appointments(f.users.doctor)).length,0);await f.db.transaction(cx=>f.repo.execute(f.users.admin,'verify_payment',{appointment_code:'TCUS-DEMO-001'},cx));assert.equal((await f.repo.appointments(f.users.doctor)).length,1);assert.equal((await f.repo.appointments(f.users.otherDoctor)).length,0);await assert.rejects(f.db.transaction(cx=>f.repo.execute(f.users.doctor,'complete',{appointment_code:'TCUS-DEMO-001'},cx)));await assert.rejects(f.domain.process(f.users.doctor,f.input(),f.intent('cancel')));await f.db.query('UPDATE telecus_demo_appointments SET end_time=$1',['2020-01-06T19:30:00Z']);await f.db.transaction(cx=>f.repo.execute(f.users.doctor,'complete',{appointment_code:'TCUS-DEMO-001'},cx));assert.equal((await f.db.query('SELECT status FROM telecus_demo_appointments'))[0].status,'COMPLETED');}finally{await f.db.close();}});
test('cola persistente: reintentos reutilizan trabajo, evitan cruces de usuario y conservan orden',async()=>{const f=await fixture();try{const auth='Bearer '+f.auth.issueDemo(f.users.patient.id);const first=f.input('roleOverview'),second=f.input('roleOverview');const a=await f.jobs.enqueue(f.users.patient,first,auth),b=await f.jobs.enqueue(f.users.patient,second,auth);assert.equal((await f.jobs.enqueue(f.users.patient,first,auth)).id,a.id);await assert.rejects(f.jobs.enqueue(f.users.patient,{...first,chatInput:'otro'},auth),e=>e.status===409);await assert.rejects(f.jobs.get(f.users.otherPatient,a.id),e=>e.status===404);await f.jobs.workOnce();assert.equal((await f.jobs.get(f.users.patient,a.id)).status,'done');assert.equal((await f.jobs.get(f.users.patient,b.id)).status,'queued');await f.jobs.workOnce();assert.equal((await f.jobs.get(f.users.patient,b.id)).status,'done');assert.deepEqual((await f.db.query('SELECT input_json FROM telecus_jobs')).map(j=>j.input_json),['{}','{}']);}finally{await f.db.close();}});
test('confirmación y resultado del trabajo se guardan en una única transacción',async()=>{const f=await fixture();try{const proposal=(await f.domain.process(f.users.patient,f.input(),f.intent('cancel'))).proposal;const auth='Bearer '+f.auth.issueDemo(f.users.patient.id);const input=f.input('confirm','conversation',{proposalId:proposal.id});const job=await f.jobs.enqueue(f.users.patient,input,auth);await f.jobs.workOnce();assert.equal((await f.jobs.get(f.users.patient,job.id)).status,'done');assert.equal((await f.repo.appointments(f.users.patient))[0].status,'CANCELLED');assert.equal((await f.jobs.enqueue(f.users.patient,input,auth)).id,job.id);assert.equal((await f.db.query('SELECT COUNT(*) AS count FROM telecus_audit')).at(0).count,1);}finally{await f.db.close();}});
test('el adaptador real impide escritura hasta verificar Supabase y Google',async()=>{const f=await fixture();try{f.repo.cfg.mode='supabase-readonly';await assert.rejects(f.db.transaction(cx=>f.repo.execute(f.users.admin,'cancel',{appointment_code:'TCUS-DEMO-001'},cx)),e=>e.status===403);}finally{await f.db.close();}});
test('validación de entrada limita mensajes y acciones',async()=>{const f=await fixture();try{assert.throws(()=>f.validateInput({...f.input(),chatInput:'x'.repeat(4001)}));assert.throws(()=>f.validateInput({...f.input(),action:'deleteAll'}));assert.throws(()=>f.validateInput({...f.input(),sessionId:'../../other'}));assert.equal(f.validateInput(f.input()).action,'sendMessage');}finally{await f.db.close();}});
test('menú 1 y solicitud explícita inician la reserva sin depender del modelo ni escribir citas',async()=>{const f=await fixture();const originalFetch=global.fetch;global.fetch=()=>{throw Error('Esta entrada no necesita inferencia');};try{
 const user=f.users.otherPatient,auth='Bearer '+f.auth.issueDemo(user.id);
 const menu=f.input('roleOverview');await f.domain.process(user,menu,null);
 const first=f.input('sendMessage','conversation',{chatInput:'1'}),job=await f.jobs.enqueue(user,first,auth);await f.jobs.workOnce();
 const result=await f.jobs.get(user,job.id);assert.equal(result.status,'done');assert.match(result.result.reply,/Elige un médico/);assert.equal(result.result.proposal,undefined);
 assert.equal((await f.domain.state(user,'conversation')).draft.intent,'reserve');
 for(const text of ['Quiero solicitar una cita','Solicitar una cita','Quisiera agendar una cita.']){
  const input=f.input('sendMessage',randomUUID(),{chatInput:text});const intent=await f.jobs.interpret(user,input);assert.equal(intent.intent,'reserve');const reply=await f.domain.process(user,input,intent);assert.match(reply.reply,/Elige un médico/);
 }
 assert.equal((await f.repo.appointments(user)).length,0);
}finally{global.fetch=originalFetch;await f.db.close();}});
test('el número siguiente elige médico dentro del borrador y no vuelve al menú',async()=>{const f=await fixture();const originalFetch=global.fetch;global.fetch=()=>{throw Error('La selección no necesita inferencia');};try{
 const user=f.users.otherPatient;await f.domain.process(user,f.input(),f.intent('reserve',{date:f.date,time:'15:00'}));
 const before=await f.domain.state(user,'conversation');const chosen=before.selection.choices[1];
 const input=f.input('sendMessage','conversation',{chatInput:'2'}),intent=await f.jobs.interpret(user,input);assert.equal(intent.intent,'reserve');assert.equal(intent.doctor_name,chosen.doctor_name);
 const reply=await f.domain.process(user,input,intent);assert.match(reply.reply,/motivo general/);const after=await f.domain.state(user,'conversation');assert.equal(after.draft.date,f.date);assert.equal(after.draft.time,'15:00');assert.equal(after.draft.doctor_name,chosen.doctor_name);assert.equal(after.selection,undefined);
 const bad=f.input('sendMessage','new-conversation',{chatInput:'Quiero cancelar mi cita'});const other=await f.jobs.interpret(user,bad);assert.equal(other.intent,'cancel');
}finally{global.fetch=originalFetch;await f.db.close();}});
test('los números respetan el menú de cada rol; cambiar exige elegir y luego confirmar',async()=>{const f=await fixture();const originalFetch=global.fetch;global.fetch=()=>{throw Error('La selección no necesita inferencia');};try{
 for(const [role,user]of [['PATIENT',f.users.patient],['ADMIN',f.users.admin],['DOCTOR',f.users.doctor]]){
  await f.domain.process(user,f.input('roleOverview'),null);
  assert.equal((await f.jobs.interpret(user,f.input('sendMessage','conversation',{chatInput:'1'}))).intent,role==='PATIENT'?'reserve':'list_appointments');
 }
 const user=f.users.patient,input=f.input('sendMessage','conversation',{chatInput:'4'});let intent=await f.jobs.interpret(user,input);assert.equal(intent.intent,'change_options');let reply=await f.domain.process(user,input,intent);assert.match(reply.reply,/Reprogramar una cita/);assert.match(reply.reply,/Cancelar una cita/);
 const selection=f.input('sendMessage','conversation',{chatInput:'2'});intent=await f.jobs.interpret(user,selection);reply=await f.domain.process(user,selection,intent);assert.equal(reply.proposal.kind,'cancel');assert.equal((await f.repo.appointments(user))[0].status,'PRE_RESERVED');
 await assert.rejects(f.domain.process(f.users.doctor,f.input(),f.intent('change_options')),e=>e.status===403);
}finally{global.fetch=originalFetch;await f.db.close();}});
test('las opciones inválidas conservan el contexto; números sin menú y frases negadas no ejecutan atajos',async()=>{const f=await fixture();const {resolveConversation}=await import('../apps/backend/dist/conversation.js');try{
 const user=f.users.otherPatient;await f.domain.process(user,f.input('roleOverview'),null);const input=f.input('sendMessage','conversation',{chatInput:'99'});const intent=await f.jobs.interpret(user,input);assert.equal(intent.intent,'unknown');const reply=await f.domain.process(user,input,intent);assert.match(reply.reply,/Elige una de estas opciones/);assert.ok((await f.domain.state(user,'conversation')).selection);
 for(const text of ['1','No quiero solicitar una cita','Quiero solicitar una cita con Carlos Pérez','confirmar'])assert.equal(resolveConversation(text,{}),null);
 assert.equal((await f.repo.appointments(user)).length,0);
}finally{await f.db.close();}});
test('información elegida por número consulta el RAG con una pregunta útil',async()=>{const f=await fixture();const {DomainService}=await import('../apps/backend/dist/domain.js');let question;const domain=new DomainService(f.repo,new (await import('../apps/backend/dist/adapters/sessions.js')).SqlSessionRepository(f.db),f.db,{answer:async(q,role)=>{question=q;assert.equal(role,'PATIENT');return 'Información respaldada';}});try{
 const user=f.users.patient;await domain.process(user,f.input('roleOverview'),null);const input=f.input('sendMessage','conversation',{chatInput:'5'}),intent=await f.jobs.interpret(user,input);assert.equal(intent.intent,'knowledge');const reply=await domain.process(user,input,intent);assert.match(question,/horario/);assert.equal(reply.reply,'Información respaldada');
}finally{await f.db.close();}});
test('horas sueltas mantienen la operación, no inventan fecha y explican la jornada antes de pedir el lunes',async()=>{const f=await fixture();const originalFetch=global.fetch;global.fetch=()=>{throw Error('Una hora explícita no necesita inferencia');};try{
 const user=f.users.patient;await f.domain.process(user,f.input(),f.intent('availability',{doctor_name:'Carlos Pérez'}));
 const invalidInput=f.input('sendMessage','conversation',{chatInput:'4:30 pm'});let intent=await f.jobs.interpret(user,invalidInput);assert.equal(intent.intent,'availability');assert.equal(intent.time,'16:30');assert.equal(intent.date,null);
 let reply=await f.domain.process(user,invalidInput,intent);assert.match(reply.reply,/fuera de la jornada/);let state=await f.domain.state(user,'conversation');assert.equal(state.draft.time,undefined);assert.equal(state.draft.date,undefined);assert.equal(state.draft.doctor_name,'Dr. Carlos Pérez');
 for(const text of ['2:30','Para las 2:30pm']){
  const input=f.input('sendMessage','conversation',{chatInput:text});intent=await f.jobs.interpret(user,input);assert.equal(intent.time,'14:30');assert.equal(intent.date,null);reply=await f.domain.process(user,input,intent);assert.match(reply.reply,/Tengo la hora: 2:30 p\. m\./);assert.match(reply.reply,/Me falta la fecha/);state=await f.domain.state(user,'conversation');assert.equal(state.draft.time,'14:30');assert.equal(state.draft.date,undefined);
 }
 reply=await f.domain.process(user,f.input(),f.intent('availability',{date:f.date}));assert.match(reply.reply,/2:30 p\. m\. está disponible/);assert.equal(reply.proposal,undefined);assert.equal((await f.repo.appointments(user))[0].status,'PRE_RESERVED');
}finally{global.fetch=originalFetch;await f.db.close();}});
test('una hora inválida reemplaza la anterior sin perder médico, fecha ni motivo; la reserva exige confirmación',async()=>{const f=await fixture();try{
 const user=f.users.otherPatient;await f.domain.process(user,f.input(),f.intent('reserve',{doctor_name:'Carlos Pérez',date:f.date,time:'15:00'}));
 const invalid=await f.domain.process(user,f.input(),f.intent('reserve',{time:'16:30'}));assert.match(invalid.reply,/fuera de la jornada/);let state=await f.domain.state(user,'conversation');assert.equal(state.draft.time,undefined);assert.equal(state.draft.date,f.date);assert.equal(state.draft.doctor_name,'Dr. Carlos Pérez');
 const valid=await f.domain.process(user,f.input(),f.intent('reserve',{time:'14:30',reason:'Consulta general'}));assert.equal(valid.proposal.kind,'reserve');state=await f.domain.state(user,'conversation');assert.equal(state.proposal.payload.time,'14:30');assert.equal(state.proposal.payload.date,f.date);assert.equal((await f.repo.appointments(user)).length,0);
}finally{await f.db.close();}});
test('cita real pasada sin finalizar explica el bloqueo y no se cierra automáticamente',async()=>{const f=await fixture();const {appointmentSummary}=await import('../apps/backend/dist/repository.js');try{
 const past={...(await f.repo.appointments(f.users.patient))[0],status:'CONFIRMED',payment_status:'VERIFIED',start_time:'2020-01-06T19:00:00Z',end_time:'2020-01-06T19:30:00Z'};
 f.repo.cfg.mode='supabase-live';f.repo.appointments=async()=>[past];
 const reply=await f.domain.process(f.users.patient,f.input(),f.intent('reserve'));assert.match(reply.reply,/ya pasó/);assert.match(reply.reply,/médico debe finalizarla/);assert.equal(reply.proposal,undefined);assert.equal(past.status,'CONFIRMED');assert.equal((await f.db.query('SELECT COUNT(*) AS count FROM telecus_audit'))[0].count,0);assert.match(appointmentSummary(past),/Horario pasado/);
}finally{await f.db.close();}});
test('el parser de horas respeta meridiano y solo se aplica a borradores de horario',async()=>{const {resolveConversation}=await import('../apps/backend/dist/conversation.js');for(const [text,time]of [['2:30','14:30'],['2:30 p. m.','14:30'],['Para las 2:30pm','14:30'],['4:30 pm','16:30'],['2:30 am','02:30'],['14:30','14:30'],['2:75pm','14:75']]){
 const intent=resolveConversation(text,{draft:{intent:'reschedule'}});assert.equal(intent.time,time);assert.equal(intent.date,null);assert.equal(resolveConversation(text,{}),null);
}for(const text of ['2','No quiero a las 2:30'])assert.equal(resolveConversation(text,{draft:{intent:'availability'}}),null);});
test('próximo lunes se calcula desde la fecha de Colombia y una fecha sola mantiene el borrador',async()=>{const {resolveConversation}=await import('../apps/backend/dist/conversation.js');for(const [today,date]of [['2026-10-06','2026-10-12'],['2026-10-05','2026-10-12'],['2026-10-11','2026-10-12'],['2026-12-31','2027-01-04']]){
 const intent=resolveConversation('El próximo lunes',{draft:{intent:'availability'},today});assert.equal(intent.date,date);assert.equal(intent.time,null);
}const explicit=resolveConversation('para el 2026-10-12',{draft:{intent:'reserve'}});assert.equal(explicit.date,'2026-10-12');assert.equal(explicit.intent,'reserve');assert.equal(resolveConversation('El próximo lunes',{draft:{intent:'availability'},today:'2026-02-30'}),null);});
test('disponibilidad rechaza un martes sin perder la hora ni consultar un día equivocado',async()=>{const f=await fixture();try{
 const reply=await f.domain.process(f.users.patient,f.input(),f.intent('availability',{doctor_name:'Carlos Pérez',date:'2026-10-13',time:'14:30'}));assert.match(reply.reply,/no es un lunes válido/);const state=await f.domain.state(f.users.patient,'conversation');assert.equal(state.draft.date,undefined);assert.equal(state.draft.time,'14:30');assert.equal(state.draft.doctor_name,'Dr. Carlos Pérez');assert.equal(reply.proposal,undefined);
}finally{await f.db.close();}});

async function paidChange(f,time='15:00'){
 await f.db.transaction(cx=>f.repo.execute(f.users.admin,'verify_payment',{appointment_code:'TCUS-DEMO-001'},cx));
 const proposal=(await f.domain.process(f.users.patient,f.input(),f.intent('reschedule',{date:f.date,time}))).proposal;
 assert.match(proposal.summary,/Solicitar reprogramación/);
 await f.confirm(f.users.patient,proposal);return (await f.repo.changes(f.users.admin))[0];
}
async function secondChange(f){
 await f.db.query('INSERT INTO telecus_demo_appointments(id,code,patient_id,doctor_id,start_time,end_time,status,payment_status,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',['second-appointment','TCUS-DEMO-002',f.users.otherPatient.id,f.users.otherDoctor.id,f.date+'T19:00:00Z',f.date+'T19:30:00Z','CONFIRMED','VERIFIED','Prueba']);
 const proposal=(await f.domain.process(f.users.otherPatient,f.input(),f.intent('cancel'))).proposal;
 await f.confirm(f.users.otherPatient,proposal);return (await f.repo.changes(f.users.otherPatient))[0];
}

test('una confirmación rechazada invalida solo esa propuesta y el pago sigue pendiente',async()=>{const f=await fixture();const {ConflictException}=await import('@nestjs/common');try{
 const admin=f.users.patient,input=f.input(),proposal=(await f.domain.process(admin,input,f.intent('cancel'))).proposal;
 f.repo.execute=async()=>{throw new ConflictException('Hay una entrega pendiente.');};
 const job=await f.jobs.enqueue(admin,f.input('confirm','conversation',{proposalId:proposal.id}),'Bearer '+f.auth.issueDemo(admin.id));await f.jobs.workOnce();
 const result=await f.jobs.get(admin,job.id);assert.equal(result.status,'failed');assert.match(result.error,/entrega pendiente/);
 assert.equal((await f.domain.state(admin,'conversation')).proposal,undefined);
 assert.equal((await f.repo.appointments(f.users.patient))[0].payment_status,'PENDING');
 const fresh=await f.domain.process(admin,f.input(),f.intent('list_appointments'));assert.equal(fresh.proposal,undefined);
}finally{await f.db.close();}});

test('una respuesta incierta conserva el ID para recuperación y un rechazo antiguo no borra una propuesta nueva',async()=>{const f=await fixture();const {ServiceUnavailableException}=await import('@nestjs/common');try{
 const admin=f.users.patient,proposal=(await f.domain.process(admin,f.input(),f.intent('cancel'))).proposal;
 f.repo.execute=async()=>{throw new ServiceUnavailableException('Resultado desconocido.');};
 const job=await f.jobs.enqueue(admin,f.input('confirm','conversation',{proposalId:proposal.id}),'Bearer '+f.auth.issueDemo(admin.id));await f.jobs.workOnce();
 assert.equal((await f.jobs.get(admin,job.id)).status,'failed');assert.equal((await f.domain.state(admin,'conversation')).proposal.id,proposal.id);
 const next=(await f.domain.process(admin,f.input(),f.intent('cancel'))).proposal;
 await f.db.transaction(cx=>f.domain.invalidateRejectedConfirmation(admin,f.input('confirm','conversation',{proposalId:proposal.id}),cx));
 assert.equal((await f.domain.state(admin,'conversation')).proposal.id,next.id);
}finally{await f.db.close();}});

test('un pago ya registrado en Calendar se explica sin ofrecer otra verificación ni mantener una propuesta vieja',async()=>{const f=await fixture();try{
 const admin=f.users.admin;await f.domain.process(admin,f.input(),f.intent('verify_payment'));
 f.repo.pendingDeliveries=async()=>[{code:'TCUS-DEMO-001',operation:'confirm',stage:'calendar',status:'queued'}];
 const list=await f.domain.process(admin,f.input(),f.intent('pending_payments'));assert.match(list.reply,/verificación del pago ya está registrada/);assert.doesNotMatch(list.reply,/operación que revisaste sigue pendiente/);assert.equal(list.proposal,undefined);
 const repeat=await f.domain.process(admin,f.input(),f.intent('verify_payment'));assert.match(repeat.reply,/No necesitas confirmar otra vez/);assert.equal(repeat.proposal,undefined);
 f.repo.pendingDeliveries=async()=>[{code:'TCUS-DEMO-001',operation:'confirm',stage:'calendar',status:'review'}];
 const reviewed=await f.domain.process(admin,f.input(),f.intent('verify_payment'));assert.match(reviewed.reply,/requiere revisión administrativa/);assert.equal(reviewed.proposal,undefined);
 assert.equal((await f.repo.appointments(f.users.patient))[0].payment_status,'PENDING');
}finally{await f.db.close();}});

test('consultas de solicitudes administrativas corrigen citas o RAG y excluyen el historial por defecto',async()=>{const f=await fixture();try{
 const reviewed=await paidChange(f),pending=await secondChange(f);
 await f.db.query('UPDATE telecus_demo_changes SET status=$1 WHERE id=$2',['REJECTED',reviewed.id]);
 for(const text of ['Hay solicitudes de cambios?','¿Hay nuevas solicitudes?','Mostrar solicitudes pendientes de cancelación']){
  const input=f.input('sendMessage',randomUUID(),{chatInput:text});
  const parsed=await f.jobs.interpret(f.users.admin,input);assert.equal(parsed.intent,'pending_requests');
  const result=await f.domain.process(f.users.admin,input,f.intent('list_appointments'));
  assert.match(result.reply,/Pendientes de revisión administrativa/);assert.match(result.reply,/TCUS-DEMO-002/);
  assert.doesNotMatch(result.reply,/TCUS-DEMO-001|Rechazada|Tu cita|tus solicitudes/);
  const state=await f.domain.state(f.users.admin,input.sessionId);assert.deepEqual(state.context.references.ids,[pending.id]);
  assert.equal(result.proposal,undefined);
 }
 const historyInput=f.input('sendMessage','history',{chatInput:'Ver historial de solicitudes'});
 const history=await f.domain.process(f.users.admin,historyInput,f.intent('knowledge'));
 assert.match(history.reply,/Historial · solicitudes ya revisadas/);assert.match(history.reply,/Rechazada · Ya revisada/);assert.doesNotMatch(history.reply,/TCUS-DEMO-002/);
 const approval=await f.domain.process(f.users.admin,f.input('sendMessage','history'),f.intent('approve_change',{reference_index:1}));
 assert.equal(approval.proposal,undefined);assert.match(approval.reply,/no admite otra aprobación/);
 assert.equal((await f.repo.changes(f.users.admin))[0].id,pending.id);
}finally{await f.db.close();}});

test('paciente y administrativo separan pendientes de revisadas con numeración coherente y filtran el tipo',async()=>{const f=await fixture();try{
 const first=await paidChange(f);
 await f.db.query('UPDATE telecus_demo_changes SET status=$1 WHERE id=$2',['REJECTED',first.id]);
 const next=(await f.domain.process(f.users.patient,f.input(),f.intent('cancel'))).proposal;
 await f.confirm(f.users.patient,next);const pending=(await f.repo.changes(f.users.admin))[0];
 for(const [user,text] of [[f.users.patient,'Ver mis solicitudes'],[f.users.admin,'Ver todas las solicitudes']]){
  const input=f.input('sendMessage',randomUUID(),{chatInput:text});
  const reply=await f.domain.process(user,input,f.intent('knowledge'));
  assert.match(reply.reply,/Pendientes de revisión administrativa/);assert.match(reply.reply,/Historial · solicitudes ya revisadas/);
  assert.ok(reply.reply.indexOf('1. Cancelación')<reply.reply.indexOf('2. Reprogramación'));
  const state=await f.domain.state(user,input.sessionId);assert.deepEqual(state.context.references.ids,[pending.id,first.id]);
  const selected=await f.domain.process(user,f.input('sendMessage',input.sessionId),f.intent('select_request',{reference_index:2}));
  assert.match(selected.reply,user.role==='PATIENT'?/no fue aprobada/:/Rechazada · Ya revisada/);assert.equal((await f.domain.state(user,input.sessionId)).context.focusedRequestId,first.id);assert.equal(selected.proposal,undefined);
 }
 const cancellations=await f.domain.process(f.users.patient,f.input('sendMessage','cancellations',{chatInput:'Hay solicitudes de cancelación?'}),f.intent('list_appointments'));
 assert.match(cancellations.reply,/Cancelación/);assert.doesNotMatch(cancellations.reply,/Reprogramación|Rechazada/);
 const rejected=await f.domain.process(f.users.patient,f.input('sendMessage','rejected',{chatInput:'Consultar mis solicitudes rechazadas'}),f.intent('knowledge'));
 assert.match(rejected.reply,/Rechazada · Ya revisada/);assert.doesNotMatch(rejected.reply,/Cancelación/);
 const other=await f.domain.process(f.users.otherPatient,f.input('sendMessage','foreign',{chatInput:'Ver todas mis solicitudes'}),f.intent('knowledge'));
 assert.doesNotMatch(other.reply,/TCUS-DEMO-001/);
}finally{await f.db.close();}});

test('lista vacía o lista de citas no escoge una solicitud ajena al ámbito; código explícito sí identifica la pendiente',async()=>{const f=await fixture();try{
 await paidChange(f);await secondChange(f);
 await f.domain.process(f.users.admin,f.input(),f.intent('list_appointments'));
 const wrong=await f.domain.process(f.users.admin,f.input(),f.intent('approve_change',{reference_index:1}));
 assert.equal(wrong.proposal,undefined);assert.match(wrong.reply,/contiene citas, no solicitudes/);
 const explicit=await f.domain.process(f.users.admin,f.input('sendMessage','explicit'),f.intent('approve_change',{appointment_code:'TCUS-DEMO-002'}));
 assert.ok(explicit.proposal);assert.match(explicit.proposal.summary,/TCUS-DEMO-002/);assert.doesNotMatch(explicit.proposal.summary,/Tu cita/);
 const noPending=await f.domain.process(f.users.admin,f.input('sendMessage','empty',{chatInput:'Ver solicitudes aprobadas'}),f.intent('request_status'));
 assert.match(noPending.reply,/No hay solicitudes revisadas/);
 const implicit=await f.domain.process(f.users.admin,f.input('sendMessage','empty'),f.intent('approve_change'));assert.equal(implicit.proposal,undefined);
 assert.equal((await f.repo.changes(f.users.admin)).length,2);
}finally{await f.db.close();}});

test('un código que contradice el número de la lista pide aclaración y no propone otra solicitud',async()=>{const f=await fixture();try{
 await paidChange(f);const second=await secondChange(f);
 await f.domain.process(f.users.admin,f.input(),f.intent('pending_requests'));
 const state=await f.domain.state(f.users.admin,'conversation'),position=state.context.references.ids.indexOf(second.id)+1;
 const result=await f.domain.process(f.users.admin,f.input(),f.intent('approve_change',{reference_index:position,appointment_code:'TCUS-DEMO-001'}));
 assert.equal(result.proposal,undefined);assert.match(result.reply,/gestiones distintas/);assert.equal((await f.repo.changes(f.users.admin)).length,2);
}finally{await f.db.close();}});

test('expresiones de calendario usan una gramática general y un ancla del servidor, no cálculos del modelo',async()=>{
 const {calendarAnswer}=await import('../apps/backend/dist/calendar.js');
 for(const text of ['El lunes siguiente','siguiente lunes','lunes que viene','el próximo lunes','lunes de la próxima semana'])assert.equal(calendarAnswer(text,'2026-10-06'),'2026-10-12');
 for(const [text,date]of [['próximo martes','2026-10-13'],['viernes siguiente','2026-10-09'],['domingo de la siguiente semana','2026-10-18']])assert.equal(calendarAnswer(text,'2026-10-06'),date);
 for(const text of ['lunes','el lunes siguiente a mi cita','cualquier día','mañana por la tarde'])assert.equal(calendarAnswer(text,'2026-10-06'),null);
 const {resolveInterpretation,emptyIntent}=await import('../apps/backend/dist/conversation.js');
 const parsed=resolveInterpretation('lunes siguiente',{...emptyIntent('reschedule'),date:'2099-01-01',date_expression:'lunes siguiente'},{today:'2026-10-06'});assert.equal(parsed.date,'2026-10-12');
});

test('el estado personal se consulta en registros autenticados aunque el modelo lo etiquete como RAG',async()=>{const f=await fixture();const {DomainService}=await import('../apps/backend/dist/domain.js');let ragCalls=0;const domain=new DomainService(f.repo,new (await import('../apps/backend/dist/adapters/sessions.js')).SqlSessionRepository(f.db),f.db,{answer:async()=>{ragCalls++;return 'Documento';}});try{
 const change=await paidChange(f);
 for(const text of ['Quiero ver el estado de mi solicitud','Consultar mis solicitudes','¿Cuál es la situación de mi reprogramación?','Revisar mi cambio']){
  const input=f.input('sendMessage','conversation',{chatInput:text});const reply=await domain.process(f.users.patient,input,f.intent('knowledge'));assert.match(reply.reply,/Pendiente de revisión administrativa/i);assert.match(reply.reply,/TCUS-DEMO-001/);assert.match(reply.reply,/Horario solicitado/);assert.doesNotMatch(reply.reply,/ID:|iniciar sesión|RESCHEDULE|PENDING/);
 }
 await f.db.query('UPDATE telecus_demo_changes SET status=$1 WHERE id=$2',['APPROVED',change.id]);
 const fresh=await domain.process(f.users.patient,f.input(),f.intent('request_status'));assert.match(fresh.reply,/Aprobada/i);assert.equal(ragCalls,0);
 await domain.process(f.users.patient,f.input(),f.intent('knowledge'));assert.equal(ragCalls,1);
}finally{await f.db.close();}});

test('consultar una solicitud no permite ver solicitudes ajenas ni habilita permisos administrativos',async()=>{const f=await fixture();try{
 const change=await paidChange(f);const reply=await f.domain.process(f.users.otherPatient,f.input(),f.intent('request_status',{request_id:change.id}));assert.doesNotMatch(reply.reply,/TCUS-DEMO-001|Horario solicitado/);assert.match(reply.reply,/No se encontró/);
 await assert.rejects(f.domain.process(f.users.patient,f.input(),f.intent('approve_change',{request_id:change.id})),e=>e.status===403);
 await assert.rejects(f.domain.process(f.users.doctor,f.input(),f.intent('request_status')),e=>e.status===403);
 assert.equal((await f.repo.changes(f.users.admin))[0].status,'PENDING');
}finally{await f.db.close();}});

test('la única solicitud mostrada se vincula al aprobar sin exigir copiar un UUID; consultar no aprueba',async()=>{const f=await fixture();try{
 const change=await paidChange(f);const list=await f.domain.process(f.users.admin,f.input(),f.intent('pending_requests'));assert.match(list.reply,/Reprogramación/);assert.match(list.reply,/Horario registrado/);assert.match(list.reply,/Horario solicitado/);
 const approval=await f.domain.process(f.users.admin,f.input(),f.intent('approve_change'));assert.equal(approval.proposal.kind,'approve_change');assert.match(approval.proposal.summary,/TCUS-DEMO-001/);assert.match(approval.proposal.summary,/Horario solicitado/);assert.equal((await f.domain.state(f.users.admin,'conversation')).proposal.payload.request_id,change.id);
 assert.equal((await f.repo.changes(f.users.admin))[0].status,'PENDING');await f.confirm(f.users.admin,approval.proposal);assert.equal((await f.repo.changes(f.users.admin)).length,0);
}finally{await f.db.close();}});

test('varias solicitudes exigen elegir; el número se resuelve dentro de la lista autenticada',async()=>{const f=await fixture();try{
 const first=await paidChange(f),second=await secondChange(f);
 const ambiguous=await f.domain.process(f.users.admin,f.input(),f.intent('approve_change'));assert.equal(ambiguous.proposal,undefined);assert.match(ambiguous.reply,/Hay varias solicitudes/);
 const choice=(await f.domain.state(f.users.admin,'conversation')).selection.choices.findIndex(c=>c.request_id===second.id)+1;
 const input=f.input('sendMessage','conversation',{chatInput:String(choice)}),intent=await f.jobs.interpret(f.users.admin,input);const selected=await f.domain.process(f.users.admin,input,intent);
 assert.equal((await f.domain.state(f.users.admin,'conversation')).proposal.payload.request_id,second.id);await f.confirm(f.users.admin,selected.proposal);assert.equal((await f.repo.changes(f.users.admin))[0].id,first.id);
}finally{await f.db.close();}});

test('seleccionar una solicitud mostrada conserva el objetivo sin aprobarla y evita escoger otra',async()=>{const f=await fixture();try{
 await paidChange(f);const second=await secondChange(f);await f.domain.process(f.users.admin,f.input(),f.intent('pending_requests'));
 const state=await f.domain.state(f.users.admin,'conversation'),position=state.selection.choices.findIndex(c=>c.request_id===second.id)+1;
 const selected=await f.domain.process(f.users.admin,f.input(),f.intent('select_request',{reference_index:position}));assert.match(selected.reply,/TCUS-DEMO-002/);assert.equal(selected.proposal,undefined);
 const approval=await f.domain.process(f.users.admin,f.input(),f.intent('approve_change'));assert.equal((await f.domain.state(f.users.admin,'conversation')).proposal.payload.request_id,second.id);assert.ok(approval.proposal);assert.equal((await f.repo.changes(f.users.admin)).length,2);
}finally{await f.db.close();}});

test('referencias por posición vencen, se aíslan por usuario y no eligen un objetivo por defecto',async()=>{const f=await fixture();try{
 await paidChange(f);await secondChange(f);await f.domain.process(f.users.admin,f.input(),f.intent('pending_requests'));
 const state=await f.domain.state(f.users.admin,'conversation');state.context.references.at='2000-01-01T00:00:00Z';await f.db.query('UPDATE telecus_sessions SET state_json=$1 WHERE id=$2',[JSON.stringify(state),f.sessionKey(f.users.admin,'conversation')]);
 const expired=await f.domain.process(f.users.admin,f.input(),f.intent('approve_change',{reference_index:1}));assert.equal(expired.proposal,undefined);assert.match(expired.reply,/venció/);
 const foreign=await f.domain.process({...f.users.admin,id:'another-admin'},f.input(),f.intent('approve_change',{reference_index:1}));assert.equal(foreign.proposal,undefined);assert.match(foreign.reply,/venció|válida/);
 assert.equal((await f.repo.changes(f.users.admin)).length,2);
}finally{await f.db.close();}});

test('una solicitud revisada se vuelve a consultar antes de proponer y antes de confirmar',async()=>{const f=await fixture();try{
 const change=await paidChange(f);await f.domain.process(f.users.admin,f.input(),f.intent('pending_requests'));
 await f.db.query('UPDATE telecus_demo_changes SET status=$1 WHERE id=$2',['REJECTED',change.id]);const stale=await f.domain.process(f.users.admin,f.input(),f.intent('approve_change'));assert.equal(stale.proposal,undefined);assert.match(stale.reply,/Rechazada/);
 await f.db.query('UPDATE telecus_demo_changes SET status=$1 WHERE id=$2',['PENDING',change.id]);const approval=await f.domain.process(f.users.admin,f.input(),f.intent('approve_change',{request_id:change.id}));await f.db.query('UPDATE telecus_demo_changes SET status=$1 WHERE id=$2',['REJECTED',change.id]);await assert.rejects(f.confirm(f.users.admin,approval.proposal),e=>e.status===409);
 assert.equal((await f.repo.appointments(f.users.patient))[0].start_time,f.date+'T19:00:00.000Z');
}finally{await f.db.close();}});

test('una corrección de menú resuelve la opción anterior; un número simple sigue eligiendo del paso actual',async()=>{const f=await fixture();const originalFetch=global.fetch;try{
 for(const text of ['perdón 3','Me equivoqué, era la opción 3','Vuelvo a la tercera opción del menú']){
  await f.domain.process(f.users.patient,f.input('roleOverview'),null);await f.domain.process(f.users.patient,f.input(),f.intent('availability'));
  const raw=await f.jobs.interpret(f.users.patient,f.input('sendMessage','conversation',{chatInput:'1'}));assert.equal(raw.intent,'availability');assert.ok(raw.doctor_name);
  f.interpreter.interpret=async(message,context)=>{assert.equal(context.selection.type,'doctor');assert.equal(context.context.menu.choices[2].intent,'list_appointments');return f.intent('menu',{navigation:'main_menu',option_number:3});};
  const input=f.input('sendMessage','conversation',{chatInput:text}),intent=await f.jobs.interpret(f.users.patient,input);assert.equal(intent.intent,'list_appointments');const reply=await f.domain.process(f.users.patient,input,intent);assert.match(reply.reply,/TCUS-DEMO-001/);assert.equal(reply.proposal,undefined);assert.equal((await f.domain.state(f.users.patient,'conversation')).draft,undefined);
 }
}finally{global.fetch=originalFetch;await f.db.close();}});

test('las correcciones breves usan el ámbito único disponible y piden aclaración cuando hay dos elecciones válidas',async()=>{const f=await fixture();const originalFetch=global.fetch;global.fetch=()=>{throw Error('Una corrección inequívoca no depende del modelo');};try{
 const {resolveConversation}=await import('../apps/backend/dist/conversation.js');
 await f.domain.process(f.users.patient,f.input('roleOverview'),null);await f.domain.process(f.users.patient,f.input(),f.intent('availability'));
 const grounding=await f.domain.grounding(f.users.patient,f.input());
 for(const text of ['perdón 3','disculpa, la tercera','Rectifico: opción 3','Corrijo, era la tercera','Me equivoqué, era la opción 3'])assert.equal(resolveConversation(text,grounding).intent,'list_appointments');
 assert.equal(resolveConversation('disculpa, 1',grounding).intent,'unknown');
 const ambiguous=await f.domain.process(f.users.patient,f.input(),resolveConversation('disculpa, 1',grounding));assert.match(ambiguous.reply,/menú principal o/);assert.equal((await f.domain.state(f.users.patient,'conversation')).draft.intent,'availability');
 assert.equal(resolveConversation('disculpa, 1 de esta lista',grounding).intent,'availability');assert.equal(resolveConversation('perdón, 1 del menú',grounding).intent,'reserve');
 for(const text of ['3','perdón, 3 horas','no quiero la opción 3','disculpa 3, aprueba todas'])assert.notEqual(resolveConversation(text,grounding)?.intent,'list_appointments');
}finally{global.fetch=originalFetch;await f.db.close();}});

test('consultas informativas conservan borrador y propuesta; una nueva gestión invalida la confirmación anterior',async()=>{const f=await fixture();try{
 await f.domain.process(f.users.patient,f.input(),f.intent('reschedule',{date:f.date}));await f.domain.process(f.users.patient,f.input(),f.intent('request_status'));assert.equal((await f.domain.state(f.users.patient,'conversation')).draft.date,f.date);
 const proposal=(await f.domain.process(f.users.patient,f.input(),f.intent('reschedule',{time:'15:00'}))).proposal;
 const read=await f.domain.process(f.users.patient,f.input(),f.intent('list_appointments'));assert.equal((await f.domain.state(f.users.patient,'conversation')).proposal.id,proposal.id);assert.equal(read.proposal.id,proposal.id);assert.match(read.reply,/pendiente de confirmación/);
 await f.domain.process(f.users.patient,f.input(),f.intent('knowledge'));assert.equal((await f.domain.state(f.users.patient,'conversation')).proposal.id,proposal.id);
 await f.domain.process(f.users.patient,f.input(),f.intent('availability'));await assert.rejects(f.confirm(f.users.patient,proposal),e=>e.status===409);assert.equal((await f.repo.appointments(f.users.patient))[0].status,'PRE_RESERVED');
}finally{await f.db.close();}});

test('al reprogramar con varias citas se identifica primero el objetivo y después se piden fecha y hora',async()=>{const f=await fixture();try{
 await secondChange(f);const start=await f.domain.process(f.users.admin,f.input(),f.intent('reschedule'));assert.match(start.reply,/Qué cita quieres gestionar/);assert.equal(start.proposal,undefined);
 const state=await f.domain.state(f.users.admin,'conversation'),index=state.selection.choices.findIndex(c=>c.appointment_code==='TCUS-DEMO-002')+1;
 const input=f.input('sendMessage','conversation',{chatInput:String(index)}),intent=await f.jobs.interpret(f.users.admin,input);const chosen=await f.domain.process(f.users.admin,input,intent);assert.match(chosen.reply,/lunes/);assert.equal((await f.domain.state(f.users.admin,'conversation')).draft.appointment_code,'TCUS-DEMO-002');
}finally{await f.db.close();}});

test('el dato esperado acepta motivos naturales; preguntas ajenas y saludos no se convierten en motivo',async()=>{const f=await fixture();try{
 const user=f.users.otherPatient;
 f.interpreter.interpret=async(message)=>f.intent('reserve',{reason:message,dialogue_act:'answer',dialogue_target:'reason'});
 for(const message of ['Dolor de estómago','Tengo dolor de estómago','Consulta de seguimiento']){
  const session=randomUUID(),begin=f.input('sendMessage',session);
  const prompt=await f.domain.process(user,begin,f.intent('reserve',{doctor_name:'Carlos Pérez',date:f.date,time:'15:00'}));assert.match(prompt.reply,/motivo general/);
  assert.equal((await f.domain.grounding(user,begin)).awaiting,'reason');
  const answer=f.input('sendMessage',session,{chatInput:message}),interpretation=await f.jobs.interpret(user,answer);assert.equal(interpretation.reason,message);
  const proposal=await f.domain.process(user,answer,interpretation);assert.equal(proposal.proposal.kind,'reserve');assert.equal((await f.repo.appointments(user)).length,0);
 }
 const {resolveConversation}=await import('../apps/backend/dist/conversation.js'),grounding={draft:{intent:'reserve'},awaiting:'reason'};
 assert.equal(resolveConversation('¿Qué es Python?',grounding),null);assert.equal(resolveConversation('Me puedes explicar Python',grounding),null);assert.equal(resolveConversation('Cancélalo',grounding),null);assert.equal(resolveConversation('No quiero continuar',grounding),null);assert.equal(resolveConversation('Hola',grounding).intent,'greeting');assert.equal(resolveConversation('Dolor de estómago',{draft:{intent:'reserve'}}),null);
}finally{await f.db.close();}});

test('fecha y hora juntas se calculan desde el servidor, incluyendo abreviaturas y acentos',async()=>{const {resolveConversation}=await import('../apps/backend/dist/conversation.js');
 for(const text of ['El prox lúnes a las 3pm','el lunes siguiente a las 14:30','el próximo lunes a las 2:30 p. m.']){
  const answer=resolveConversation(text,{draft:{intent:'reserve'},today:'2026-10-06'});assert.equal(answer.date,'2026-10-12');assert.equal(answer.time,text.includes('3pm')?'15:00':'14:30');
 }
 assert.equal(resolveConversation('el lunes cualquiera a las 3pm',{draft:{intent:'reserve'},today:'2026-10-06'}),null);
});

test('consultas administrativas actuales usan la agenda; preguntas de procedimiento conservan el RAG',async()=>{const f=await fixture();try{
 const {operationalQuery}=await import('../apps/backend/dist/conversation.js');let ragCalls=0;f.domain=new (await modules)[2].DomainService(f.repo,new (await import('../apps/backend/dist/adapters/sessions.js')).SqlSessionRepository(f.db),f.db,{answer:async()=>{ragCalls++;return 'Procedimiento';}});
 for(const text of ['¿Hay pagos por confirmar?','Hay pagos pendientes?','Qué pagos faltan por verificar?','Hay nuevas citas por confirmar?']){
  const input=f.input('sendMessage',randomUUID(),{chatInput:text});assert.equal(operationalQuery(text,'ADMIN'),'pending_payments');assert.equal(await f.domain.prepareKnowledge(f.users.admin,input,f.intent('knowledge')),undefined);
  const reply=await f.domain.process(f.users.admin,input,f.intent('knowledge'));assert.match(reply.reply,/TCUS-DEMO-001/);
 }
 assert.equal(ragCalls,0);const procedure=f.input('sendMessage','procedure',{chatInput:'¿Cómo verifico un pago?'});assert.equal(await f.domain.prepareKnowledge(f.users.admin,procedure,f.intent('knowledge')),'Procedimiento');
 const status=f.input('sendMessage',randomUUID(),{chatInput:'¿Qué pasó con mi cita?'});assert.match((await f.domain.process(f.users.patient,status,f.intent('knowledge'))).reply,/Estado: Pre-reserva/);
}finally{await f.db.close();}});

test('aprobar una cancelación en el contexto de revisión conserva la solicitud y exige confirmación',async()=>{const f=await fixture();try{
 await f.db.transaction(cx=>f.repo.execute(f.users.admin,'verify_payment',{appointment_code:'TCUS-DEMO-001'},cx));
 const request=await f.domain.process(f.users.patient,f.input(),f.intent('cancel'));await f.confirm(f.users.patient,request.proposal);
 await f.domain.process(f.users.admin,f.input(),f.intent('pending_requests'));
 const approval=await f.domain.process(f.users.admin,f.input('sendMessage','conversation',{chatInput:'Confirmo la cancelación de la cita TCUS-DEMO-001'}),f.intent('cancel',{appointment_code:'TCUS-DEMO-001'}));assert.equal(approval.proposal.kind,'approve_change');
 assert.equal((await f.repo.changes(f.users.admin))[0].status,'PENDING');await f.confirm(f.users.admin,approval.proposal);
 assert.equal((await f.repo.changeDetails(f.users.patient))[0].status,'APPROVED');assert.equal((await f.repo.appointments(f.users.patient))[0].status,'CANCELLED');
}finally{await f.db.close();}});

test('revisar cambios respeta el tipo y la cita; varias cancelaciones exigen elegir sin aprobar otra solicitud',async()=>{const f=await fixture();try{
 const reschedule=await paidChange(f),cancel=await secondChange(f);
 await f.domain.process(f.users.admin,f.input(),f.intent('pending_requests'));
 await f.domain.process(f.users.admin,f.input(),f.intent('select_request',{request_id:reschedule.id}));
 // A previously focused reschedule must not win over an explicitly named cancellation.
 await f.domain.process(f.users.admin,f.input(),f.intent('pending_requests'));
 const choice=await f.domain.process(f.users.admin,f.input(),f.intent('cancel',{appointment_code:'TCUS-DEMO-002'}));assert.equal(choice.proposal.kind,'approve_change');
 assert.equal((await f.domain.state(f.users.admin,'conversation')).proposal.payload.request_id,cancel.id);
 await f.domain.process(f.users.admin,f.input('dismiss'),null);
 // Add a third patient's request to test ambiguity rather than a global "only one" shortcut.
 const id=randomUUID();await f.db.query('INSERT INTO telecus_demo_profiles(id,role,full_name,email,active) VALUES($1,$2,$3,$4,1)',[id,'PATIENT','Tercer paciente','tercero@example.test']);
 await f.db.query('INSERT INTO telecus_demo_appointments(id,code,patient_id,doctor_id,start_time,end_time,status,payment_status,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',['third-appointment','TCUS-DEMO-003',id,f.users.doctor.id,f.date+'T20:00:00Z',f.date+'T20:30:00Z','CONFIRMED','VERIFIED','Prueba']);
 await f.db.transaction(cx=>f.repo.execute({...f.users.patient,id},'cancel',{appointment_code:'TCUS-DEMO-003'},cx));
 await f.domain.process(f.users.admin,f.input(),f.intent('pending_requests'));
 const ambiguous=await f.domain.process(f.users.admin,f.input(),f.intent('cancel'));assert.equal(ambiguous.proposal,undefined);assert.match(ambiguous.reply,/varias solicitudes/);
 const state=await f.domain.state(f.users.admin,'conversation');assert.equal(state.selection.choices.length,2);assert.ok(state.selection.choices.every(c=>c.request_id!==reschedule.id));
 assert.equal((await f.repo.changes(f.users.admin)).length,3);
}finally{await f.db.close();}});

test('saludar o preguntar algo ajeno conserva la propuesta; pre-reservar explica el pago sin anunciar Calendar',async()=>{const f=await fixture();try{
 const proposal=await f.domain.process(f.users.patient,f.input(),f.intent('cancel'));
 const greeting=await f.domain.process(f.users.patient,f.input(),f.intent('greeting'));assert.match(greeting.reply,/¡Hola!/);assert.equal(greeting.proposal.id,proposal.proposal.id);
 const outside=await f.domain.process(f.users.patient,f.input('sendMessage','conversation',{chatInput:'¿Qué es Python?'}),f.intent('unknown'));assert.match(outside.reply,/agendamiento/);assert.equal(outside.proposal.id,proposal.proposal.id);
 f.repo.cfg.mode='supabase-live';f.repo.appointments=async()=>[];f.repo.doctors=async()=>[{id:f.users.otherDoctor.id,full_name:'Carlos Pérez'}];f.repo.availability=async()=>['15:00'];
 const reserve=await f.domain.process(f.users.otherPatient,f.input('sendMessage','new'),f.intent('reserve',{doctor_name:'Carlos Pérez',date:f.date,time:'15:00',reason:'Seguimiento'}));assert.match(reserve.reply,/pre-reserva con el pago pendiente/);assert.doesNotMatch(reserve.reply,/agenda real|Google se procesan/);
}finally{await f.db.close();}});

test('notificaciones se confirman con la transacción, se aíslan por usuario y rol y no incluyen el motivo',async()=>{const f=await fixture();try{
 const {NotificationsService}=await import('../apps/backend/dist/notifications.js'),inbox=new NotificationsService(new (await import('../apps/backend/dist/adapters/notification-inbox.js')).DatabaseNotificationInbox(f.db));
 assert.equal((await inbox.list(f.users.doctor)).unread,0);
 await assert.rejects(f.db.transaction(async cx=>{await f.repo.execute(f.users.admin,'verify_payment',{appointment_code:'TCUS-DEMO-001'},cx);throw Error('Abortar prueba');}));
 assert.equal((await inbox.list(f.users.patient)).unread,0);assert.equal((await f.repo.appointments(f.users.patient))[0].payment_status,'PENDING');
 await f.db.transaction(cx=>f.repo.execute(f.users.admin,'verify_payment',{appointment_code:'TCUS-DEMO-001'},cx));
 const patient=await inbox.list(f.users.patient),doctor=await inbox.list(f.users.doctor);assert.equal(patient.unread,1);assert.match(patient.items[0].title,/Pago verificado/);assert.match(doctor.items[0].title,/asignada/);assert.doesNotMatch(JSON.stringify(patient),/Consulta general de prueba|example\.test/);
 assert.equal((await inbox.list(f.users.otherPatient)).unread,0);assert.equal((await inbox.list({...f.users.patient,role:'ADMIN'})).unread,0);
 assert.equal((await inbox.read(f.users.otherPatient,[patient.items[0].id])).updated,0);assert.equal((await inbox.list(f.users.patient)).unread,1);
 await inbox.read(f.users.patient,[patient.items[0].id]);await inbox.read(f.users.patient,[patient.items[0].id]);assert.equal((await inbox.list(f.users.patient)).unread,0);
 await assert.rejects(inbox.read(f.users.patient,['bad-id']));await assert.rejects(inbox.list(f.users.patient,undefined,10000));
 const request=await f.domain.process(f.users.patient,f.input(),f.intent('cancel'));await f.confirm(f.users.patient,request.proposal);
 assert.match((await inbox.list(f.users.admin)).items[0].title,/solicitud/);assert.equal((await inbox.list(f.users.doctor)).items.length,1);
 const changes=await f.repo.changes(f.users.admin),approval=await f.domain.process(f.users.admin,f.input(),f.intent('approve_change',{request_id:changes[0].id}));await f.confirm(f.users.admin,approval.proposal);
 const p1=await inbox.list(f.users.patient,undefined,2),p2=await inbox.list(f.users.patient,p1.next_cursor,2);assert.equal(p1.items.some(n=>p2.items.some(m=>m.id===n.id)),false);assert.match((await inbox.list(f.users.doctor)).items[0].title,/cancelada/);
}finally{await f.db.close();}});
