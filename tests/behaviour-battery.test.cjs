const {test}=require('node:test'),assert=require('node:assert/strict');
test('batería CheckList: cortesía, calendario, controles y contrastes conservan el resultado esperado',async()=>{
 const r=await require('./evaluation/behaviour-run.cjs').run();assert.deepEqual(r.rows.filter(x=>!x.pass).map(x=>({id:x.id,text:x.text,checks:x.checks})),[]);assert.equal(r.summary.calendar.passed,r.summary.calendar.total);
});
test('batería de conversaciones completas: estado, privacidad, recuperación y autorización',async()=>{
 const rows=await require('./evaluation/behaviour-flows.cjs').run();assert.deepEqual(rows.filter(r=>!r.pass),[]);
});
test('un fallo de conexión de inferencia da un error recuperable específico',async()=>{
 const {NodeRedInterpreter}=await import('../apps/backend/dist/adapters/interpretation.js');const adapter=new NodeRedInterpreter('http://fictional.invalid/interpret','synthetic',1000,async()=>{throw new TypeError('synthetic connection failure');});
 await assert.rejects(adapter.interpret('Una pregunta',{}),e=>e.getStatus?.()===503&&/asistente local|interpretación/.test(e.message));
});

test('el rechazo de datos inciertos protege cualquier campo y no convierte síntomas en negativas',async()=>{
 const {resolveInterpretation,emptyIntent}=await import('../apps/backend/dist/conversation.js');
 for(const slot of ['doctor','date','time','reason'])for(const text of ['No sé todavía','Aún no he decidido','No estoy seguro','Todavía no lo sé']){
  const r=resolveInterpretation(text,emptyIntent('reserve',{date:'2026-10-26',time:'14:30',reason:text,doctor_name:'Inventado',dialogue_act:'answer'}),{draft:{intent:'reserve'},dialogue:{expectedSlot:slot}});
  assert.equal(r.intent,'unknown');assert.equal(r.dialogue_act,'clarify');for(const key of ['date','time','reason','doctor_name'])assert.equal(r[key],null);
 }
 const r=resolveInterpretation('No tengo apetito',emptyIntent('reserve',{reason:'No tengo apetito',dialogue_act:'answer',dialogue_target:'reason'}),{draft:{intent:'reserve'},dialogue:{expectedSlot:'reason'}});assert.equal(r.reason,'No tengo apetito');
});
test('el plazo de interpretación se conserva y un JSON inválido se informa como fallo recuperable',async()=>{
 const {NodeRedInterpreter}=await import('../apps/backend/dist/adapters/interpretation.js');
 const timed=new NodeRedInterpreter('http://fictional/interpret','synthetic',10,async(_u,{signal})=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));
 const keepAlive=setTimeout(()=>{},100);try{await assert.rejects(timed.interpret('Texto',{}),e=>e.name==='TimeoutError');}finally{clearTimeout(keepAlive);}
 const invalid=new NodeRedInterpreter('http://fictional/interpret','synthetic',1000,async()=>new Response('{invalid'));await assert.rejects(invalid.interpret('Texto',{}),e=>e.getStatus?.()===503);
});

test('las expresiones de cercanía resuelven cualquier día al futuro sin aceptar calificadores arbitrarios',async()=>{
 const {calendarAnswer}=await import('../apps/backend/dist/calendar.js');const names=['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
 for(let base=19;base<=25;base++)for(let day=0;day<7;day++)for(const qualifier of ['más cercano','más próximo','siguiente']){
  const today=`2026-10-${base}`,d=new Date(today+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+((day-d.getUTCDay()+7)%7||7));
  assert.equal(calendarAnswer(names[day]+' '+qualifier,today),d.toISOString().slice(0,10));
 }
 for(const text of ['lunes anterior','martes cercano a Navidad','el lunes, no sé cuál'])assert.equal(calendarAnswer(text,'2026-10-19'),null);
});

test('una fecha y hora coloquiales se aportan juntas; preguntar no selecciona esos datos',async()=>{
 const {resolveConversation,emptyIntent,resolveInterpretation}=await import('../apps/backend/dist/conversation.js');const context={today:'2026-10-19',draft:{intent:'reschedule'},dialogue:{expectedSlot:'date',requestedWeekday:1}};
 for(const text of ['El próximo lunes, a eso de las tres de la tarde','El siguiente lunes a las tres de la tarde','El próximo lunes para las tres de la tarde']){
  const r=resolveConversation(text,context);assert.equal(r.date,'2026-10-26');assert.equal(r.time,'15:00');assert.equal(r.intent,'reschedule');
 }
 const r=resolveInterpretation('¿El próximo lunes a las tres está libre?',emptyIntent('reserve',{date:'2026-10-26',time:'15:00',dialogue_act:'answer'}),context);assert.equal(r.time,null);assert.equal(r.date,null);
});

test('la cortesía interrogativa no aporta campos; las explicaciones de decisiones se mantienen en el paso',async()=>{
 const {resolveInterpretation,emptyIntent}=await import('../apps/backend/dist/conversation.js');const context={draft:{intent:'reserve'},dialogue:{expectedSlot:'doctor'}};
 const social=resolveInterpretation('¿Cómo te va hoy?',emptyIntent('greeting',{dialogue_act:'ask',time:'14:00',reason:'Inventado'}),context);assert.equal(social.intent,'greeting');assert.equal(social.dialogue_act,'social');assert.equal(social.reason,null);assert.equal(social.time,null);
 for(const text of ['¿Qué cambia dependiendo del profesional que escoja?','¿Qué implica según el médico que elija?']){
  const r=resolveInterpretation(text,emptyIntent('support'),context);assert.equal(r.dialogue_act,'ask');assert.equal(r.dialogue_target,'doctor');assert.equal(r.reason,null);
 }
});
