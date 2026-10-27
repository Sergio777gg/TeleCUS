const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

// Executes the actual hook with controlled transport and React-style state/effect dependencies.
// No DOM snapshots, real accounts, database or integration calls.
function mount(file,name,props,request){
 const slots=[],pollers=[];let index=0,dirty=false,effects=[],output;
 const changed=(a,b)=>!a||a.length!==b.length||a.some((v,i)=>!Object.is(v,b[i]));
 const useRef=value=>{const i=index++;return slots[i]||(slots[i]={current:value});};
 const useState=initial=>{const i=index++;if(!slots[i])slots[i]={value:typeof initial==='function'?initial():initial};return [slots[i].value,value=>{const next=typeof value==='function'?value(slots[i].value):value;if(!Object.is(next,slots[i].value)){slots[i].value=next;dirty=true;}}];};
 const useCallback=(fn,deps)=>{const i=index++;if(!slots[i]||changed(slots[i].deps,deps))slots[i]={deps,fn};return slots[i].fn;};
 const useEffect=(fn,deps)=>{const i=index++;if(!slots[i]||changed(slots[i].deps,deps)){const prior=slots[i];slots[i]={deps,cleanup:prior?.cleanup};effects.push(()=>{prior?.cleanup?.();slots[i].cleanup=fn();});}};
 const source=fs.readFileSync('apps/frontend/src/'+file,'utf8').replace(/^import .*?;\r?\n/gm,'').replace('export function '+name,'function '+name);
 const workspaceReads=(role,section)=>({appointments:['summary','appointments'].includes(section),requests:role==='ADMIN'&&section==='requests',doctors:role==='ADMIN'&&['appointments','availability'].includes(section)});
 const hook=vm.runInNewContext(source+'\n'+name,{useRef,useState,useCallback,useEffect,request,workspaceReads,AbortController,URLSearchParams,Date,crypto:require('node:crypto').webcrypto,startVisiblePolling:options=>{const p={options,closed:false};pollers.push(p);return()=>p.closed=true;}});
 function render(){index=0;dirty=false;output=hook(props);const jobs=effects;effects=[];for(const fn of jobs)fn();}
 async function settle(){for(let i=0;i<12;i++){await Promise.resolve();if(dirty)render();}}
 render();return {settle,get value(){return output;},poll:()=>pollers.findLast(p=>!p.closed).options.task(),unmount:()=>{for(const slot of slots)slot?.cleanup?.();}};
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const profile={id:'synthetic-staff',role:'ADMIN'},agenda={items:[{code:'TCUS-SYNTHETIC'}],counts:{active:1},next_offset:null};

test('dashboard: refresco automático silencioso, datos conservados ante fallo y carga visible manual',async()=>{
 let next,calls=0;const h=mount('useWorkspace.js','useWorkspace',{token:'synthetic',profile,mode:'demo',section:'summary'},async()=>{calls++;return next?next.promise:agenda;});
 await h.settle();assert.equal(h.value.loading,false);assert.equal(h.value.appointments.length,1);assert.equal(calls,1);assert.equal(h.value.refreshKey,0);
 next=deferred();const background=h.poll();await h.settle();assert.equal(h.value.loading,false);assert.equal(h.value.appointments[0].code,'TCUS-SYNTHETIC');
 await h.poll();assert.equal(calls,2);next.reject(Error('synthetic offline'));await background;await h.settle();assert.equal(h.value.appointments.length,1);assert.match(h.value.error,/última consulta/);assert.equal(h.value.refreshKey,0);
 next=deferred();const manual=h.value.refresh();await h.settle();assert.equal(h.value.loading,true);next.resolve(agenda);await manual;await h.settle();assert.equal(h.value.loading,false);assert.equal(h.value.error,'');h.unmount();
});
test('panel de pagos: refresco automático no borra la lista ni activa el indicador',async()=>{
 let next,calls=0;const data={items:[{code:'TCUS-SYNTHETIC',appointment_id:'synthetic'}]},h=mount('useAdministration.js','useAdministration',{token:'synthetic',profile,mode:'demo'},async()=>{calls++;return next?next.promise:data;});
 await h.settle();h.value.open();await h.settle();assert.equal(calls,1);assert.equal(h.value.loading,false);
 next=deferred();const background=h.poll();await h.settle();assert.equal(h.value.loading,false);assert.equal(h.value.data.items.length,1);await h.poll();assert.equal(calls,2);
 next.reject(Error('synthetic offline'));await background;await h.settle();assert.equal(h.value.data.items.length,1);assert.match(h.value.error,/última consulta/);
 next=deferred();const manual=h.value.load();await h.settle();assert.equal(h.value.loading,true);next.resolve(data);await manual;await h.settle();assert.equal(h.value.loading,false);h.unmount();
});

test('pagos del paciente: el fallo inicial se informa y un fallo posterior conserva lo recibido',async()=>{
 let next=deferred();const props={token:'synthetic',profile:{id:'synthetic-patient',role:'PATIENT'},mode:'demo',refreshKey:0,chatBusy:false};
 const h=mount('usePayments.js','usePayments',props,()=>next.promise);await h.settle();
 const initial=h.poll();next.reject(Error('synthetic offline'));await initial;await h.settle();assert.equal(h.value.loaded,true);assert.match(h.value.error,/consultar los pagos/);
 next=deferred();const recovery=h.poll();next.resolve({items:[{appointment_id:'synthetic',code:'TCUS-SYNTHETIC',can_upload:true,receipt:null}],receiptsAvailable:true});await recovery;await h.settle();assert.equal(h.value.items.length,1);assert.equal(h.value.error,'');
 next=deferred();const background=h.poll();next.reject(Error('synthetic offline'));await background;await h.settle();assert.equal(h.value.items[0].code,'TCUS-SYNTHETIC');assert.equal(h.value.loaded,true);assert.match(h.value.error,/consultar los pagos/);h.unmount();
});
