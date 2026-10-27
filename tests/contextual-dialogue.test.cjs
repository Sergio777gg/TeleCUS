const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function fixture(){
 const [{Database},{Repository,demoIds},{DomainService},{AuthService},{JobsService},{SqlSessionRepository}]=await Promise.all([
  'database','repository','domain','auth','jobs','adapters/sessions'
 ].map(name=>import('../apps/backend/dist/'+name+'.js')));
 const cfg={mode:'demo',databaseUrl:'',databaseFile:':memory:',demoSecret:'test-secret'.repeat(8),internalToken:'internal-secret'.repeat(4),worker:false,modelTimeoutMs:1000};
 const db=new Database('',':memory:');await db.initialize();const repo=new Repository(db,cfg);await repo.seed();
 const domain=new DomainService(repo,new SqlSessionRepository(db),db),auth=new AuthService(db,cfg);
 const interpreter={interpret:async()=>{throw Error('Unexpected inference');}},jobs=new JobsService(db,cfg,domain,auth,interpreter);
 const users={};for(const [name,id]of Object.entries(demoIds))users[name]=(await db.query('SELECT * FROM telecus_demo_profiles WHERE id=$1',[id]))[0];
 const date=(await db.query('SELECT start_time FROM telecus_demo_appointments'))[0].start_time.slice(0,10);
 const input=(text,sessionId='dialogue',extra={})=>({action:'sendMessage',chatInput:text,sessionId,requestId:randomUUID(),...extra});
 const intent=(intent,fields={})=>({intent,appointment_code:null,doctor_name:null,date:null,time:null,reason:null,request_id:null,...fields});
 const turn=async(user,text,session='dialogue')=>{const request=input(text,session);return domain.process(user,request,await jobs.interpret(user,request));};
 return {db,repo,domain,auth,jobs,interpreter,users,date,input,intent,turn};
}
test('elipsis temporal necesita la pregunta de fecha; no inventa referentes ni ignora negaciones',async()=>{
 const {resolveConversation}=await import('../apps/backend/dist/conversation.js');
 const base={draft:{intent:'reschedule'},today:'2026-10-17'},context={...base,dialogue:{expectedSlot:'date',requestedWeekday:1,known:{}}};
 for(const message of ['El próximo','el siguiente','el que viene','de la próxima semana'])assert.equal(resolveConversation(message,context).date,'2026-10-19');
 assert.equal(resolveConversation('el próximo a las 3pm',context).time,'15:00');
 for(const message of ['no el próximo','no quiero el siguiente','el próximo después del otro'])assert.equal(resolveConversation(message,context),null);
 assert.equal(resolveConversation('el próximo',base),null);
 assert.equal(resolveConversation('el próximo',{...context,dialogue:{expectedSlot:'doctor',requestedWeekday:null,known:{}}}),null);
 assert.equal(resolveConversation('el otro',context).dialogue_act,'clarify');
});
test('pregunta de lunes y respuesta el próximo completan la misma reprogramación sin modelo',async()=>{
 const f=await fixture();try{
  await f.domain.process(f.users.patient,f.input('Reprogramar mi cita'),f.intent('reschedule'));
  const before=await f.domain.grounding(f.users.patient,f.input('El próximo'));
  assert.equal(before.dialogue.expectedSlot,'date');assert.match(before.dialogue.lastQuestion,/Qué lunes/);
  const reply=await f.turn(f.users.patient,'El próximo');assert.match(reply.reply,/qué hora/i);
  const state=await f.domain.state(f.users.patient,'dialogue');assert.equal(state.draft.intent,'reschedule');assert.equal(state.draft.appointment_code,'TCUS-DEMO-001');
  assert.equal(state.draft.date,(await import('../apps/backend/dist/calendar.js')).calendarAnswer('el próximo lunes',before.today));
  assert.equal((await f.domain.grounding(f.users.patient,f.input(''))).dialogue.expectedSlot,'time');
  const completed=await f.turn(f.users.patient,'a las 3');assert.equal(completed.proposal.kind,'reschedule');assert.match(completed.proposal.summary,/3:00/);
  assert.equal((await f.db.query('SELECT count(*) AS n FROM telecus_audit'))[0].n,0);
 }finally{await f.db.close();}
});
test('corregir la hora de una propuesta conserva sus datos y exige una confirmación nueva',async()=>{
 const f=await fixture();try{
  const user=f.users.otherPatient,old=await f.domain.process(user,f.input('Reservar'),f.intent('reserve',{doctor_name:f.users.otherDoctor.full_name,date:f.date,time:'14:00',reason:'Consulta general'}));
  assert.ok(old.proposal);
  const changed=await f.turn(user,'mejor a las 3');assert.ok(changed.proposal);assert.notEqual(changed.proposal.id,old.proposal.id);
  const state=await f.domain.state(user,'dialogue');assert.equal(state.proposal.payload.time,'15:00');assert.equal(state.proposal.payload.date,f.date);assert.equal(state.proposal.payload.reason,'Consulta general');assert.equal(state.proposal.payload.doctor_name,f.users.otherDoctor.full_name);
  await assert.rejects(f.domain.process(user,f.input('', 'dialogue',{action:'confirm',proposalId:old.proposal.id}),null),e=>e.status===409);
  assert.equal((await f.repo.appointments(user)).length,0);
 }finally{await f.db.close();}
});
test('una referencia ambigua aclara el dato y conserva el borrador',async()=>{
 const f=await fixture();try{
  await f.domain.process(f.users.patient,f.input('Reprogramar'),f.intent('reschedule'));
  const before=(await f.domain.state(f.users.patient,'dialogue')).draft;
  const response=await f.turn(f.users.patient,'el otro');assert.match(response.reply,/fecha completa/);assert.equal(response.proposal,undefined);
  assert.deepEqual((await f.domain.state(f.users.patient,'dialogue')).draft,before);
 }finally{await f.db.close();}
});
test('el modelo recibe pregunta e intercambios, y el servidor resuelve la fecha elíptica',async()=>{
 const f=await fixture();try{
  await f.domain.process(f.users.otherPatient,f.input('Quiero reservar'),f.intent('reserve',{doctor_name:f.users.doctor.full_name}));
  f.interpreter.interpret=async(message,context)=>{
   assert.equal(message,'Si es posible, el lunes más cercano');assert.equal(context.dialogue.activeTask,'reserve');assert.equal(context.dialogue.expectedSlot,'date');assert.equal(context.dialogue.requestedWeekday,1);
   assert.match(context.dialogue.lastQuestion,/Qué lunes/);assert.equal(context.dialogue.recentTurns.at(-1).user,'Quiero reservar');
   return f.intent('unknown',{date_expression:'el próximo',dialogue_act:'answer'});
  };
  const response=await f.turn(f.users.otherPatient,'Si es posible, el lunes más cercano');assert.match(response.reply,/qué hora/i);
  assert.match((await f.domain.state(f.users.otherPatient,'dialogue')).draft.date,/^\d{4}-\d{2}-\d{2}$/);
 }finally{await f.db.close();}
});
test('una referencia horaria inválida del modelo permite aclarar sin elegir ni confirmar un turno',async()=>{
 const f=await fixture();try{
  await f.domain.process(f.users.patient,f.input('Reprogramar'),f.intent('reschedule',{date:f.date}));
  f.interpreter.interpret=async()=>f.intent('unknown',{dialogue_act:'ask',dialogue_target:'time',reference_time:'hora inventada'});
  const reply=await f.turn(f.users.patient,'Me explicas este dato por favor');assert.equal(reply.proposal,undefined);
  assert.equal((await f.domain.state(f.users.patient,'dialogue')).draft.time,undefined);
  assert.equal((await f.db.query('SELECT count(*) AS n FROM telecus_audit'))[0].n,0);
 }finally{await f.db.close();}
});

