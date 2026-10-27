// Folder delivery or archive from the same public-source policy.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {copyPublic,publishable}=require('./release-policy.cjs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'release'),folderOnly=process.argv.includes('--folder');
for(const expected of ['apps/backend/dist/main.js','apps/frontend/dist/index.html'])if(!fs.existsSync(path.join(root,expected)))throw Error('Compila antes de preparar la entrega.');
const stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,15)+'Z',version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
fs.mkdirSync(output,{recursive:true});
const container=path.join(output,(folderOnly?'PARA_COMPARTIR-':'.staging-')+stamp+'-'+crypto.randomBytes(3).toString('hex')),destination=path.join(container,'telecus-local');
try{
 const hashes=copyPublic(root,destination),formalHashes={};
 const formalSource=path.resolve(root,'..','telecus-documentacion'),formalDest=path.join(container,'telecus-documentacion');
 const formalNames=['01_Formulacion_y_Modelo_de_Negocio.docx','02_Requisitos_y_Reglas_de_Negocio.docx','03_Arquitectura_de_Software.docx','04_Historias_de_Usuario_y_Criterios.docx','05_Casos_de_Uso.docx','06_Verificacion_y_Trazabilidad.docx','07_Despliegue_Operacion_y_Evolucion.docx','README.md'];
 if(formalNames.every(n=>fs.existsSync(path.join(formalSource,n)))){fs.mkdirSync(formalDest);for(const name of formalNames){const from=path.join(formalSource,name);if(fs.lstatSync(from).isSymbolicLink())throw Error('Documento de entrega no válido.');const bytes=fs.readFileSync(from);fs.writeFileSync(path.join(formalDest,name),bytes);formalHashes[name]=crypto.createHash('sha256').update(bytes).digest('hex');}}
 fs.writeFileSync(path.join(destination,'release-manifest.json'),JSON.stringify({version,createdAt:new Date().toISOString(),node:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).engines.node,excludes:['private configuration','runtime data','logs','installed dependencies','historical reports and screenshots'],sha256:hashes,formalDocuments:formalHashes},null,2)+'\n');
 fs.writeFileSync(path.join(container,'LEEME.md'),'# Carpeta para compartir\n\nEntrega limpia de TeleCUS. Abre `telecus-local/README.md` y después `telecus-local/docs/operations/INSTALACION_LOCAL.md`. No contiene credenciales, datos reales, archivos médicos, modelos descargados ni dependencias instaladas. El modo de prueba se configura en el equipo receptor. La documentación formal vigente, si está disponible, se incluye en la carpeta hermana telecus-documentacion.\n');
 if(folderOnly){console.log('Carpeta lista para compartir: '+container);console.log('Archivos públicos: '+Object.keys(hashes).length);}
 else{
  const name='telecus-'+version+'-'+stamp+'.tar.gz',archive=path.join(output,name);
  execFileSync('tar',['-czf',archive,'-C',container,'.'],{windowsHide:true,stdio:'pipe'});
  const members=execFileSync('tar',['-tzf',archive],{windowsHide:true,encoding:'utf8'}).trim().split(/\r?\n/);
  if(members.some(n=>!publishable(n.replace(/^\.\//,''))))throw Error('La entrega no pasó la política de exclusión.');
  fs.writeFileSync(archive+'.sha256',crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')+'  '+name+'\n');console.log('Entrega creada: '+archive);
 }
}finally{
 if(!folderOnly&&fs.existsSync(container)){
  // This command's own fresh staging directory only, verified inside release.
  if(path.dirname(container)!==output||!path.basename(container).startsWith('.staging-')||fs.realpathSync(container)!==container)throw Error('Directorio temporal no válido.');
  fs.rmSync(container,{recursive:true,force:true});
 }
}
