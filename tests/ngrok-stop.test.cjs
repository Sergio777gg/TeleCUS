const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn,execFileSync}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'telecus stop fixture '));
 fs.mkdirSync(path.join(root,'scripts'));fs.mkdirSync(path.join(root,'data'));
 fs.copyFileSync(path.join(__dirname,'../scripts/stop.cjs'),path.join(root,'scripts/stop.cjs'));
 return{root,register:entry=>fs.writeFileSync(path.join(root,'data/ngrok-process.json'),JSON.stringify(entry)),stop:()=>execFileSync(process.execPath,[path.join(root,'scripts/stop.cjs')],{cwd:root,windowsHide:true,encoding:'utf8',timeout:15000}),cleanup:()=>{
  const resolved=fs.realpathSync(root),temporary=fs.realpathSync(os.tmpdir());
  if(path.dirname(resolved)!==temporary||!path.basename(resolved).startsWith('telecus stop fixture '))throw Error('Ruta temporal no válida.');
  fs.rmSync(resolved,{recursive:true,force:true});
 }};
}
test('Detener cierra el túnel propio y sus hijos incluso sin registro de API; soporta rutas con espacios',{skip:process.platform!=='win32'},async()=>{
 const f=fixture(),command=path.join(f.root,'scripts/start-ngrok.cjs'),sessionId=randomUUID();
 fs.writeFileSync(command,`const fs=require('node:fs'),{spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',"process.on('disconnect',()=>process.exit());setInterval(()=>{},1000);"],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
let stopping=false;
function stop(){if(stopping)return;stopping=true;child.once('exit',()=>{clearInterval(timer);for(const name of ['data/ngrok-stop-request.json','data/ngrok-process.json'])try{fs.unlinkSync(name);}catch{};if(process.connected)process.disconnect();});child.kill();}
const timer=setInterval(()=>{try{if(JSON.parse(fs.readFileSync('data/ngrok-stop-request.json','utf8')).sessionId==='${sessionId}')stop();}catch{}},50);
process.on('message',message=>{if(message?.type==='telecus.stop')stop();});process.once('disconnect',stop);
console.log(child.pid);`);
 const runner=spawn(process.execPath,[command],{cwd:f.root,windowsHide:true,stdio:['ignore','pipe','ignore','ipc']});
 let descendant;
 try{
  descendant=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No inició el proceso ficticio.')),5000);runner.stdout.once('data',chunk=>{clearTimeout(timer);resolve(Number(chunk.toString().trim()));});runner.once('error',reject);});
  assert.ok(alive(descendant));f.register({pid:runner.pid,command,sessionId});
  assert.match(f.stop(),/Túnel ngrok detenido/);
  for(let i=0;i<30&&(alive(runner.pid)||alive(descendant));i++)await delay(100);
  assert.equal(alive(runner.pid),false);assert.equal(alive(descendant),false);
  assert.equal(fs.existsSync(path.join(f.root,'data/ngrok-process.json')),false);
 }finally{
  if(runner.connected)runner.send({type:'telecus.stop'},()=>{});
  for(let i=0;i<30&&runner.exitCode===null&&runner.signalCode===null;i++)await delay(100);
  if(runner.exitCode===null&&runner.signalCode===null)runner.kill();
  f.cleanup();
 }
});
test('Detener no cierra un PID que no corresponde al túnel registrado',{skip:process.platform!=='win32'},async()=>{
 const f=fixture(),unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
 try{
  f.register({pid:unrelated.pid,command:path.join(f.root,'scripts/start-ngrok.cjs'),sessionId:randomUUID()});
  assert.match(f.stop(),/No se pudo confirmar el cierre/);assert.ok(alive(unrelated.pid));
 }finally{unrelated.kill();f.cleanup();}
});
