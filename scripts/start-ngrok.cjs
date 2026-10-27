// Public launcher; keeps the existing bounded tunnel and authentication checks.
const fs=require('node:fs'),path=require('node:path');
const {spawn,execFileSync,execFile}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..'),registration=path.join(root,'data/ngrok-process.json');
const stopRequest=path.join(root,'data/ngrok-stop-request.json');
function safeOrigin(value){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname!=='/'||!/^[a-z0-9.-]+$/i.test(url.hostname))throw Error('ngrok no devolvió un origen HTTPS válido.');
 return url.origin;
}
async function run(ops){
 await ops.startReal();
 const tunnel=ops.openTunnel();
 try{
  const origin=safeOrigin(await tunnel.ready);
  await ops.applyOrigin(origin);
  await ops.register(tunnel);
  ops.openBrowser(origin);
  ops.announce(origin);
  const code=await tunnel.finished;
  if(code!==0)throw Error('El túnel se cerró con un error. TeleCUS sigue disponible localmente.');
 }finally{
  await tunnel.stop();
  await ops.unregister();
 }
}
function openTunnel(){
 const child=spawn(process.execPath,[path.join(root,'scripts/ngrok-session.cjs'),'--allow-live'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
 let resolveReady,rejectReady,settled=false,buffer='';
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const finished=new Promise(resolve=>{
  child.once('error',()=>{if(!settled){settled=true;rejectReady(Error('No se pudo iniciar el túnel.'));}resolve(-1);});
  child.once('close',code=>{if(!settled){settled=true;rejectReady(Error('No se pudo abrir ngrok. Revisa la cuenta y que no haya otro túnel activo.'));}resolve(code);});
 });
 child.stdout.on('data',chunk=>{
  buffer+=chunk.toString();
  for(let end;(end=buffer.indexOf('\n'))>=0;){
   const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);
   if(line.startsWith('NGROK_URL=')&&!settled){settled=true;resolveReady(line.slice(10));}
  }
 });
 // The child sanitizes its messages; never print raw agent output or credentials.
 child.stderr.on('data',()=>{});
 const stop=()=>{if(child.connected)child.send({type:'telecus.stop'},()=>{});};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);process.once('exit',stop);
 return {ready,finished,stop:async()=>{stop();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);process.removeListener('exit',stop);await finished;}};
}
function cli(){
 if(process.argv.includes('--help')){
  console.log('Inicio real con ngrok: solo puerto 5173, acceso Google y permisos por rol; túnel máximo de 60 minutos.');
  console.log('Conserva esta ventana abierta. DETENER_TELECUS.cmd cierra también el túnel.');return;
 }
 process.chdir(root);
 const sessionId=randomUUID();let watcher;
 const runNode=args=>execFileSync(process.execPath,args,{cwd:root,windowsHide:true,stdio:'inherit'});
 return run({
  startReal:()=>runNode(['scripts/mode.cjs','supabase-live']),
  openTunnel,
  applyOrigin:origin=>{runNode(['scripts/stop.cjs']);runNode(['scripts/start-tunnel.cjs',origin]);},
  register:tunnel=>{
   fs.writeFileSync(registration,JSON.stringify({pid:process.pid,command:__filename,sessionId}));
   watcher=setInterval(()=>{try{if(JSON.parse(fs.readFileSync(stopRequest,'utf8')).sessionId===sessionId)void tunnel.stop();}catch{}},100);
  },
  unregister:()=>{
   if(watcher)clearInterval(watcher);
   try{if(JSON.parse(fs.readFileSync(stopRequest,'utf8')).sessionId===sessionId)fs.unlinkSync(stopRequest);}catch{}
   try{const entry=JSON.parse(fs.readFileSync(registration,'utf8'));if(entry.pid===process.pid&&entry.sessionId===sessionId)fs.unlinkSync(registration);}catch{}
  },
  openBrowser:origin=>execFile('rundll32.exe',['url.dll,FileProtocolHandler',origin],{windowsHide:true},()=>{}),
  announce:origin=>{console.log('TeleCUS real: '+origin);console.log('Si Google no permite volver a esta dirección, añádela exactamente a Redirect URLs de Supabase.');console.log('Túnel temporal de hasta 60 minutos. Deja esta ventana abierta; Ctrl+C o DETENER_TELECUS.cmd lo cierran.');}
 });
}
module.exports={run,safeOrigin};
if(require.main===module)Promise.resolve().then(cli).catch(()=>{console.error('No se completó el inicio con ngrok. Comprueba Ollama, la conexión de ngrok y que los puertos estén libres.');process.exitCode=1;});
