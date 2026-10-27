const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('la presentación de horas cubre medianoche y mediodía sin modificar enlaces ni identificadores',async()=>{
 const {clockText}=await import('../apps/backend/dist/presentation.js');
 assert.equal(clockText('00:30, 12:00, 14:30, 07:15 p. m.'),'12:30 a. m., 12:00 p. m., 2:30 p. m., 7:15 p. m.');
 const technical='https://example.test/14:00?x=15:30 2026-10-26T14:00:00-05:00 TCUS-2026-ABC';assert.equal(clockText(technical),technical);
 assert.equal(clockText('A las 2:30 p. m.'),'A las 2:30 p. m.');
});

test('la asistencia explícita mantiene prioridad ante cortesía, menú, selección o campos incidentales',async()=>{
 const {resolveConversation,resolveInterpretation,emptyIntent}=await import('../apps/backend/dist/conversation.js');
 const contexts=[{role:'PATIENT'}, {role:'PATIENT',selection:{type:'menu',choices:[{label:'Citas',intent:'reserve'}]}}, {role:'PATIENT',draft:{intent:'reserve',doctor_name:'Médico ficticio'},awaiting:'reason'}];
 const requests=['Necesito ayuda','Ayúdame','Quiero hablar con un humano','No, no me estás entendiendo','Prefiero contactar a una persona','La página no funciona','Estas respuestas no me resuelven nada','Puedes ayudarme'];
 for(const context of contexts)for(const text of requests){
   assert.equal(resolveConversation(text,context)?.intent,'support',text);
   const candidate=emptyIntent('greeting',{dialogue_act:'social',option_number:1,reason:text,time:'14:00'});
   const result=resolveInterpretation(text,candidate,context);assert.equal(result.intent,'support',text);assert.equal(result.reason,null);assert.equal(result.time,null);
 }
 const semantic=resolveInterpretation('Seguimos dando vueltas y preferiría otro canal',emptyIntent('support',{dialogue_act:'social',option_number:1}),contexts[1]);assert.equal(semantic.intent,'support');
 for(const text of ['No quiero hablar con un humano','No necesito ayuda','No entiendo qué hora son las 14','Necesito ayuda para elegir un médico','Tengo dolor de cabeza','Ya no tengo problemas con el chat','No me siento cómodo dando el motivo'])assert.notEqual(resolveConversation(text,contexts[0])?.intent,'support',text);
 for(const text of ['No necesito ayuda','Ya no tengo problemas con el chat','No quiero hablar con una persona'])assert.equal(resolveInterpretation(text,emptyIntent('support'),contexts[0]).intent,'greeting');
 assert.equal(resolveConversation('Ver opciones',contexts[0]).intent,'menu');
});

test('pedir ayuda conserva borrador y confirmación, no consulta registros ni realiza escrituras de agenda',async()=>{
 const {DomainService}=await import('../apps/backend/dist/domain.js'),{emptyIntent}=await import('../apps/backend/dist/conversation.js');
 let saved={draft:{intent:'reserve',doctor_name:'Médico ficticio',date:'2026-10-26',time:'14:30'},awaiting:'reason',proposal:{id:randomUUID(),kind:'reserve',summary:'Pre-reserva ficticia',expires_at:new Date(Date.now()+600000).toISOString(),payload:{}}};
 const original=structuredClone(saved),session={load:async()=>structuredClone(saved),save:async(_user,_id,state)=>{saved=structuredClone(state);},lock:async()=>{}},unit={transaction:async f=>f({})};
 const repository={mode:'demo',execute:async()=>{throw Error('No debe escribir agenda');},changeDetails:async()=>{throw Error('No debe consultar solicitudes');}},domain=new DomainService(repository,session,unit);
 const user={id:'synthetic-patient',role:'PATIENT',active:true};
 for(const message of ['Necesito ayuda','No me estás entendiendo','Quiero hablar con un humano']){
  const result=await domain.process(user,{action:'sendMessage',chatInput:message,sessionId:'support-regression',requestId:randomUUID()},emptyIntent('support',{dialogue_act:'social',reason:message}));
  assert.equal(result.handoff.reason,'requested');assert.match(result.reply,/resolver tus dudas/);assert.match(result.reply,/agendar/);assert.deepEqual(saved.draft,original.draft);assert.deepEqual(saved.proposal,original.proposal);
 }
});

test('las preguntas de aclaración no acumulan fallos; dos mensajes no resueltos sí ofrecen ayuda',async()=>{
 const {DomainService}=await import('../apps/backend/dist/domain.js'),{emptyIntent}=await import('../apps/backend/dist/conversation.js');
 let state={};const session={load:async()=>structuredClone(state),save:async(_u,_id,s)=>{state=structuredClone(s);},lock:async()=>{}},domain=new DomainService({mode:'demo'},session,{transaction:async f=>f({})});
 const user={id:'synthetic-patient',role:'PATIENT',active:true},input=chatInput=>({action:'sendMessage',chatInput,sessionId:'support-clarification',requestId:randomUUID()});
 for(let i=0;i<3;i++){const r=await domain.process(user,input('Explícame la hora'),emptyIntent('unknown',{dialogue_act:'ask',dialogue_target:'time',reference_time:'14:00'}));assert.equal(r.handoff,undefined);assert.match(r.reply,/2:00 p\. m\./);assert.doesNotMatch(r.reply,/14:00/);}
 for(let i=0;i<3;i++){const r=await domain.process(user,input('No quiero hablar con una persona'),emptyIntent('unknown',{dialogue_act:'clarify'}));assert.equal(r.handoff,undefined);}
 await domain.process(user,input('Texto no resuelto'),emptyIntent('unknown'));
 const result=await domain.process(user,input('Otro texto no resuelto'),emptyIntent('unknown'));assert.equal(result.handoff.reason,'unresolved');
});

test('el listado de disponibilidad muestra horas de 12 horas y conserva los valores internos',async()=>{
 const {DomainService}=await import('../apps/backend/dist/domain.js'),{emptyIntent}=await import('../apps/backend/dist/conversation.js');
 let state={};const sessions={load:async()=>structuredClone(state),save:async(_u,_id,s)=>{state=structuredClone(s);},lock:async()=>{}};
 const repo={mode:'demo',doctors:async()=>[{id:'d',full_name:'Médico ficticio'}],availability:async()=>['14:00','14:30','15:00','15:30']},domain=new DomainService(repo,sessions,{transaction:async f=>f({})});
 const next=new Date();next.setUTCDate(next.getUTCDate()+((8-next.getUTCDay())%7||7)+7);
 const result=await domain.process({id:'synthetic-patient',role:'PATIENT',active:true},{action:'sendMessage',chatInput:'Disponibilidad',sessionId:'clock-format',requestId:randomUUID()},emptyIntent('availability',{doctor_name:'Médico ficticio',date:next.toISOString().slice(0,10)}));
 assert.match(result.reply,/2:00 p\. m\./);assert.match(result.reply,/3:30 p\. m\./);assert.doesNotMatch(result.reply,/14:00|15:30/);
});
