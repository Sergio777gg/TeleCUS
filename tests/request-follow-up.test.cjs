const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function fixture(){
 const [{Database},{Repository,demoIds},{DomainService},{SqlSessionRepository},{resolveConversation}]=await Promise.all(['database','repository','domain','adapters/sessions','conversation'].map(n=>import('../apps/backend/dist/'+n+'.js')));
 const db=new Database('',':memory:');await db.initialize();const repo=new Repository(db,{mode:'demo'});await repo.seed();const users={};for(const [name,id]of Object.entries(demoIds))users[name]={...(await db.query('SELECT * FROM telecus_demo_profiles WHERE id=$1',[id]))[0],active:true};
 const sessions=new SqlSessionRepository(db),domain=new DomainService(repo,sessions,db),code='TCUS-DEMO-001',session='follow-up',date=(await repo.appointments(users.patient))[0].start_time.slice(0,10);
 await db.transaction(cx=>repo.execute(users.admin,'verify_payment',{appointment_code:code},cx,randomUUID()));
 const input=text=>({action:'sendMessage',chatInput:text,sessionId:session,requestId:randomUUID()});
 const turn=async(text,intent)=>{const request=input(text),grounding=await domain.grounding(users.patient,request);return domain.process(users.patient,request,intent||resolveConversation(text,grounding));};
 const request=async()=>{await db.transaction(cx=>repo.execute(users.patient,'reschedule',{appointment_code:code,date,time:'15:00'},cx,randomUUID()));return (await repo.changes(users.patient)).find(r=>r.status==='PENDING');};
 const reject=change=>db.transaction(cx=>repo.execute(users.admin,'reject_change',{request_id:change.id,rejection_category:'availability',public_reason:'El horario solicitado no está disponible. Puedes elegir otra fecha.'},cx,randomUUID()));
 const read=(id)=>turn(id?'Consultar solicitud '+id:'Consultar estado de mi solicitud',{intent:'request_status',...(id?{request_id:id}:{})});
 return {db,repo,domain,users,code,date,input,turn,request,reject,read,close:()=>db.close()};
}
test('seguimiento rechazado ofrece opciones de la cita actual y ninguna consulta escribe cambios',async()=>{
 const f=await fixture();try{const change=await f.request();await f.reject(change);await f.db.query('UPDATE telecus_demo_appointments SET start_time=$1,end_time=$2 WHERE code=$3',[f.date+'T20:00:00.000Z',f.date+'T20:30:00.000Z',f.code]);const before=await f.db.query('SELECT * FROM telecus_demo_appointments'),audits=await f.db.query('SELECT * FROM telecus_audit');
 const result=await f.read();assert.match(result.reply,/no fue aprobada/);assert.match(result.reply,/3:00 p/);assert.doesNotMatch(result.reply,/Historial ·|Esta solicitud no se aplicó/);assert.deepEqual(result.choices.map(c=>c.label),['Buscar otro horario','Solicitar cancelación','Ver mi cita']);assert.equal(result.proposal,undefined);assert.equal(result.handoff,undefined);assert.deepEqual(await f.db.query('SELECT * FROM telecus_demo_appointments'),before);assert.deepEqual(await f.db.query('SELECT * FROM telecus_audit'),audits);
 const view=await f.turn(result.choices[2].value);assert.match(view.reply,/TCUS-DEMO-001/);assert.equal(view.proposal,undefined);
 const again=await f.read(),started=await f.turn(again.choices[0].value);assert.match(started.reply,/lunes|fecha/);assert.equal(started.proposal,undefined);const state=await f.domain.state(f.users.patient,'follow-up');assert.equal(state.draft.intent,'reschedule');assert.equal(state.draft.appointment_code,f.code);
 }finally{await f.close();}
});
test('una cancelación ofrecida prepara revisión y requiere confirmación explícita',async()=>{
 const f=await fixture();try{const change=await f.request();await f.reject(change);const follow=await f.read(),review=await f.turn(follow.choices.find(c=>c.label==='Solicitar cancelación').value);assert.equal(review.proposal.kind,'cancel');assert.equal((await f.repo.changes(f.users.patient)).filter(c=>c.status==='PENDING').length,0);assert.equal((await f.repo.appointments(f.users.patient))[0].status,'CONFIRMED');
 await f.domain.process(f.users.patient,{...f.input(''),action:'confirm',proposalId:review.proposal.id},null);assert.equal((await f.repo.changes(f.users.patient)).filter(c=>c.status==='PENDING').length,1);assert.equal((await f.repo.appointments(f.users.patient))[0].status,'CONFIRMED');
 }finally{await f.close();}
});
test('buscar otro horario desde el resultado empieza una gestión nueva y no reutiliza un borrador anterior',async()=>{
 const f=await fixture();try{const change=await f.request();await f.reject(change);await f.domain.process(f.users.patient,f.input('Preparar otra fecha'),{intent:'reschedule',date:f.date});const follow=await f.read();await f.turn(follow.choices.find(c=>c.label==='Buscar otro horario').value);const state=await f.domain.state(f.users.patient,'follow-up');assert.equal(state.draft.intent,'reschedule');assert.equal(state.draft.appointment_code,f.code);assert.equal(state.draft.date,undefined);assert.equal(state.proposal,undefined);
 }finally{await f.close();}
});
test('una solicitud posterior pendiente prevalece sobre el rechazo anterior y evita duplicaciones',async()=>{
 const f=await fixture();try{const old=await f.request();await f.reject(old);await f.read(old.id);const pending=await f.request(),latest=await f.read();assert.match(latest.reply,/pendiente de revisión administrativa/);assert.deepEqual(latest.choices.map(c=>c.label),['Ver mi cita']);const explicit=await f.read(old.id);assert.match(explicit.reply,/solicitud posterior pendiente/);const next=explicit.choices.find(c=>c.label==='Ver solicitud pendiente');assert.ok(next);assert.ok(next.value.includes(pending.id));const detail=await f.turn(next.value);assert.match(detail.reply,/pendiente de revisión/);assert.ok(!detail.choices.some(c=>/cancelación|otro horario/.test(c.label)));
 }finally{await f.close();}
});
test('historial explícito conserva su lista y una cita cancelada permite iniciar una reserva nueva',async()=>{
 const f=await fixture();try{const change=await f.request();await f.reject(change);const history=await f.turn('Ver historial de solicitudes');assert.match(history.reply,/Historial ·/);assert.equal(history.choices,undefined);await f.db.transaction(cx=>f.repo.execute(f.users.admin,'cancel',{appointment_code:f.code},cx,randomUUID()));const follow=await f.read(change.id);assert.match(follow.reply,/Cancelada/);assert.ok(follow.choices.some(c=>c.label==='Solicitar una cita'));assert.ok(!follow.choices.some(c=>/otro horario|cancelación/.test(c.label)));const start=await f.turn(follow.choices[0].value);assert.match(start.reply,/médico|tipo de atención/);assert.equal(start.proposal,undefined);
 }finally{await f.close();}
});
test('una gestión en proceso no ofrece otro cambio ni filtra solicitudes de otros pacientes',async()=>{
 const f=await fixture();try{const change=await f.request();await f.reject(change);f.repo.pendingDeliveries=async()=>[{code:f.code,operation:'reschedule',stage:'calendar',status:'running'}];const follow=await f.read();assert.match(follow.reply,/gestión de esta cita en proceso/);assert.deepEqual(follow.choices.map(c=>c.label),['Ver mi cita']);const hidden=await f.domain.process(f.users.otherPatient,f.input('Consultar estado de mi solicitud'),{intent:'request_status',request_id:change.id});assert.doesNotMatch(hidden.reply,/TCUS-DEMO-001/);assert.equal(hidden.choices,undefined);
 }finally{await f.close();}
});
test('la política no infiere recencia sin fechas ni publica motivos o notas internas',async()=>{
 const {focusedPatientRequest,patientRequestFollowUp}=await import('../apps/backend/dist/application/request-follow-up.js'),appointment={id:'a',code:'TCUS-PRUEBA-01',status:'CONFIRMED',start_time:'2099-10-25T20:00:00Z',end_time:'2099-10-25T20:30:00Z'},record={id:'r',appointment_id:'a',appointment_code:appointment.code,status:'REJECTED',request_type:'RESCHEDULE',reason:'DATO_PRIVADO',decision_note:'NOTA_INTERNA'};
 assert.equal(focusedPatientRequest([record,{...record,id:'another'}],[appointment]),undefined);assert.equal(focusedPatientRequest([record],[appointment],{id:'foreign'}),undefined);const follow=patientRequestFollowUp(record,appointment,[record],[appointment],[]);assert.doesNotMatch(follow.text,/DATO_PRIVADO|NOTA_INTERNA/);const missing=patientRequestFollowUp(record,undefined,[record],[],[]);assert.deepEqual(missing.choices.map(c=>c.intent),['list_appointments']);
});
