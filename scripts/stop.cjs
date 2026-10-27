const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');
module.exports=function stop(){
const root=path.resolve(__dirname,'..');const file=path.join(root,'data/processes.json');
stopTunnel(root);
if(!fs.existsSync(file)){console.log('No hay procesos de TeleCUS registrados.');return;}
const processes=JSON.parse(fs.readFileSync(file,'utf8'));let pending=false;
for(const [name,entry]of Object.entries(processes)){
  if(!Number.isInteger(entry.pid))continue;
  let line='';try{line=execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop'; (Get-CimInstance Win32_Process -Filter 'ProcessId = ${entry.pid}').CommandLine`],{windowsHide:true,encoding:'utf8',stdio:'pipe'});}catch{pending=true;console.log('No se pudo comprobar un proceso de TeleCUS; su registro se conserva.');continue;}
  if(!line.trim())continue;
  if(!line.toLowerCase().includes(root.toLowerCase())||!line.toLowerCase().includes(entry.command.toLowerCase())){console.log('No se detuvo un proceso que ya no corresponde a TeleCUS.');continue;}
  try{process.kill(entry.pid);console.log(name+' detenido.');}catch{pending=true;}
}
if(!pending)fs.unlinkSync(file);
};
function stopTunnel(root){
 const file=path.join(root,'data/ngrok-process.json');if(!fs.existsSync(file))return;
 let entry;try{entry=JSON.parse(fs.readFileSync(file,'utf8'));}catch{console.log('No se pudo comprobar el proceso del túnel.');return;}
 if(!Number.isInteger(entry.pid)||entry.command!==path.join(root,'scripts/start-ngrok.cjs')||! /^[a-f0-9-]{36}$/i.test(entry.sessionId||''))return;
 // A request belongs to this launch instance. No arbitrary PID is terminated.
 const request=path.join(root,'data/ngrok-stop-request.json');
 fs.writeFileSync(request,JSON.stringify({sessionId:entry.sessionId}));
 const pause=new Int32Array(new SharedArrayBuffer(4));
 for(let attempt=0;attempt<50;attempt++){
  try{if(JSON.parse(fs.readFileSync(file,'utf8')).sessionId!==entry.sessionId){console.log('Túnel ngrok detenido.');return;}}catch{if(!fs.existsSync(file)){console.log('Túnel ngrok detenido.');return;}}
  Atomics.wait(pause,0,0,100);
 }
 console.log('No se pudo confirmar el cierre del túnel; usa Ctrl+C en su ventana.');
}
if(require.main===module)module.exports();