test('una respuesta del modelo no transforma la reprogramación activa en una reserva',async()=>{
 const f=await fixture();try{
  await f.domain.process(f.users.patient,f.input('Reprogramar'),f.intent('reschedule',{date:f.date}));
  f.interpreter.interpret=async()=>f.intent('reserve',{time:'15:00',dialogue_act:'answer'});
  const reply=await f.turn(f.users.patient,'Mejor a las tres');assert.equal(reply.proposal.kind,'reschedule');
  const state=await f.domain.state(f.users.patient,'dialogue');assert.equal(state.proposal.payload.appointment_code,'TCUS-DEMO-001');assert.equal(state.proposal.payload.date,f.date);
 }finally{await f.db.close();}
});
test('memoria acotada por usuario rol y sesión; el motivo no se duplica en el historial',async()=>{
 const f=await fixture();try{
  const user=f.users.otherPatient;
  await f.domain.process(user,f.input('Reservar'),f.intent('reserve',{doctor_name:f.users.otherDoctor.full_name,date:f.date,time:'14:00'}));
  f.interpreter.interpret=async(message)=>f.intent('reserve',{reason:message,dialogue_act:'answer',dialogue_target:'reason'});
  await f.turn(user,'Motivo ficticio de seguimiento');
  let context=await f.domain.grounding(user,f.input(''));assert.equal(context.dialogue.recentTurns.at(-1).user,'[Motivo general recibido]');
  for(let n=0;n<7;n++)await f.turn(user,'Hola');
  context=await f.domain.grounding(user,f.input(''));assert.equal(context.dialogue.recentTurns.length,4);
  for(const [other,session]of [[f.users.patient,'dialogue'],[user,'another'],[{...user,role:'ADMIN'},'dialogue']]){
   const isolated=await f.domain.grounding(other,f.input('',session));assert.equal(isolated.dialogue.recentTurns.length,0);assert.deepEqual(isolated.dialogue.known,{});assert.equal(isolated.draft,null);
  }
 }finally{await f.db.close();}
});
test('dos usuarios encolados simultáneamente responden a sus propias preguntas y esperan su turno',async()=>{
 const f=await fixture();try{
  await f.domain.process(f.users.patient,f.input('Reprogramar'),f.intent('reschedule'));
  await f.domain.process(f.users.otherPatient,f.input('Reservar'),f.intent('reserve',{doctor_name:f.users.doctor.full_name,date:f.date}));
  const a=f.users.patient,b=f.users.otherPatient;
  const jobs=await Promise.all([f.jobs.enqueue(a,f.input('El próximo'),'Bearer '+f.auth.issueDemo(a.id)),f.jobs.enqueue(b,f.input('a las 3'),'Bearer '+f.auth.issueDemo(b.id))]);
  await Promise.all([f.jobs.workOnce(),f.jobs.workOnce()]);
  const statuses=await Promise.all(jobs.map((j,i)=>f.jobs.get(i?b:a,j.id)));assert.equal(statuses.filter(j=>j.status==='done').length,1);assert.equal(statuses.filter(j=>j.status==='queued').length,1);
  await f.jobs.workOnce();for(let i=0;i<2;i++)assert.equal((await f.jobs.get(i?b:a,jobs[i].id)).status,'done');
  const sa=await f.domain.state(a,'dialogue'),sb=await f.domain.state(b,'dialogue');assert.equal(sa.draft.intent,'reschedule');assert.equal(sa.draft.time,undefined);assert.equal(sb.draft.intent,'reserve');assert.equal(sb.draft.time,'15:00');
  assert.notDeepEqual(sa.dialogue.recentTurns,sb.dialogue.recentTurns);
 }finally{await f.db.close();}
});
test('una inferencia lenta no bloquea encolar al otro usuario; el trabajador no ejecuta dos a la vez',async()=>{
 const f=await fixture();let release;try{
  let started;const entered=new Promise(r=>{started=r;}),gate=new Promise(r=>{release=r;});
  f.interpreter.interpret=async()=>{started();await gate;return f.intent('menu');};
  const a=f.users.patient,b=f.users.otherPatient;
  const first=await f.jobs.enqueue(a,f.input('Me orientas por favor'),'Bearer '+f.auth.issueDemo(a.id));
  const running=f.jobs.workOnce();await entered;
  const second=await f.jobs.enqueue(b,f.input('Hola'),'Bearer '+f.auth.issueDemo(b.id));await f.jobs.workOnce();
  assert.equal((await f.jobs.get(a,first.id)).status,'running');assert.equal((await f.jobs.get(b,second.id)).status,'queued');
  release();await running;await f.jobs.workOnce();assert.equal((await f.jobs.get(b,second.id)).status,'done');
 }finally{release?.();await f.db.close();}
});


