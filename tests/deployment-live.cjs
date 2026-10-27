// Explicit local smoke test. Isolated Node-RED and fully simulated Google token exchange.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),net=require('node:net'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');process.chdir(root);process.loadEnvFile('.env');
const temporary=fs.mkdtempSync(path.join(root,'data','test-deployment-'));const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function child(args,env){const fd=fs.openSync(path.join(temporary,crypto.randomUUID()+'.log'),'w');const process=spawn(global.process.execPath,args,{cwd:root,windowsHide:true,env:{...global.process.env,...env},stdio:['ignore',fd,fd]});fs.closeSync(fd);return process;}
async function portAvailable(port){await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(resolve));});}
async function headless(){
 const port=1881,base='http://127.0.0.1:'+port,token=crypto.randomBytes(32).toString('hex');await portAvailable(port);
 const process=child([global.process.env.NODE_RED_ENTRY,'--userDir',path.join(temporary,'node-red'),'--settings',path.join(root,'node-red/settings.cjs'),path.join(root,'node-red/flows.json')],{NODE_RED_HOST:'127.0.0.1',NODE_RED_PORT:String(port),NODE_RED_DISABLE_EDITOR:'true',TELECUS_INTERNAL_TOKEN:token});
 try{
  let ready=false;for(let i=0;i<100;i++){try{const response=await fetch(base+'/telecus/internal/health',{headers:{'X-TeleCUS-Internal':token}});if(response.ok){ready=true;break;}}catch{}await sleep(200);}
  assert.ok(ready,'El flujo interno debe funcionar con el editor deshabilitado.');
  assert.equal((await fetch(base+'/editor/')).status,404);assert.equal((await fetch(base+'/telecus/internal/health')).status,401);
  console.log('Node-RED aislado: editor deshabilitado, inferencia interna disponible y acceso interno protegido.');
 }finally{process.kill();await new Promise(resolve=>process.exitCode!==null?resolve():process.once('exit',resolve));}
}
async function googlePaths(){
 await portAvailable(8888);const clientFile=path.join(temporary,'fake-client.json'),tokenFile=path.join(temporary,'private','fake-tokens.enc'),urlFile=path.join(temporary,'private','fake-authorization.txt'),secret=crypto.randomBytes(32).toString('hex');
 fs.writeFileSync(clientFile,JSON.stringify({web:{client_id:'fictional-client',client_secret:'fictional-secret',redirect_uris:['http://localhost:8888/google/callback']}}));
 const harness=path.join(temporary,'oauth-harness.cjs');fs.writeFileSync(harness,"global.fetch=async()=>new Response(JSON.stringify({refresh_token:'fictional-refresh',access_token:'fictional-access'}),{status:200});require("+JSON.stringify(path.join(root,'scripts/connect-google.cjs'))+");");
 const process=child([harness],{GOOGLE_OAUTH_CLIENT_FILE:clientFile,GOOGLE_TOKEN_FILE:tokenFile,GOOGLE_AUTHORIZATION_URL_FILE:urlFile,DEMO_SESSION_SECRET:secret});
 try{
  for(let i=0;i<100&&!fs.existsSync(urlFile);i++)await sleep(100);assert.ok(fs.existsSync(urlFile),'Se debe respetar la ruta externa de la URL administrativa.');
  const authorization=new URL(fs.readFileSync(urlFile,'utf8'));assert.equal(authorization.searchParams.get('client_id'),'fictional-client');
  assert.equal((await fetch('http://127.0.0.1:8888/google/callback?state=invalid')).status,400);
  const callback=new URL('http://127.0.0.1:8888/google/callback');callback.search=new URLSearchParams({state:authorization.searchParams.get('state'),code:'fictional-code'}).toString();assert.equal((await fetch(callback)).status,200);
  const encrypted=JSON.parse(fs.readFileSync(tokenFile,'utf8')),cipher=crypto.createDecipheriv('aes-256-gcm',crypto.createHash('sha256').update(secret).digest(),Buffer.from(encrypted.iv,'base64'));cipher.setAuthTag(Buffer.from(encrypted.tag,'base64'));const tokens=JSON.parse(Buffer.concat([cipher.update(Buffer.from(encrypted.data,'base64')),cipher.final()]).toString());assert.equal(tokens.refresh_token,'fictional-refresh');
  console.log('OAuth simulado: rutas externas respetadas, state validado y tokens ficticios cifrados. No se llamó a Google.');
 }finally{process.kill();await new Promise(resolve=>process.exitCode!==null?resolve():process.once('exit',resolve));}
}
headless().then(googlePaths).catch(e=>{console.error(e.message);process.exitCode=1;});
