const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const modules=Promise.all([import('../apps/backend/dist/adapters/payment-files.js'),import('../apps/backend/dist/adapters/payment-receipts.js'),import('../apps/backend/dist/application/payments.js')]);
const digest=data=>createHash('sha256').update(data).digest('hex');
const pdf=Buffer.from('%PDF-1.7\nPRUEBA LOCAL SIN VALOR\n%%EOF\n');
async function fixture(){const [{LocalPaymentBlobStore}]=await modules,root=await fs.mkdtemp(path.join(__dirname,'telecus-receipt-test-'));return {root,store:new LocalPaymentBlobStore(root,'synthetic-file-key'.repeat(4)),close:async()=>{const actual=await fs.realpath(root),parent=await fs.realpath(__dirname);if(path.dirname(actual).toLowerCase()!==parent.toLowerCase()||!path.basename(actual).startsWith('telecus-receipt-test-'))throw Error('No se limpia un directorio fuera del temporal propio.');await fs.rm(actual,{recursive:true,force:true});}};}

test('archivos privados cifrados, escritura atómica, reintentos concurrentes e integridad',async()=>{
 const f=await fixture();try{
  const key=digest(Buffer.from('opaque-test-key'));await Promise.all([f.store.put(key,pdf,digest(pdf)),f.store.put(key,pdf,digest(pdf))]);
  assert.deepEqual(await f.store.get(key),pdf);
  const folder=path.join(f.root,key.slice(0,2)),file=path.join(folder,key,'content.enc'),encrypted=await fs.readFile(file);
  assert.equal(encrypted.includes(pdf),false);assert.deepEqual((await fs.readdir(folder)),[key]);
  const changed=Buffer.from('%PDF-1.7\nOTRO ARCHIVO\n%%EOF\n');await assert.rejects(f.store.put(key,changed,digest(changed)));assert.deepEqual(await f.store.get(key),pdf);
  const [{LocalPaymentBlobStore}]=await modules;await assert.rejects(new LocalPaymentBlobStore(f.root,'another-file-key'.repeat(4)).get(key));
  encrypted[encrypted.length-1]^=1;await fs.writeFile(file,encrypted);await assert.rejects(f.store.get(key));
 }finally{await f.close();}
});

test('rechaza rutas arbitrarias, contenido excesivo y hash incorrecto antes de registrar archivos',async()=>{
 const f=await fixture();try{
  for(const key of ['../escape','C:/escape','A'.repeat(64),'a'.repeat(63)])await assert.rejects(f.store.put(key,pdf,digest(pdf)));
  const key='a'.repeat(64);await assert.rejects(f.store.put(key,pdf,'0'.repeat(64)));await assert.rejects(f.store.put(key,Buffer.alloc(5*1024*1024+1),'0'.repeat(64)));
  assert.deepEqual(await fs.readdir(f.root),[]);
 }finally{await f.close();}
});

test('adaptador híbrido escribe archivo antes de metadatos y autoriza antes de descargar',async()=>{
 const [,{PostgresPaymentReceiptStore},{validatePaymentFile}]=await modules;
 const user={id:randomUUID(),role:'PATIENT',active:true},appointment=randomUUID(),request=randomUUID(),file=validatePaymentFile({file_name:'prueba.pdf',content_type:'application/pdf',data:pdf}),calls=[];
 let stored,receipt=null,deny=false;
 const agenda={call:async(name,args=[])=>{calls.push(name);if(name==='payment_receipts_version')return 1;if(name==='list_payment_receipts')return {receiptsAvailable:true,items:[{appointment_id:appointment,processing:false,can_upload:!receipt,receipt}]};if(name==='upload_payment_receipt'){const body=JSON.parse(args[3]);assert.equal(body.content_base64,undefined);assert.equal(body.storage_key,digest(Buffer.from(user.id+'\0'+appointment+'\0'+file.sha256)));stored=body;receipt={id:randomUUID(),file_name:body.file_name,content_type:body.content_type,size:body.size,created_at:new Date().toISOString()};return receipt;}if(name==='download_payment_receipt'){if(deny)throw Error('Access denied');return {...receipt,...stored};}}};
 const blobs={put:async()=>calls.push('file_put'),get:async()=>{calls.push('file_get');return pdf;}};
 const store=new PostgresPaymentReceiptStore(agenda,undefined,blobs);await store.initialize();
 const result=await store.upload(user,appointment,request,file);assert.ok(result.id);assert.ok(calls.indexOf('file_put')<calls.indexOf('upload_payment_receipt'));
 calls.length=0;assert.deepEqual((await store.download(user,result.id)).data,pdf);assert.deepEqual(calls,['download_payment_receipt','file_get']);
 calls.length=0;deny=true;await assert.rejects(store.download(user,result.id));assert.deepEqual(calls,['download_payment_receipt']);
});

test('fallo local no registra comprobante; un fallo de metadatos no borra un archivo quizá confirmado',async()=>{
 const [,{PostgresPaymentReceiptStore},{validatePaymentFile}]=await modules;
 const user={id:randomUUID(),role:'PATIENT'},appointment=randomUUID(),file=validatePaymentFile({file_name:'prueba.pdf',content_type:'application/pdf',data:pdf}),calls=[];
 const agenda={call:async(name)=>{calls.push(name);if(name==='payment_receipts_version')return 1;if(name==='list_payment_receipts')return {items:[{appointment_id:appointment,processing:false,receipt:null}]};if(name==='upload_payment_receipt')throw Error('Respuesta de base perdida');}};
 const failed=new PostgresPaymentReceiptStore(agenda,undefined,{put:async()=>{throw Error('private disk unavailable');},get:async()=>pdf});await failed.initialize();
 await assert.rejects(failed.upload(user,appointment,randomUUID(),file),e=>e.getStatus()===503);assert.equal(calls.includes('upload_payment_receipt'),false);
 let files=0;const uncertain=new PostgresPaymentReceiptStore(agenda,undefined,{put:async()=>{files++;},get:async()=>pdf});await uncertain.initialize();
 await assert.rejects(uncertain.upload(user,appointment,randomUUID(),file),/Respuesta de base perdida/);assert.equal(files,1);
});
