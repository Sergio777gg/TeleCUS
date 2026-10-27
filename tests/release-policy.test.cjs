const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {publishable,copyPublic,checkText}=require('../scripts/release-policy.cjs');
test('entrega excluye datos locales e históricos y conserva código, plantillas y PDF ficticio',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'telecus-share-')),root=path.join(base,'project'),out=path.join(base,'delivery');fs.mkdirSync(root);
 const write=(name,text)=>{const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);};
 try{write('README.md','# Guía\n[Instalar](docs/install.md)\n![Captura](docs/verification/real.png)');write('docs/install.md','Instalar');write('.gitignore','data/\n.env\nnode_modules/');write('docs/verification/report.md','LOCAL_ONLY');write('docs/history/report.md','OLD_ONLY');write('data/private.json','SECRET');write('node_modules/fake/index.js','DEPENDENCY');write('.env','SECRET');write('ACCESO_NODE_RED.local.txt','SECRET');write('apps/frontend/src/hello.jsx','export const Hello=()=>null;');write('apps/frontend/dist/assets/pdf.worker.mjs','export const worker=true;');write('deploy/env/api.env.example','DATA_MODE=demo');write('tests/fixtures/comprobante-ficticio.pdf','%PDF-synthetic');
  const hashes=copyPublic(root,out);for(const n of ['.gitignore','apps/frontend/dist/assets/pdf.worker.mjs','apps/frontend/src/hello.jsx','deploy/env/api.env.example','tests/fixtures/comprobante-ficticio.pdf'])assert.ok(hashes[n]);
  for(const n of ['data/private.json','.env','ACCESO_NODE_RED.local.txt','docs/verification/report.md','docs/history/report.md','node_modules/fake/index.js'])assert.equal(fs.existsSync(path.join(out,n)),false);
  assert.match(fs.readFileSync(path.join(out,'README.md'),'utf8'),/docs\/install.md/);assert.doesNotMatch(fs.readFileSync(path.join(out,'README.md'),'utf8'),/real.png/);assert.throws(()=>copyPublic(root,out),/ya existe/);
 }finally{if(path.dirname(base)!==os.tmpdir()||!path.basename(base).startsWith('telecus-share-'))throw Error('Invalid fixture path');fs.rmSync(base,{recursive:true,force:true});}
});
test('política rechaza rutas privadas y credenciales sin imprimir su contenido',()=>{
 for(const n of ['../outside','data/file.json','docs/.env','logs/file.md','x/google-client.json','vistas/patient.png'])assert.equal(publishable(n),false);
 assert.equal(publishable('deploy/env/api.env.example'),true);assert.throws(()=>checkText('fake.cjs','GOCSPX-'+'x'.repeat(30)),/Posible credencial/);
});
