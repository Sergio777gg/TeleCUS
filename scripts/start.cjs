const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');const net=require('node:net');
const root=path.resolve(__dirname,'..');process.chdir(root);require('./configure.cjs');process.loadEnvFile('.env');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function free(port){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',()=>reject(Error(`El puerto ${port} está ocupado. Revisa si TeleCUS ya está abierto.`)));s.listen(port,'127.0.0.1',()=>s.close(resolve));});}
function launch(name,args){const fd=fs.openSync(path.join(root,'logs',name+'.log'),'a');const child=spawn(process.execPath,args,{cwd:root,env:process.env,detached:true,windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);child.unref();return {pid:child.pid,command:args[0]};}
async function main(){
  try{const r=await fetch(process.env.APP_ORIGIN+'/api/healthz',{signal:AbortSignal.timeout(2000)});if(r.ok){console.log('TeleCUS ya está abierto: '+process.env.APP_ORIGIN);return;}}catch{}
  await free(Number(process.env.API_PORT));
  const ollama=await fetch(process.env.OLLAMA_URL+'/api/tags',{signal:AbortSignal.timeout(5000)}).catch(()=>null);
  if(!ollama?.ok)throw Error('Abre Ollama desde el menú Inicio y vuelve a iniciar TeleCUS.');
  const userDir=path.join(root,'data','node-red');fs.mkdirSync(userDir,{recursive:true});const flows=path.join(userDir,'flows.json');if(!fs.existsSync(flows))fs.copyFileSync('node-red/flows.json',flows);
  let existing={};try{existing=JSON.parse(fs.readFileSync('data/processes.json','utf8'));}catch{}
  let running=false;try{const r=await fetch(process.env.INFERENCE_URL.replace(/\/interpret$/,'/health'),{headers:{'X-TeleCUS-Internal':process.env.TELECUS_INTERNAL_TOKEN},signal:AbortSignal.timeout(3000)});running=r.ok&&Boolean(existing.nodeRed);}catch{}
  if(!running)await free(Number(process.env.NODE_RED_PORT));
  const processes={nodeRed:running?existing.nodeRed:launch('node-red',[process.env.NODE_RED_ENTRY,'--userDir',userDir,'--settings',path.join(root,'node-red/settings.cjs'),flows])};
  fs.writeFileSync('data/processes.json',JSON.stringify(processes));
  for(let i=0;i<120;i++){try{const r=await fetch(process.env.INFERENCE_URL.replace(/\/interpret$/,'/health'),{headers:{'X-TeleCUS-Internal':process.env.TELECUS_INTERNAL_TOKEN},signal:AbortSignal.timeout(1500)});if(r.ok)break;}catch{}if(i===119)throw Error('Node-RED no pudo iniciar. Revisa logs/node-red.log.');await sleep(500);}
  processes.api=launch('api',[path.join(root,'apps/backend/dist/main.js')]);fs.writeFileSync('data/processes.json',JSON.stringify(processes));
  for(let i=0;i<60;i++){try{const r=await fetch(process.env.APP_ORIGIN+'/api/healthz',{signal:AbortSignal.timeout(1500)});if(r.ok){console.log('TeleCUS disponible en '+process.env.APP_ORIGIN);console.log('Editor de flujos: http://localhost:1880/editor');return;}}catch{}await sleep(500);}
  throw Error('La aplicación no pudo iniciar. Revisa logs/api.log.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
