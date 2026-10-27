// Public source allowlist. Never descend into private runtime directories.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const folders=['apps/backend/src','apps/backend/dist','apps/frontend/src','apps/frontend/dist','apps/frontend/public','scripts','tests','docs','deploy','launchers','models','node-red','knowledge/telecus'];
const rootFiles=['apps.tree','apps/README.md','apps/backend/README.md','apps/frontend/README.md','README.md','package.json','package-lock.json','.gitignore','AGENTS.md','apps/backend/package.json','apps/backend/tsconfig.json','apps/frontend/package.json','apps/frontend/index.html','apps/frontend/vite.config.js',...require('./windows-launchers.cjs').daily.map(n=>n+'.cmd')];
const forbidden=new Set(['data','logs','node_modules','release','.git','vistas','verification','history','google-client.json','google-tokens.enc','processes.json','ACCESO_NODE_RED.local.txt']);
const extensions=new Set(['.tree','.mmd','.js','.mjs','.jsx','.ts','.css','.html','.svg','.json','.md','.cjs','.sql','.cmd','.service','.conf','.example','.map','.Modelfile','.pdf']);
function publishable(name){const parts=name.replaceAll('\\','/').split('/');return !path.isAbsolute(name)&&!parts.some(n=>n==='..'||forbidden.has(n)||n.startsWith('.env')||n.endsWith('.local.txt'));}
function checkText(name,text){
 const suspicious=[/GOCSPX-[A-Za-z0-9_-]{12,}/,/ya29\.[A-Za-z0-9_-]{20,}/,/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,/eyJ[A-Za-z0-9_-]{25,}\.[A-Za-z0-9_-]{25,}\.[A-Za-z0-9_-]{20,}/];
 if(suspicious.some(p=>p.test(text)))throw Error('Posible credencial en un archivo público: '+name+'. No se generó la entrega.');
}
function collect(root){
 const files=[];function walk(relative){
  if(!publishable(relative))return;const full=path.resolve(root,relative);if(!full.startsWith(root+path.sep))throw Error('Ruta de entrega no válida.');
  const stat=fs.lstatSync(full);if(stat.isSymbolicLink())throw Error('No se exportan enlaces simbólicos: '+relative);
  if(stat.isDirectory()){for(const name of fs.readdirSync(full))walk(path.join(relative,name));}else if(extensions.has(path.extname(relative))||rootFiles.includes(relative.replaceAll('\\','/')))files.push(relative.replaceAll('\\','/'));
 }
 for(const file of rootFiles)if(fs.existsSync(path.join(root,file)))walk(file);for(const dir of folders)if(fs.existsSync(path.join(root,dir)))walk(dir);return [...new Set(files)].sort();
}
function publicMarkdown(text,file,files){
 return text.replace(/(!?)\[([^\]]*)\]\(([^\s)]+)\)/g,(whole,image,label,target)=>{
  if(/^(?:[a-z]+:|\/|#)/i.test(target))return whole;
  const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(file),target.split('#')[0]));return files.has(resolved)?whole:(image?'':label+' (referencia local no incluida)');
 });
}
function copyPublic(root,destination){
 const files=collect(root),included=new Set(files),hashes={};if(fs.existsSync(destination))throw Error('La carpeta de entrega ya existe; no se sobrescribe.');
 // Validate all public text before creating a delivery, without reading private paths.
 for(const name of files)if(path.extname(name)!=='.pdf')checkText(name,fs.readFileSync(path.join(root,name),'utf8'));
 fs.mkdirSync(destination,{recursive:true});
 for(const name of files){const source=path.resolve(root,name),dest=path.resolve(destination,name);if(!dest.startsWith(destination+path.sep)||!publishable(name))throw Error('Destino de entrega no válido.');
  let bytes=fs.readFileSync(source);if(name.endsWith('.md'))bytes=Buffer.from(publicMarkdown(bytes.toString('utf8'),name,included));
  fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes);hashes[name]=crypto.createHash('sha256').update(bytes).digest('hex');
 }return hashes;
}
module.exports={publishable,collect,copyPublic,checkText};
