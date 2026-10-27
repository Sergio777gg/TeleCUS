require('reflect-metadata');
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function fixture(){
 const [{Database},{Repository,demoIds},{DatabaseNotificationInbox},{NotificationsService}]=await Promise.all(['database','repository','adapters/notification-inbox','notifications'].map(n=>import('../apps/backend/dist/'+n+'.js')));
 const db=new Database('',':memory:');await db.initialize();const repo=new Repository(db,{mode:'demo'});await repo.seed();const users={};for(const [name,id]of Object.entries(demoIds))users[name]={...(await db.query('SELECT * FROM telecus_demo_profiles WHERE id=$1',[id]))[0],active:true};
 for(const [who,count]of [[users.patient,32],[users.otherPatient,2]])for(let i=0;i<count;i++)await db.query('INSERT INTO telecus_notifications(event_key,event_type,payload_json,recipient_id,recipient_role,created_at,read_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),'appointment_confirmed',JSON.stringify({code:'TCUS-PRUEBA-1'}),who.id,who.role,new Date().toISOString(),i<30?new Date().toISOString():null]);
 return {db,users,service:new NotificationsService(new DatabaseNotificationInbox(db)),close:()=>db.close()};
}
test('limpieza de leídas cubre todas las páginas, conserva auditoría y permite deshacer sin duplicar',async()=>{
 const f=await fixture();try{
  const user=f.users.patient,before=await f.service.list(user),batchId=randomUUID(),original=await f.db.query('SELECT * FROM telecus_notifications'),appointments=await f.db.query('SELECT * FROM telecus_demo_appointments');assert.equal(before.items.length,20);assert.equal(before.read_count,30);assert.equal(before.unread,2);
  assert.equal((await f.service.remove(user,{batchId,read:true})).removed,30);assert.equal((await f.service.remove(user,{batchId,read:true})).removed,30);
  const after=await f.service.list(user);assert.equal(after.items.length,2);assert.equal(after.unread,2);assert.equal(after.read_count,0);assert.equal((await f.service.list(f.users.otherPatient)).items.length,2);
  await assert.rejects(f.service.restore(f.users.otherPatient,{batchId}),e=>e.getStatus()===403);await assert.rejects(f.service.remove(user,{batchId,ids:[after.items[0].id]}),e=>e.getStatus()===409);
  assert.equal((await f.service.restore(user,{batchId})).restored,30);assert.equal((await f.service.restore(user,{batchId})).restored,0);
  assert.equal((await f.service.remove(user,{batchId,read:true})).removed,30);assert.equal((await f.service.list(user)).read_count,30); // replay must not delete again after undo
  assert.deepEqual(await f.db.query('SELECT * FROM telecus_notifications'),original);assert.deepEqual(await f.db.query('SELECT * FROM telecus_demo_appointments'),appointments);
 }finally{await f.close();}
});
test('eliminación individual valida propietario, rol vigente y entradas; no consume inferencia',async()=>{
 const f=await fixture();try{
  const user=f.users.patient,own=(await f.service.list(user)).items[0],foreign=(await f.service.list(f.users.otherPatient)).items[0],batchId=randomUUID();
  assert.equal((await f.service.remove(user,{batchId,ids:[foreign.id,own.id,own.id]})).removed,1);assert.equal((await f.service.list(user)).unread,1);assert.equal((await f.service.list(f.users.otherPatient)).items.length,2);
  assert.equal((await f.service.restore(user,{batchId})).restored,1);
  for(const body of [{batchId:'invalid'},{batchId:randomUUID(),read:true,ids:[own.id]},{batchId:randomUUID(),ids:['1 OR 1=1']},{batchId:randomUUID(),ids:Array(51).fill('1')}])await assert.rejects(f.service.remove(user,body),e=>e.getStatus()===400);
  await f.db.query('UPDATE telecus_demo_profiles SET active=0 WHERE id=$1',[user.id]);await assert.rejects(f.service.remove(user,{batchId:randomUUID(),ids:[own.id]}),e=>e.getStatus()===403);await assert.rejects(f.service.restore(user,{batchId}),e=>e.getStatus()===403);
  assert.equal((await f.db.query('SELECT count(*) AS n FROM telecus_jobs'))[0].n,0);
 }finally{await f.close();}
});
test('HTTP autentica eliminar y deshacer y conserva el alcance de cada cuenta',async()=>{
 const f=await fixture();const [{NestFactory},{ApiModule},{AuthService}]=await Promise.all([import('@nestjs/core'),import('../apps/backend/dist/http/app.module.js'),import('../apps/backend/dist/auth.js')]);
 const identity=new AuthService(f.db,{mode:'demo',demoSecret:'synthetic-cleanup-http-only'.repeat(3)}),app=await NestFactory.create(ApiModule.register({identity,notifications:f.service,chat:{enqueue:async()=>{throw Error('No inference');},get:async()=>({})},deliveries:{list:async()=>[]},system:{configuration:()=>({mode:'demo'}),health:async()=>({status:'ok'})}}),{logger:false});
 try{await app.listen(0,'127.0.0.1');const base=await app.getUrl(),batchId=randomUUID();
  for(const route of ['remove','restore'])assert.equal((await fetch(base+'/api/notifications/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({batchId,read:true})})).status,401);
  const patient=(await identity.demoLogin('PATIENT')).token,admin=(await identity.demoLogin('ADMIN')).token,send=(token,route,body)=>fetch(base+'/api/notifications/'+route,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const removed=await send(patient,'remove',{batchId,read:true});assert.equal(removed.status,200);assert.equal((await removed.json()).removed,30);
  assert.equal((await send(admin,'restore',{batchId})).status,403);assert.equal((await send(patient,'restore',{batchId})).status,200);
 }finally{await app.close();await f.close();}
});
test('el adaptador real transmite solo la explicación pública y los campos de la operación',async()=>{
 const {PostgresAgenda}=await import('../apps/backend/dist/integrations/agenda.js'),agenda=Object.create(PostgresAgenda.prototype);let captured;
 agenda.call=async(name,args)=>{captured={name,args};return 'ok';};const actor={id:randomUUID(),role:'ADMIN',active:true},id=randomUUID(),reason='El horario solicitado no está disponible. Puedes elegir otra fecha.';
 await agenda.execute(actor,id,'reject_change',{request_id:'request',rejection_category:'availability',public_reason:reason,expected_snapshot:['version'],decision_note:'NOTA_INTERNA',token:'NO_TRANSMITIR'});
 assert.equal(captured.name,'execute');assert.deepEqual(JSON.parse(captured.args[3]),{request_id:'request',expected_snapshot:['version'],rejection_category:'availability',public_reason:reason});
});
