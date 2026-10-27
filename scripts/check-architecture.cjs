// Public source only. Enforce dependency direction without loading runtime state.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function validateArchitecture(){
 const api=path.join(root,'apps/backend/src'),web=path.join(root,'apps/frontend/src/components'),files=[],errors=[],graph=new Map();
 function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('No se siguen enlaces simbólicos.');if(entry.isDirectory())scan(full);else if(/\.(ts|jsx)$/.test(entry.name))files.push(full);}}
 scan(api);scan(web);
 for(const file of files){
   const relative=path.relative(api,file).replaceAll('\\','/'),isComponent=file.startsWith(web+path.sep);
   const strict=relative.startsWith('ports/')||relative.startsWith('application/')||relative.startsWith('http/')||['domain.ts','notifications.ts'].includes(relative)||isComponent;
   const source=fs.readFileSync(file,'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,''),deps=[];
   for(const match of source.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[\w*{},\s]+?\s+from\s+)?['"]([^'"]+)['"]/g)){
     const target=match[1];
     if(target.startsWith('.')){
       const name=target.replace(/\.js$/,isComponent?'.jsx':'.ts');
       const resolved=path.resolve(path.dirname(file),path.extname(name)?name:name+(isComponent?'.jsx':'.ts'));
       if(resolved.startsWith(api+path.sep)||resolved.startsWith(web+path.sep))deps.push(resolved);
       if(strict&&!isComponent){
         const r=path.relative(api,resolved).replaceAll('\\','/');
         const allowed=relative.startsWith('http/')?r.startsWith('http/')||r.startsWith('application/')||r.startsWith('ports/')||r==='types.ts':
           r.startsWith('ports/')||r.startsWith('application/')||['types.ts','conversation.ts','calendar.ts','presentation.ts'].includes(r);
         if(!allowed)errors.push(relative+' depende de '+r+' fuera de su contrato.');
       }
       if(isComponent&&!resolved.startsWith(web+path.sep))errors.push('Componente de presentación importa '+target);
     }else if(strict&&(/^(pg|node:sqlite|@supabase\/|express)/.test(target)))errors.push(relative+' importa infraestructura '+target);
   }
   if(strict){
     if(/\b(?:fetch|require|import)\s*\(/.test(source))errors.push(relative+' accede directamente a transporte/infraestructura.');
     if(/\.query\s*\(/.test(source))errors.push(relative+' ejecuta SQL fuera de un adaptador.');
   }
   graph.set(file,deps);
 }
 const visited=new Set(),pending=new Set();
 function walk(file){if(pending.has(file)){errors.push('Dependencia circular en '+path.relative(api,file));return;}if(visited.has(file))return;pending.add(file);for(const dep of graph.get(file)||[])walk(dep);pending.delete(file);visited.add(file);}
 for(const file of graph.keys())walk(file);
 if(errors.length)throw Error([...new Set(errors)].join('\n'));
 return {files:files.length};
}
module.exports={validateArchitecture};
if(require.main===module){try{const result=validateArchitecture();console.log('Límites entre capas comprobados en '+result.files+' archivos públicos.');}catch(e){console.error(e.message);process.exitCode=1;}}
