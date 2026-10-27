const {test}=require('node:test'),assert=require('node:assert/strict');
const modules=import('../apps/frontend/src/visiblePolling.js');
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function platform(){
 let now=0,next=0;const timers=new Map(),listeners=new Map();
 const target=name=>({addEventListener:(event,fn)=>listeners.set(name+event,fn),removeEventListener:(event,fn)=>{if(listeners.get(name+event)===fn)listeners.delete(name+event);}});
 const document={...target('document'),visibilityState:'visible'};
 const env={document,window:target('window'),Date:{now:()=>now},Math:{random:()=>0},setTimeout:(fn,delay)=>{const id=++next;timers.set(id,{fn,at:now+delay,delay});return id;},clearTimeout:id=>timers.delete(id)};
 return {env,timers,listeners,async advance(ms){now+=ms;const ready=[...timers].filter(([,t])=>t.at<=now);for(const [id,t]of ready){timers.delete(id);void t.fn();}await flush();},event(type){listeners.get(type)?.();},hidden(){document.visibilityState='hidden';listeners.get('documentvisibilitychange')?.();},visible(){document.visibilityState='visible';listeners.get('documentvisibilitychange')?.();}};
}
test('sondeo secuencial: una respuesta lenta y varios eventos de foco no duplican la lectura',async()=>{
 const {startVisiblePolling}=await modules,p=platform();let calls=0,release;
 const stop=startVisiblePolling({intervalMs:15000,task:()=>{calls++;return new Promise(r=>release=r);}},p.env);
 assert.equal(calls,1);assert.equal(p.timers.size,0);p.event('windowfocus');p.visible();await p.advance(60000);assert.equal(calls,1);
 release(true);await flush();assert.equal(p.timers.size,1);await p.advance(15000);assert.equal(calls,2);stop();release(true);await flush();assert.equal(p.timers.size,0);assert.equal(p.listeners.size,0);
});
test('una pestaña oculta no mantiene temporizadores y al volver recupera una sola consulta',async()=>{
 const {startVisiblePolling}=await modules,p=platform();let calls=0;
 const stop=startVisiblePolling({intervalMs:15000,task:async()=>{calls++;}},p.env);await flush();p.hidden();assert.equal(p.timers.size,0);await p.advance(60000);assert.equal(calls,1);
 p.visible();p.event('windowfocus');await flush();assert.equal(calls,2);assert.equal(p.timers.size,1);stop();
});
test('los fallos espacian consultas hasta dos minutos y el éxito restaura el intervalo',async()=>{
 const {startVisiblePolling}=await modules,p=platform();let ok=false;
 const stop=startVisiblePolling({intervalMs:15000,task:async()=>ok},p.env);await flush();
 for(const expected of [30000,60000,120000,120000]){const timer=[...p.timers.values()][0];assert.equal(timer.delay,expected);await p.advance(expected);}
 ok=true;await p.advance(120000);assert.equal([...p.timers.values()][0].delay,15000);stop();
});
test('un comando o revisión puede pausar lecturas sin eliminar el ciclo ni ejecutar operaciones',async()=>{
 const {startVisiblePolling}=await modules,p=platform();let allowed=false,calls=0;
 const stop=startVisiblePolling({intervalMs:30000,immediate:false,canRun:()=>allowed,task:async()=>{calls++;}},p.env);
 await p.advance(30000);assert.equal(calls,0);allowed=true;await p.advance(30000);assert.equal(calls,1);stop();
});
test('la agenda solo consulta recursos consumidos por la sección y el rol activos',async()=>{
 const {workspaceReads}=await modules;
 assert.deepEqual(workspaceReads('ADMIN','summary'),{appointments:true,requests:false,doctors:false});
 assert.deepEqual(workspaceReads('ADMIN','appointments'),{appointments:true,requests:false,doctors:true});
 assert.deepEqual(workspaceReads('ADMIN','requests'),{appointments:false,requests:true,doctors:false});
 assert.deepEqual(workspaceReads('DOCTOR','appointments'),{appointments:true,requests:false,doctors:false});
 for(const section of ['settings','schedule','payments','knowledge','people','registrations','usage','information'])assert.deepEqual(workspaceReads('ADMIN',section),{appointments:false,requests:false,doctors:false});
});
