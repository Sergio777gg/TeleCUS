const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const modules=Promise.all([import('../apps/frontend/src/notificationPages.js'),import('../apps/frontend/src/api.js')]);
const items=(highest,lowest)=>Array.from({length:highest-lowest+1},(_,i)=>({id:String(highest-i),read_at:null}));
const page=(all,before=null)=>{
 const available=all.filter(item=>!before||BigInt(item.id)<BigInt(before));
 const result=available.slice(0,20);
 return {items:result,unread:all.length,next_cursor:available.length>20?result.at(-1).id:null};
};

test('una ráfaga de más de una página no oculta avisos intermedios del historial',async()=>{
 const [{mergeNotificationPage}]=await modules;
 const all=items(50,1),previous=page(items(20,1));
 let visible=mergeNotificationPage(previous,page(all));
 assert.equal(visible.next_cursor,'31');
 while(visible.next_cursor){const cursor=visible.next_cursor;visible=mergeNotificationPage(visible,page(all,cursor),cursor);}
 assert.deepEqual(visible.items.map(item=>item.id),all.map(item=>item.id));
 assert.equal(new Set(visible.items.map(item=>item.id)).size,50);
});

test('novedades que se solapan conservan el historial cargado y actualizan la lectura',async()=>{
 const [{mergeNotificationPage}]=await modules;
 const previous={items:items(40,1),unread:40,next_cursor:null},fresh=page(items(45,1));
 fresh.items[0].read_at='2026-10-06T12:00:00Z';fresh.unread=44;
 const visible=mergeNotificationPage(previous,fresh);
 assert.deepEqual(visible.items.map(item=>item.id),items(45,1).map(item=>item.id));
 assert.equal(visible.items[0].read_at,fresh.items[0].read_at);
 assert.equal(visible.unread,44);assert.equal(visible.next_cursor,null);
});

test('una bandeja vacía elimina filas antiguas del navegador',async()=>{
 const [{mergeNotificationPage}]=await modules;
 assert.deepEqual(mergeNotificationPage(page(items(20,1)),page([])),page([]));
});

async function serverFixture(){
 const server=http.createServer((req,res)=>{
   if(req.url==='/headers')return; // Socket abierto, sin respuesta.
   if(req.url==='/body'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');return;}
   res.setHeader('Content-Type','application/json');res.end('{"ok":true}');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}

test('el plazo cancela consultas detenidas y permite una consulta posterior',async()=>{
 const [,{request}]=await modules,server=await serverFixture();
 try{
   for(const endpoint of ['/headers','/body'])await assert.rejects(request(server.url+endpoint,{timeoutMs:150}),error=>error.name==='TimeoutError');
   assert.deepEqual(await request(server.url+'/ok',{timeoutMs:1000}),{ok:true});
 }finally{await server.close();}
});

test('cambiar de sesión sigue cancelando una consulta aunque tenga un plazo',async()=>{
 const [,{request}]=await modules,server=await serverFixture(),controller=new AbortController();
 try{
   const pending=request(server.url+'/headers',{signal:controller.signal,timeoutMs:1000});
   controller.abort();await assert.rejects(pending,error=>error.name==='AbortError');
 }finally{await server.close();}
});
