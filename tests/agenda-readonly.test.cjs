const {test}=require('node:test'),assert=require('node:assert/strict');

async function fixture(readOnly,failAt,rollbackFails=false){
 const {PostgresAgenda}=await import('../apps/backend/dist/integrations/agenda.js');
 const agenda=Object.create(PostgresAgenda.prototype),events=[];
 agenda.readOnly=readOnly;
 const client={
  async query(sql,args){
   events.push({sql,args});
   if(sql===failAt)throw Object.assign(new Error('private database details'),{code:'25006'});
   if(sql==='ROLLBACK'&&rollbackFails)throw new Error('Connection lost');
   return {rows:[{result:1}]};
  },
  release(discard){events.push({release:true,discard});},
 };
 agenda.pool={
  async connect(){events.push({connect:true});return client;},
  async query(sql,args){events.push({direct:true,sql,args});return {rows:[{result:1}]};},
 };
 return {agenda,events};
}

test('solo lectura encierra consultas en una transacci�n en la misma conexi�n',async()=>{
 const {agenda,events}=await fixture(true);
 assert.equal(await agenda.call('version'),1);
 assert.deepEqual(events.map(e=>e.sql||Object.keys(e)[0]),['connect','BEGIN READ ONLY','SELECT telecus_integration.version() AS result','COMMIT','release']);
 assert.equal(events.at(-1).discard,false);
});

test('un intento de marcar notificaciones queda bloqueado y revierte sin filtrar SQL',async()=>{
 const sql='SELECT telecus_integration.read_notifications($1,$2) AS result';
 const {agenda,events}=await fixture(true,sql);
 await assert.rejects(agenda.call('read_notifications',['actor','[]']),error=>{
  assert.equal(error.getStatus(),403);
  assert.equal(error.message,'La conexi�n actual solo permite consultas.');
  return true;
 });
 assert.ok(events.some(e=>e.sql==='ROLLBACK'));
 assert.ok(!events.some(e=>e.sql==='COMMIT'));
 assert.equal(events.at(-1).discard,false);
});

test('si falla BEGIN no se ejecuta la funci�n; si falla ROLLBACK se descarta la conexi�n',async()=>{
 const {agenda,events}=await fixture(true,'BEGIN READ ONLY',true);
 await assert.rejects(agenda.call('version'));
 assert.ok(!events.some(e=>e.sql?.startsWith('SELECT')));
 assert.equal(events.at(-1).discard,true);
});

test('el modo operativo conserva la consulta directa sin imponer solo lectura',async()=>{
 const {agenda,events}=await fixture(false);
 assert.equal(await agenda.call('version'),1);
 assert.equal(events.length,1);
 assert.equal(events[0].direct,true);
});