test('fechas españolas: mes escrito, día en letras, formato colombiano y calendario válido',async()=>{
 const {calendarAnswer}=await import('../apps/backend/dist/calendar.js');
 for(const expression of ['19 de octubre','diecinueve de octubre','el 19 de octubre de 2026','lunes, diecinueve de octubre del 2026','19/10/2026','19-10-2026','2026-10-19'])assert.equal(calendarAnswer(expression,'2026-10-18'), '2026-10-19',expression);
 for(const expression of ['31 de abril','29 de febrero de 2026','2026-02-31','martes 19 de octubre de 2026','no el 19 de octubre','19/10/26','treinta y dos de octubre'])assert.equal(calendarAnswer(expression,'2026-10-18'),null,expression);
 assert.equal(calendarAnswer('veintinueve de febrero de 2028'),'2028-02-29');
 assert.equal(calendarAnswer('19 de octubre','2026-11-01'),'2026-10-19'); // Domain rejects past dates; never rolls silently to 2027.
 assert.equal(calendarAnswer('mañana','2026-12-31'),'2027-01-01');
});

test('peticiones afirmativas prevalecen sobre saludos y etiquetas sociales del modelo, sin convertir preguntas o negaciones',async()=>{
 const {resolveConversation,resolveInterpretation,emptyIntent}=await import('../apps/backend/dist/conversation.js');
 const context={role:'PATIENT',today:'2026-10-18',draft:{intent:'reserve'},dialogue:{expectedSlot:'date',requestedWeekday:1,known:{}}};
 for(const prefix of ['','Hola, ','Buenos días, ','Buenas tardes, '])for(const verb of ['agendar','solicitar','reservar','pedir']){
  const text=prefix+'quiero '+verb+' una cita el diecinueve de octubre a las 3 p. m.';
  const result=resolveConversation(text,context);assert.equal(result.intent,'reserve',text);assert.equal(result.date,'2026-10-19');assert.equal(result.time,'15:00');
  assert.deepEqual(resolveInterpretation(text,emptyIntent('greeting',{dialogue_act:'social'}),context),result);
 }
 for(const text of ['Hola, quiero agendar una cita','Hola quiero solicitar una cita','Hola, necesito una cita','Quiero una cita'])assert.equal(resolveConversation(text,{role:'PATIENT'}).intent,'reserve');
 for(const text of ['Hola, no quiero agendar una cita','¿Cómo puedo agendar una cita?','¿Para qué debo elegir un médico?'])assert.notEqual(resolveConversation(text,context)?.intent,'reserve',text);
 assert.equal(resolveConversation('Hola, quiero cancelar mi cita TCUS-DEMO-001',context).appointment_code,'TCUS-DEMO-001');
 assert.equal(resolveConversation('diecinueve de octubre',context).date,'2026-10-19');
 assert.equal(resolveConversation('Para qué sirve la fecha?',context).dialogue_act,'ask');
});

