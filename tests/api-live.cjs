// Explicitly invoked: uses an isolated demo API and the installed local model.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..');process.chdir(root);process.loadEnvFile('.env');
const temporary=fs.mkdtempSync(path.join(root,'data','test-api-')),port=5175,base='http://127.0.0.1:'+port;
const fd=fs.openSync(path.join(temporary,'api.log'),'w');
const child=spawn(process.execPath,[path.join(root,'apps/backend/dist/main.js')],{cwd:root,windowsHide:true,stdio:['ignore',fd,fd],env:{...process.env,DATA_MODE:'demo',API_PORT:String(port),API_HOST:'127.0.0.1',APP_ORIGIN:base,SQLITE_FILE:path.join(temporary,'demo.sqlite'),DATABASE_URL:'',RUN_WORKER:'true'}});fs.closeSync(fd);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function request(url,token,body){const r=await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});const result=await r.json();return {status:r.status,result};}
async function run(token,text,sessionId=randomUUID(),action='sendMessage',proposalId){const input={chatInput:text,sessionId,requestId:randomUUID(),action,...(proposalId?{proposalId}:{})};const job=await request('/api/chat/jobs',token,input);assert.equal(job.status,202);const repeated=await request('/api/chat/jobs',token,input);assert.equal(repeated.result.id,job.result.id);const started=Date.now();while(Date.now()-started<150000){const {result}=await request('/api/chat/jobs/'+job.result.id,token);if(result.status==='done')return {reply:result.result,sessionId,jobId:job.result.id};if(result.status==='failed')throw Error(result.error);await sleep(300);}throw Error('Tiempo de prueba agotado.');}
async function main(){
 for(let i=0;i<80;i++){try{const h=await request('/api/healthz');if(h.status===200)break;}catch{}await sleep(250);if(i===79)throw Error('No pudo iniciarse la API de prueba.');}
 assert.equal((await request('/api/me')).status,401);
 assert.equal((await request('/api/notifications')).status,401);
 const patient=(await request('/api/auth/demo',null,{role:'PATIENT'})).result.token,admin=(await request('/api/auth/demo',null,{role:'ADMIN'})).result.token;
 const menu=await run(patient,'',randomUUID(),'roleOverview');assert.match(menu.reply.reply,/Solicitar una cita/);assert.equal((await request('/api/chat/jobs/'+menu.jobId,admin)).status,404);
 const list=await run(patient,'Ver mis citas');assert.match(list.reply.reply,/TCUS-DEMO-001/);
 const availabilityMenu=await run(patient,'',randomUUID(),'roleOverview');
 const availabilityStart=await run(patient,'2',availabilityMenu.sessionId);assert.match(availabilityStart.reply.reply,/Elige un médico/);
 const availabilityDoctorOption=availabilityStart.reply.reply.match(/^(\d+)\. Dr\. Carlos Pérez$/m);assert.ok(availabilityDoctorOption);
 const availabilityDoctor=await run(patient,availabilityDoctorOption[1],availabilityMenu.sessionId);assert.match(availabilityDoctor.reply.reply,/fecha/);
 const outsideHours=await run(patient,'4:30 pm',availabilityMenu.sessionId);assert.match(outsideHours.reply.reply,/fuera de la jornada/);
 const timeOnly=await run(patient,'2:30',availabilityMenu.sessionId);assert.match(timeOnly.reply.reply,/Tengo la hora: 2:30 p\. m\./);assert.match(timeOnly.reply.reply,/Me falta la fecha/);
 const repeatedTime=await run(patient,'Para las 2:30pm',availabilityMenu.sessionId);assert.match(repeatedTime.reply.reply,/Tengo la hora: 2:30 p\. m\./);
 const datedAvailability=await run(patient,'El próximo lunes',availabilityMenu.sessionId);assert.match(datedAvailability.reply.reply,/2:30 p\. m\. está disponible/);assert.equal(datedAvailability.reply.proposal,undefined);
 for(const correction of ['perdón 3','Me equivoqué, quería la opción 3 del menú']){
  const navigation=await run(patient,'',randomUUID(),'roleOverview');await run(patient,'2',navigation.sessionId);
  const corrected=await run(patient,correction,navigation.sessionId);assert.match(corrected.reply.reply,/TCUS-DEMO-001/);assert.equal(corrected.reply.proposal,undefined);
 }
 const cancellation=await run(patient,'Cancelar mi cita TCUS-DEMO-001');assert.equal(cancellation.reply.proposal.kind,'cancel');
 const cancelled=await run(patient,'',cancellation.sessionId,'confirm',cancellation.reply.proposal.id);assert.match(cancelled.reply.reply,/Operación completada/);
 const future=new Date();future.setUTCDate(future.getUTCDate()+((8-future.getUTCDay())%7||7));const date=future.toISOString().slice(0,10);
 const short=await run(patient,'Quiero solicitar una cita');assert.match(short.reply.reply,/Elige un médico/);assert.equal(short.reply.proposal,undefined);
 const freshMenu=await run(patient,'',randomUUID(),'roleOverview');
 const begin=await run(patient,'1',freshMenu.sessionId);assert.match(begin.reply.reply,/Elige un médico/);assert.equal(begin.reply.proposal,undefined);
 const doctorOption=begin.reply.reply.match(/^(\d+)\. Dr\. Carlos Pérez$/m);assert.ok(doctorOption);
 const doctor=await run(patient,doctorOption[1],freshMenu.sessionId);assert.match(doctor.reply.reply,/fecha/);assert.equal(doctor.reply.proposal,undefined);
 let reserve=await run(patient,'El '+date+' a las 15:00 para consulta general',freshMenu.sessionId);assert.equal(reserve.reply.proposal.kind,'reserve');assert.match(reserve.reply.proposal.summary,/Carlos Pérez/);
 for(const reason of ['Dolor de estómago','Tengo dolor de estómago','Consulta de seguimiento']){
  const menu=await run(patient,'',randomUUID(),'roleOverview');await run(patient,'1',menu.sessionId);await run(patient,doctorOption[1],menu.sessionId);
  const combined=await run(patient,'El prox lúnes a las 3pm',menu.sessionId);assert.match(combined.reply.reply,/motivo general/);assert.equal(combined.reply.proposal,undefined);
  const greeting=await run(patient,'Hola',menu.sessionId);assert.match(greeting.reply.reply,/¡Hola!/);assert.match(greeting.reply.reply,/Conservo|motivo general|continuar/i);
  reserve=await run(patient,reason,menu.sessionId);assert.equal(reserve.reply.proposal.kind,'reserve');assert.match(reserve.reply.proposal.summary,new RegExp(reason.replace(/^Tengo /,'').replace(/^Dolor /,'dolor '),'i'));
 }
 const reserved=await run(patient,'',reserve.sessionId,'confirm',reserve.reply.proposal.id);assert.match(reserved.reply.reply,/Pre-reserva TCUS-/);
 assert.equal((await request('/api/chat/jobs',admin,{chatInput:'Pagos',sessionId:randomUUID(),requestId:randomUUID(),action:'sendMessage'})).status,403);
 const agenda=(await request('/api/workspace/appointments',admin)).result;assert.ok(agenda.counts.awaiting_receipt>0);
 const code=reserved.reply.reply.match(/Pre-reserva (TCUS-[A-Z0-9-]+)/)[1],pendingPayment=(await request('/api/admin/payments?view=awaiting',admin)).result.items.find(a=>a.code===code);assert.ok(pendingPayment);
 const proof=new FormData();proof.append('file',new Blob([fs.readFileSync('tests/fixtures/comprobante-ficticio.pdf')],{type:'application/pdf'}),'comprobante-ficticio.pdf');assert.equal((await fetch(base+'/api/payments/'+pendingPayment.appointment_id+'/receipt',{method:'POST',headers:{Authorization:'Bearer '+patient,'Idempotency-Key':randomUUID()},body:proof})).status,200);
 assert.ok((await request('/api/admin/payments',admin)).result.items.some(a=>a.code===code));
 const review=(await request('/api/admin/payments/'+pendingPayment.appointment_id+'/review',admin,{requestId:randomUUID()})).result;assert.ok(review.id);
 assert.equal((await request('/api/admin/payment-reviews/'+review.id+'/confirm',admin,{verified:true})).status,200);
 const changeStart=await run(patient,'Reprogramar mi cita');assert.match(changeStart.reply.reply,/lunes/);
 const relative=await run(patient,'El lunes siguiente',changeStart.sessionId);assert.match(relative.reply.reply,/hora/);
 const newTime=await run(patient,'2pm',changeStart.sessionId);assert.equal(newTime.reply.proposal.kind,'reschedule');assert.match(newTime.reply.reply,/revisión administrativa/);assert.match(newTime.reply.proposal.summary,/Solicitar reprogramación/);
 const information=await run(patient,'Información de TeleCUS',changeStart.sessionId);assert.match(information.reply.reply,/Fuentes:/);assert.doesNotMatch(information.reply.reply,/ID:|\.md:\d+/);assert.equal(information.reply.proposal.id,newTime.reply.proposal.id);
 await run(patient,'',changeStart.sessionId,'confirm',newTime.reply.proposal.id);
 const pending=await run(patient,'Quiero ver el estado de mi solicitud',changeStart.sessionId);assert.match(pending.reply.reply,/Pendiente de revisión/);assert.match(pending.reply.reply,/Horario solicitado/);assert.doesNotMatch(pending.reply.reply,/Fuentes:|iniciar sesión|ID:/);
 const requests=(await request('/api/workspace/requests',admin)).result;const change=requests.items.find(c=>c.appointment_code===code);assert.ok(change);assert.ok(change.requested_start_time);
 const approval=(await request('/api/workspace/reviews',admin,{kind:'approve_change',request_id:change.id,requestId:randomUUID()})).result;assert.ok(approval.token);
 assert.equal((await request('/api/workspace/actions',admin,{token:approval.token,confirmed:true})).status,200);
 assert.equal((await request('/api/workspace/requests',admin)).result.items.some(r=>r.id===change.id),false);
 const history=(await request('/api/workspace/requests?view=history',admin)).result;assert.equal(history.items.find(r=>r.id===change.id).status,'APPROVED');
 const reviewed=await run(patient,'¿Ya aprobaron mi cambio?',changeStart.sessionId);assert.match(reviewed.reply.reply,/Aprobada/);assert.doesNotMatch(reviewed.reply.reply,/Fuentes:|ID:/);
 const updated=await run(patient,'Ver mis citas');assert.match(updated.reply.reply,/Reprogramada/);
 const current=await run(patient,'Qué pasó con mi cita?');assert.match(current.reply.reply,/Estado: Reprogramada/);assert.doesNotMatch(current.reply.reply,/Fuentes:/);
 const doctorToken=(await request('/api/auth/demo',null,{role:'DOCTOR'})).result.token;
 assert.equal((await request('/api/notifications?limit=10000',patient)).status,400);
 const inbox=(await request('/api/notifications',patient)).result;assert.ok(inbox.unread>0);assert.ok(inbox.items.some(n=>/Pago verificado/.test(n.title)));assert.ok(inbox.items.some(n=>/Solicitud aprobada/.test(n.title)));assert.doesNotMatch(JSON.stringify(inbox),/Dolor de estómago|Tengo dolor|example\.test/);
 assert.equal((await request('/api/notifications/read',admin,{ids:[inbox.items[0].id]})).result.updated,0);
 assert.equal((await request('/api/notifications/read',patient,{ids:[inbox.items[0].id]})).result.updated,1);
 const again=(await request('/api/notifications',patient)).result;assert.equal(again.unread,inbox.unread-1);assert.ok(again.items[0].read_at);
 const small=(await request('/api/notifications?limit=2',patient)).result,older=(await request('/api/notifications?limit=2&before='+small.next_cursor,patient)).result;assert.equal(small.items.some(n=>older.items.some(m=>m.id===n.id)),false);
 assert.equal((await request('/api/notifications',doctorToken)).result.items.length,0); // Carlos was assigned, not Ana (demo login).
 console.log('API + Node-RED + modelo local: conversación contextual, motivos naturales, fecha y hora juntas, panel administrativo directo sin inferencia, solicitudes y estados, notificaciones por rol, lectura y paginación aprobadas. Solo citas ficticias; sin Calendar ni correos reales.');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{child.kill();});
