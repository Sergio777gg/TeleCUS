const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('las preguntas de propósito usan el paso y tienen prioridad sobre una etiqueta equivocada de soporte',async()=>{
 const {resolveConversation,resolveInterpretation,emptyIntent}=await import('../apps/backend/dist/conversation.js');
 const examples=[['doctor','Para qué? para la cita?'],['doctor','Pero para qué debo elegir un médico?'],['date','¿Por qué debo indicar la fecha?'],['time','¿Para qué elijo una hora?'],['reason','¿Por qué necesitas el motivo?'],['request','¿Para qué seleccionar una solicitud?'],['appointment','¿Para qué debo elegir una cita?'],['option','¿Qué significa esa lista de opciones?'],['confirmation','¿Para qué sirve confirmar?']];
 for(const [slot,text]of examples){
  const context={role:'PATIENT',draft:{intent:'reserve'},dialogue:{expectedSlot:slot}};
  for(const raw of [emptyIntent('support'),emptyIntent('greeting',{dialogue_act:'social'}),emptyIntent('reserve',{reason:text,doctor_name:'Inventado',time:'14:00'})]){
   const result=resolveInterpretation(text,raw,context);assert.equal(result.intent,'unknown',text);assert.equal(result.dialogue_act,'ask',text);assert.equal(result.dialogue_target,slot==='confirmation'?'task':slot,text);assert.equal(result.reason,null);assert.equal(result.doctor_name,null);
  }
  assert.equal(resolveConversation(text,context)?.dialogue_act,'ask',text);
 }
 const context={role:'PATIENT',draft:{intent:'reserve'},dialogue:{expectedSlot:'doctor'}};
 for(const text of ['Quiero hablar con un humano','No me estás entendiendo'])assert.equal(resolveConversation(text,context).intent,'support');
 for(const text of ['¿Para qué sirve Python?','¿Por qué el médico canceló mi cita?','¿Qué médico está asignado a mi cita?'])assert.notEqual(resolveConversation(text,context)?.dialogue_act,'ask',text);
});

test('explicar conserva selección, borrador y propuesta; después se puede elegir el médico',async()=>{
 const [{DomainService},{JobsService},{emptyIntent}]=await Promise.all(['domain','jobs','conversation'].map(p=>import('../apps/backend/dist/'+p+'.js')));
 const user={id:'patient-step-help',role:'PATIENT',active:true},map=new Map(),sessions={load:async(_u,id)=>structuredClone(map.get(id)||{}),save:async(_u,id,s)=>map.set(id,structuredClone(s)),lock:async()=>{}},unit={transaction:async f=>f({})};
 const repo={mode:'demo',doctors:async()=>[{id:'doctor-test',full_name:'Médico de prueba'}],appointments:async()=>[],execute:async()=>{throw Error('La explicación no debe ejecutar agenda');}};
 const domain=new DomainService(repo,sessions,unit),jobs=new JobsService({}, {},domain,{}, {interpret:async()=>{throw Error('Esta pregunta clara no necesita inferencia');}}),input=text=>({action:'sendMessage',chatInput:text,sessionId:'explanation-flow',requestId:randomUUID()});
 await domain.process(user,input('Quiero una cita'),emptyIntent('reserve'));
 const original=await domain.state(user,'explanation-flow');assert.equal(original.selection.type,'doctor');
 for(const text of ['Para qué? para la cita?','Pero para qué debo elegir un médico?']){
  const request=input(text),intent=await jobs.interpret(user,request),result=await domain.process(user,request,intent);
  assert.match(result.reply,/consultar sus horarios/);assert.match(result.reply,/Médico de prueba/);assert.equal(result.handoff,undefined);
  const state=await domain.state(user,'explanation-flow');assert.deepEqual(state.draft,original.draft);assert.deepEqual(state.selection,original.selection);assert.equal(state.context.supportOffers,undefined);
 }
 const select=input('1');await domain.process(user,select,await jobs.interpret(user,select));assert.equal((await domain.state(user,'explanation-flow')).draft.doctor_id,'doctor-test');
 const before=await domain.state(user,'explanation-flow');const explanation=input('¿Para qué sirve la fecha?'),result=await domain.process(user,explanation,await jobs.interpret(user,explanation));assert.match(result.reply,/disponibilidad del día/);assert.equal(result.handoff,undefined);assert.deepEqual((await domain.state(user,'explanation-flow')).draft,before.draft);
 const proposal={id:randomUUID(),kind:'reserve',summary:'Pre-reserva ficticia',expires_at:new Date(Date.now()+600000).toISOString(),payload:{intent:'reserve'}};map.set('explanation-flow',{proposal});
 const confirmation=input('¿Para qué sirve confirmar?'),reply=await domain.process(user,confirmation,await jobs.interpret(user,confirmation));assert.match(reply.reply,/autoriza/);assert.equal(reply.proposal.id,proposal.id);assert.deepEqual((await domain.state(user,'explanation-flow')).proposal,proposal);
});

test('la explicación semántica de un campo evita una segunda clasificación que podría cambiar el tema',async()=>{
 const {NodeRedInterpreter}=await import('../apps/backend/dist/adapters/interpretation.js');let calls=0;
 const interpreter=new NodeRedInterpreter('http://synthetic/interpret','synthetic',1000,async()=>{calls++;if(calls>1)throw Error('No se necesita clasificar otra vez');return new Response(JSON.stringify({field_understanding:{act:'explain',value:null,target:'doctor'}}));});
 const result=await interpreter.interpret('Es importante para mí saber lo que se consigue antes de escoger',{role:'PATIENT',draft:{intent:'reserve'},awaiting:'doctor'});assert.equal(result.intent,'unknown');assert.equal(result.dialogue_act,'ask');assert.equal(result.dialogue_target,'doctor');assert.equal(calls,1);
 const {resolveInterpretation}=await import('../apps/backend/dist/conversation.js');const resolved=resolveInterpretation('Es importante para mí saber lo que se consigue antes de escoger',result,{role:'PATIENT',draft:{intent:'reserve'},awaiting:'doctor'});assert.equal(resolved.dialogue_act,'ask');assert.equal(resolved.dialogue_target,'doctor');
});

test('un cambio documental del día no modifica las restricciones de agenda',async()=>{
 const {serviceDate}=await import('../apps/backend/dist/application/appointments.js');const monday=new Date();monday.setUTCDate(monday.getUTCDate()+((8-monday.getUTCDay())%7||7)+7);const tuesday=new Date(monday);tuesday.setUTCDate(tuesday.getUTCDate()+1);
 assert.ok(serviceDate(monday.toISOString().slice(0,10),'14:00').start);assert.throws(()=>serviceDate(tuesday.toISOString().slice(0,10),'14:00'),/lunes/);
});