test('primer turno mixto inicia la reserva y conserva la fecha sin invocar inferencia',async()=>{
 const f=await fixture();try{
  const parts=f.date.split('-'),months=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const result=await f.turn(f.users.otherPatient,`Hola, quiero agendar una cita el ${Number(parts[2])} de ${months[Number(parts[1])-1]} de ${parts[0]}`);
  assert.match(result.reply,/médico/);const state=await f.domain.state(f.users.otherPatient,'dialogue');assert.equal(state.draft.date,f.date);assert.equal(state.draft.intent,'reserve');
 }finally{await f.db.close();}
});


test('repetir la petición con una fecha escrita completa el paso sin perder el médico elegido',async()=>{
 const f=await fixture();try{
  const user=f.users.otherPatient,doctor=f.users.otherDoctor.full_name;
  await f.domain.process(user,f.input('Reservar'),f.intent('reserve',{doctor_name:doctor}));
  const [year,month,day]=f.date.split('-'),months=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const result=await f.turn(user,`Quiero solicitar una cita el ${Number(day)} de ${months[Number(month)-1]} de ${year}`);
  assert.match(result.reply,/hora/);const state=await f.domain.state(user,'dialogue');assert.equal(state.draft.doctor_name,doctor);assert.equal(state.draft.date,f.date);
 }finally{await f.db.close();}
});
