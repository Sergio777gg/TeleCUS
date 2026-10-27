const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'..');process.chdir(root);
const nodeRed=process.env.NODE_RED_ENTRY||path.join(process.env.APPDATA||'', 'npm/node_modules/node-red/red.js');
if(!fs.existsSync(nodeRed))throw Error('No se encontró Node-RED. Instálalo o indica NODE_RED_ENTRY.');
const bcrypt=createRequire(nodeRed)('bcryptjs');
if(!fs.existsSync('.env')){
  const editorPassword=crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync('.env',[
    'DATA_MODE=demo','API_HOST=127.0.0.1','API_PORT=5173','APP_ORIGIN=http://localhost:5173',
    'SQLITE_FILE=data/telecus.sqlite','DATABASE_URL=',
    'TELECUS_INTERNAL_TOKEN='+crypto.randomBytes(32).toString('hex'),'DEMO_SESSION_SECRET='+crypto.randomBytes(32).toString('hex'),
    'NODE_RED_ENTRY='+nodeRed,'NODE_RED_HOST=127.0.0.1','NODE_RED_PORT=1880','NODE_RED_PASSWORD_HASH='+bcrypt.hashSync(editorPassword,10),
    'INFERENCE_URL=http://127.0.0.1:1880/telecus/internal/interpret','OLLAMA_URL=http://127.0.0.1:11434','TELECUS_AI_MODEL=telecus-local','TELECUS_AI_CONTEXT=8192','RUN_WORKER=true','MODEL_TIMEOUT_MS=120000',
    'SUPABASE_URL=','SUPABASE_PUBLISHABLE_KEY=',''
  ].join('\n'));
  fs.writeFileSync('ACCESO_NODE_RED.local.txt','Editor: http://localhost:1880/editor\nUsuario: admin\nContraseña: '+editorPassword+'\n\nAcceso personal para este equipo. No compartir ni subir a repositorios.\n');
}
for(const directory of ['data','logs'])fs.mkdirSync(directory,{recursive:true});require('./build-flow.cjs');
console.log('Configuración local preparada. Los secretos no se muestran en los registros.');
