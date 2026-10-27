// One-time, idempotent relocation of documentation and Windows entry points.
// Runtime directories and private configuration are deliberately outside this migration.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const locations={
 'ARQUITECTURA.md':'docs/architecture/ARQUITECTURA.md',
 'DIAGRAMA_BACKEND.md':'docs/architecture/DIAGRAMA_BACKEND.md',
 'ESCALABILIDAD.md':'docs/architecture/ESCALABILIDAD.md',
 'REVISION_ESCALABILIDAD.md':'docs/architecture/REVISION_ESCALABILIDAD.md',
 'CONECTAR_GOOGLE.md':'docs/operations/CONECTAR_GOOGLE.md',
 'LO_QUE_NECESITAMOS.md':'docs/operations/LO_QUE_NECESITAMOS.md',
 'BASE_EXISTENTE.md':'docs/integration/BASE_EXISTENTE.md',
 'RAG.md':'docs/integration/RAG.md',
 'MEJORAS_CONVERSACION.md':'docs/integration/MEJORAS_CONVERSACION.md',
 'INTEGRACION_VERIFICADA.md':'docs/verification/INTEGRACION_VERIFICADA.md',
 'INSPECCION_VERIFICADA.md':'docs/verification/INSPECCION_VERIFICADA.md',
 'VERIFICACION.md':'docs/verification/VERIFICACION.md',
 'INSPECCION_BASE.sql':'scripts/sql/inspect-base.sql'
};
function inside(relative){const file=path.resolve(root,relative);if(!file.startsWith(root+path.sep))throw Error('Destino fuera del proyecto.');return file;}
const moved=new Map(Object.entries(locations).map(([a,b])=>[inside(a),inside(b)]));
const contents=[];
for(const [from,to]of moved){
 if(!fs.existsSync(from))continue;
 if(fs.lstatSync(from).isSymbolicLink())throw Error('No se trasladan enlaces simbólicos.');
 if(fs.existsSync(to))throw Error('Ya existe un destino de documentación; no se sobrescribirá.');
 if(from.endsWith('.md'))contents.push({from,to,text:fs.readFileSync(from,'utf8')});
}
contents.push({from:inside('README.md'),to:inside('README.md'),text:fs.readFileSync(inside('README.md'),'utf8')});
for(const [from,to]of moved){if(fs.existsSync(from)){fs.mkdirSync(path.dirname(to),{recursive:true});fs.renameSync(from,to);}}
for(const item of contents){
 const text=item.text.replace(/(!?\[[^\]]*\]\()([^\s)]+)(\))/g,(whole,start,target,end)=>{
  if(/^(?:[a-z]+:|\/|#)/i.test(target))return whole;
  const [name,fragment]=target.split('#');const old=path.resolve(path.dirname(item.from),name),dest=moved.get(old)||old;
  return start+path.relative(path.dirname(item.to),dest).split(path.sep).join('/')+(fragment?'#'+fragment:'')+end;
 });fs.writeFileSync(item.to,text);
}
for(const name of require('./windows-launchers.cjs').daily){
 const from=inside(name+'.cmd'),to=inside('launchers/windows/'+name+'.cmd');
 if(!fs.existsSync(to)){
  const text=fs.readFileSync(from,'utf8').replace('cd /d "%~dp0"','cd /d "%~dp0..\\.."');
  fs.mkdirSync(path.dirname(to),{recursive:true});fs.writeFileSync(to,text);
 }
 fs.writeFileSync(from,'@echo off\r\ncall "%~dp0launchers\\windows\\'+name+'.cmd" %*\r\nexit /b %errorlevel%\r\n');
}
console.log('Documentación y lanzadores organizados. Configuración y datos privados conservados en su ubicación.');
