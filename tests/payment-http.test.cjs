require('reflect-metadata');
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const pdf=Buffer.from('%PDF-1.7\nPRUEBA SIN VALOR FINANCIERO\n%%EOF\n');

test('el cupo de archivos se conserva hasta terminar la respuesta y se libera al cerrar o abortar',async()=>{
 const {PaymentFileCapacity}=await import('../apps/backend/dist/http/payments.module.js'),{EventEmitter}=require('node:events'),{of}=require('rxjs'),gate=new PaymentFileCapacity();
 const context=id=>{const req=Object.assign(new EventEmitter(),{telecusProfile:{id,role:'ADMIN'},method:'GET'}),res=new EventEmitter();return {req,res,switchToHttp:()=>({getRequest:()=>req,getResponse:()=>res})};};
 const open=[];
 for(let i=0;i<4;i++){const cx=context('staff-'+i);open.push(cx);gate.intercept(cx,{handle:()=>of('stream')}).subscribe();}
 assert.throws(()=>gate.intercept(context('another'),{handle:()=>of('stream')}),e=>e.getStatus()===429);
 assert.throws(()=>gate.intercept(context('staff-0'),{handle:()=>of('stream')}),e=>e.getStatus()===429);
 open[0].res.emit('finish');const replacement=context('another');gate.intercept(replacement,{handle:()=>of('stream')}).subscribe();
 replacement.res.emit('close');replacement.req.emit('aborted');
 open[1].req.emit('aborted');open[2].res.emit('close');open[3].res.emit('finish');
 const freed=context('staff-0');gate.intercept(freed,{handle:()=>of('stream')}).subscribe();freed.res.emit('finish');
});
async function fixture(){
 const [{NestFactory},{Database},{Repository,demoIds},{AuthService},{ApiModule},{DatabasePaymentReceiptStore},{PaymentService}]=await Promise.all([import('@nestjs/core'),...['database','repository','auth','http/app.module','adapters/payment-receipts','application/payments'].map(p=>import('../apps/backend/dist/'+p+'.js'))]);
 const db=new Database('',':memory:');await db.initialize();await new Repository(db,{mode:'demo'}).seed();
 const auth=new AuthService(db,{mode:'demo',demoSecret:'payment-http-synthetic-key'.repeat(3)}),store=new DatabasePaymentReceiptStore(db);await store.initialize();
 const payments=new PaymentService(store),bindings={identity:auth,payments,chat:{enqueue:async()=>({}),get:async()=>({})},notifications:{list:async()=>({items:[],unread:0,next_cursor:null}),read:async()=>({updated:0})},deliveries:{list:async()=>[]},system:{configuration:()=>({mode:'demo'}),health:async()=>({status:'ok'})}};
 const app=await NestFactory.create(ApiModule.register(bindings),{logger:false});await app.listen(0,'127.0.0.1');
 const base=await app.getUrl(),tokens=Object.fromEntries(Object.entries(demoIds).map(([role,id])=>[role,auth.issueDemo(id)]));
 const request=(url,{user='patient',method='GET',body,requestId}={})=>fetch(base+url,{method,headers:{...(user?{Authorization:'Bearer '+tokens[user]}:{}),...(requestId?{'Idempotency-Key':requestId}:{})},...(body?{body}:{})});
 async function upload({user='patient',id='demo-appointment-1',data=pdf,type='application/pdf',name='recibo.pdf',requestId=randomUUID(),extra=false}={}){const form=new FormData();form.append('file',new Blob([data],{type}),name);if(extra)form.append('patient_id','another-user');return request('/api/payments/'+id+'/receipt',{user,method:'POST',body:form,requestId});}
 return {db,app,request,upload,tokens,close:async()=>{await app.close();await db.close();}};
}

test('HTTP: comprobante multipart privado, lectura autorizada, idempotencia y pago aún pendiente',async()=>{
 const f=await fixture();try{
  assert.equal((await f.request('/api/payments',{user:null})).status,401);
  assert.equal((await f.upload({user:null,extra:true})).status,401);
  assert.equal((await f.upload({user:'doctor'})).status,403);
  assert.equal((await f.upload({user:'admin'})).status,403);
  const requestId=randomUUID(),response=await f.upload({requestId}),receipt=await response.json();assert.equal(response.status,200,JSON.stringify(receipt));assert.ok(receipt.id);
  const repeat=await f.upload({requestId});assert.equal(repeat.status,200);assert.equal((await repeat.json()).id,receipt.id);
  const page=await (await f.request('/api/payments')).json();assert.equal(page.items[0].receipt.id,receipt.id);assert.equal(page.items[0].payment_status,'PENDING');assert.equal(page.items[0].status,'PRE_RESERVED');assert.equal(page.items[0].can_pay,false);
  assert.equal((await f.request('/api/payments/receipts/'+receipt.id,{user:'otherPatient'})).status,404);
  assert.equal((await f.request('/api/payments/receipts/'+receipt.id,{user:'doctor'})).status,403);
  const downloaded=await f.request('/api/payments/receipts/'+receipt.id,{user:'admin'});assert.equal(downloaded.status,200);assert.match(downloaded.headers.get('content-disposition'),/^attachment;/);assert.equal(downloaded.headers.get('content-type'),'application/octet-stream');assert.equal(downloaded.headers.get('cache-control'),'no-store');assert.equal(downloaded.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),pdf);
 }finally{await f.close();}
});

test('HTTP: rechaza archivos falsos, exceso de tamaño, campos adicionales y subidas sin cita propia',async()=>{
 const f=await fixture();try{
  assert.equal((await f.upload({data:Buffer.from('<html>no es un recibo</html>')})).status,400);
  assert.equal((await f.upload({data:Buffer.alloc(5*1024*1024+1)})).status,413);
  assert.equal((await f.upload({extra:true})).status,400);
  assert.equal((await f.upload({requestId:'invalid'})).status,400);
  assert.equal((await f.upload({user:'otherPatient'})).status,403);
  assert.equal((await f.db.query('SELECT id FROM telecus_demo_payment_receipts')).length,0);
 }finally{await f.close();}
});
