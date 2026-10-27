const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');const errors=[];let links=0;
function markdown(file){
 const text=fs.readFileSync(file,'utf8');
 for(const match of text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)){
  const target=match[1];if(/^(?:[a-z]+:|\/|#)/i.test(target))continue;
  const resolved=path.resolve(path.dirname(file),target.split('#')[0]);links++;
  if(!resolved.startsWith(root+path.sep)||!fs.existsSync(resolved))errors.push(path.relative(root,file)+': '+target);
 }
}
function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('No se siguen enlaces simbólicos en la documentación.');if(entry.isDirectory())scan(file);else if(entry.name.endsWith('.md'))markdown(file);}}
markdown(path.join(root,'README.md'));scan(path.join(root,'docs'));markdown(path.join(root,'deploy/README.md'));markdown(path.join(root,'scripts/README.md'));markdown(path.join(root,'launchers/windows/README.md'));
const {daily,maintenance}=require('./windows-launchers.cjs');
for(const name of daily){
 const target='launchers/windows/'+name+'.cmd';const wrapper=fs.readFileSync(path.join(root,name+'.cmd'),'utf8');
 if(!wrapper.includes(target.replaceAll('/','\\'))||!fs.existsSync(path.join(root,target)))errors.push('Lanzador incompatible: '+name);
 if(!fs.readFileSync(path.join(root,target),'utf8').includes('cd /d "%~dp0..\\.."'))errors.push('Directorio incorrecto: '+target);
}
for(const name of maintenance){
 const target=path.join(root,'launchers/windows',name+'.cmd');
 if(!fs.existsSync(target)||!fs.readFileSync(target,'utf8').includes('cd /d "%~dp0..\\.."'))errors.push('Herramienta incompatible: '+name);
}
const expected=daily.map(name=>name+'.cmd').sort(),actual=fs.readdirSync(root).filter(name=>name.toLowerCase().endsWith('.cmd')).sort();
if(JSON.stringify(actual)!==JSON.stringify(expected))errors.push('La raíz debe contener solo los cuatro accesos de uso diario: '+expected.join(', '));
const internal=fs.readdirSync(path.join(root,'launchers/windows')).filter(name=>name.toLowerCase().endsWith('.cmd')).sort();
if(JSON.stringify(internal)!==JSON.stringify([...daily,...maintenance].map(name=>name+'.cmd').sort()))errors.push('Hay accesos Windows faltantes u obsoletos en launchers/windows.');
for(const [name,mode] of [['INICIAR_REAL_LOCAL','supabase-live'],['INICIAR_PRUEBA_LOCAL','demo']]){
 if(!fs.readFileSync(path.join(root,'launchers/windows',name+'.cmd'),'utf8').includes('node scripts\\mode.cjs '+mode))errors.push('Modo de inicio incorrecto: '+name);
}
if(!fs.readFileSync(path.join(root,'launchers/windows/INICIAR_REAL_NGROK.cmd'),'utf8').includes('node "%cd%\\scripts\\start-ngrok.cjs"'))errors.push('Inicio de ngrok incompatible.');
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log(`Estructura comprobada: ${links} enlaces, ${daily.length} accesos principales y ${maintenance.length} herramientas auxiliares.`);
