const {test}=require('node:test'),assert=require('node:assert/strict');
const {run,safeOrigin}=require('../scripts/start-ngrok.cjs');
function fixture(overrides={}){
 const calls=[],origin='https://example.ngrok-free.dev';
 const ops={startReal:()=>calls.push('real'),openTunnel:()=>{calls.push('tunnel');return{ready:Promise.resolve(origin),finished:Promise.resolve(0),stop:()=>calls.push('close')};},applyOrigin:url=>calls.push('origin:'+url),register:()=>calls.push('register'),openBrowser:url=>calls.push('browser:'+url),announce:()=>calls.push('announce'),unregister:()=>calls.push('unregister'),...overrides};return{calls,ops,origin};
}
test('inicio ngrok aplica el modo real y el origen exacto antes de abrir el navegador y cierra su sesión',async()=>{
 const f=fixture();await run(f.ops);assert.deepEqual(f.calls,['real','tunnel','origin:'+f.origin,'register','browser:'+f.origin,'announce','close','unregister']);
});
test('un fallo al aplicar el origen cierra el túnel y no abre el navegador',async()=>{
 const f=fixture({applyOrigin:()=>{throw Error('fallo');}});await assert.rejects(run(f.ops),/fallo/);assert.deepEqual(f.calls,['real','tunnel','close','unregister']);
});
test('si el inicio real falla no se publica ningún túnel',async()=>{
 const f=fixture({startReal:()=>{throw Error('fallo');}});await assert.rejects(run(f.ops),/fallo/);assert.deepEqual(f.calls,[]);
});
test('el origen del túnel no admite HTTP, credenciales, rutas ni argumentos',()=>{
 for(const value of ['http://example.test','https://user:secret@example.test','https://example.test/path','https://example.test/?token=secret','https://example.test/#state','https://example.test:8443'])assert.throws(()=>safeOrigin(value));
 assert.equal(safeOrigin('https://example.ngrok-free.dev/'),'https://example.ngrok-free.dev');
});
