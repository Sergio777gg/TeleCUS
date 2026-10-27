// Real HTTP/multipart/encrypted-file verification. Caller supplies disposable synthetic identities.
require('reflect-metadata');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
module.exports=async function verify({metadata,patient,otherPatient,doctor,admin,appointmentId}){
 const [{NestFactory},{UnauthorizedException,ServiceUnavailableException},{ApiModule},{ClinicalDocumentService},{LocalPaymentBlobStore}]=await Promise.all([import('@nestjs/core'),import('@nestjs/common'),...['http/app.module','application/clinical-documents','adapters/payment-files'].map(n=>import('../apps/backend/dist/'+n+'.js'))]);
 const testRoot=path.resolve(__dirname,'../tests'),directory=await fs.mkdtemp(path.join(testRoot,'telecus-clinical-http-')),disk=new LocalPaymentBlobStore(directory,'synthetic-document-encryption-verification-only'.repeat(2),'telecus/clinical-documents/v1');
 let failStorage=false,loseAcknowledgement=false,checks=0,storageFailure;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
 const wrappedMetadata={available:()=>true,initialize:async()=>{},dispatch:async(...args)=>{const result=await metadata.dispatch(...args);if(args[1]==='commit'&&loseAcknowledgement){loseAcknowledgement=false;throw new ServiceUnavailableException('Synthetic acknowledgement loss');}return result;}};
 const service=new ClinicalDocumentService(wrappedMetadata,{put:async(...args)=>{if(failStorage){failStorage=false;throw Error('Synthetic storage outage');}try{await disk.put(...args);}catch(e){storageFailure={code:e.code,message:e.message};throw e;}},get:key=>disk.get(key)});
 const users={patient,otherPatient,doctor,admin},identity={authenticate:async header=>{const actor=users[String(header||'').replace(/^Bearer synthetic-/,'')];if(!actor)throw new UnauthorizedException();return actor;},demoLogin:async()=>({})};
 const app=await NestFactory.create(ApiModule.register({identity,clinicalDocuments:service,chat:{enqueue:async()=>{throw Error('No inference');},get:async()=>({})},notifications:{list:async()=>({items:[],unread:0}),read:async()=>0},deliveries:{list:async()=>[]},system:{configuration:()=>({mode:'demo'}),health:async()=>({status:'ok'})}}),{logger:false});
 try{
  await app.listen(0,'127.0.0.1');const base=await app.getUrl(),bytes=await fs.readFile(path.resolve(__dirname,'../tests/fixtures/comprobante-ficticio.pdf'));
  const headers=role=>({Authorization:'Bearer synthetic-'+role});
  const upload=async(role,key=crypto.randomUUID(),data=bytes,appointment=appointmentId)=>{const form=new FormData();form.append('file',new Blob([data],{type:'application/pdf'}),'informe-ficticio.pdf');return fetch(base+'/api/clinical-documents/'+encodeURIComponent(appointment)+'/attachments',{method:'POST',headers:{...headers(role),'Idempotency-Key':key},body:form});};
  eq((await fetch(base+'/api/clinical-documents')).status,401);eq((await upload('doctor')).status,403);eq((await upload('admin')).status,403);eq((await upload('otherPatient')).status,403);
  const key=randomUUID();failStorage=true;const outage=await upload('patient',key);eq(outage.status,503);assert.match((await outage.json()).message,/almacenamiento privado/);checks++;
  const first=await upload('patient',key);const doc=await first.json();assert.equal(first.status,200,JSON.stringify({stage:'first upload',response:doc,storageFailure}));checks++;eq((await (await upload('patient',key)).json()).id,doc.id);
  const downloaded=await fetch(base+'/api/clinical-documents/files/'+doc.id,{headers:headers('doctor')});eq(downloaded.status,200);eq(downloaded.headers.get('cache-control'),'no-store');eq(Buffer.from(await downloaded.arrayBuffer()),bytes);
  for(const role of ['otherPatient','admin'])eq((await fetch(base+'/api/clinical-documents/files/'+doc.id,{headers:headers(role)})).status,403);
  eq((await upload('patient',randomUUID(),Buffer.alloc(5*1024*1024+1))).status,413);
  const uncertainKey=randomUUID();loseAcknowledgement=true;eq((await upload('patient',uncertainKey)).status,503);const recovered=await upload('patient',uncertainKey);eq(recovered.status,200);const second=await recovered.json();eq((await (await upload('patient',uncertainKey)).json()).id,second.id);
  const listed=await fetch(base+'/api/clinical-documents',{headers:headers('patient')}),page=await listed.json();assert.equal(listed.status,200,JSON.stringify({stage:'list documents',response:page}));checks++;eq(page.items.find(a=>a.id===appointmentId).documents.filter(d=>d.id===second.id).length,1);
  eq((await fetch(base+'/api/clinical-documents/files/'+doc.id+'/withdraw',{method:'POST',headers:{...headers('patient'),'Content-Type':'application/json'},body:'{}'})).status,200);eq((await fetch(base+'/api/clinical-documents/files/'+doc.id,{headers:headers('patient')})).status,409);
  eq((await upload('patient',randomUUID(),bytes,randomUUID())).status,403);
  return {checks,transport:'HTTP multipart',files:'encrypted temporary volume',googleCalls:0,inferenceCalls:0};
 }finally{
  await app.close();const resolved=await fs.realpath(directory),expected=await fs.realpath(testRoot);if(path.dirname(resolved).toLowerCase()!==expected.toLowerCase()||!path.basename(resolved).startsWith('telecus-clinical-http-'))throw Error('Unsafe temporary directory');await fs.rm(resolved,{recursive:true,force:true});
 }
};
