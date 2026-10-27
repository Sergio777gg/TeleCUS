// Temporary visual QA server: synthetic appointments and notifications, isolated SQLite.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');process.chdir(root);
async function main(){
 const directory=fs.mkdtempSync(path.join(root,'data','notifications-preview-')),file=path.join(directory,'demo.sqlite');
 const {Database}=await import('../apps/backend/dist/database.js'),{Repository,demoIds}=await import('../apps/backend/dist/repository.js');
 const db=new Database('',file),repo=new Repository(db,{mode:'demo'});await db.initialize();await repo.seed();
 const profiles=await db.query('SELECT * FROM telecus_demo_profiles'),patient=profiles.find(p=>p.id===demoIds.patient),admin=profiles.find(p=>p.id===demoIds.admin);
 await db.transaction(cx=>repo.execute(admin,'verify_payment',{appointment_code:'TCUS-DEMO-001'},cx));
 await db.transaction(cx=>repo.execute(patient,'cancel',{appointment_code:'TCUS-DEMO-001'},cx));await db.close();
 const log=fs.openSync(path.join(directory,'preview.log'),'w');
 const child=spawn(process.execPath,['apps/backend/dist/main.js'],{cwd:root,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,DATA_MODE:'demo',API_PORT:'5176',API_HOST:'127.0.0.1',APP_ORIGIN:'http://localhost:5176',SQLITE_FILE:file,DATABASE_URL:'',RUN_WORKER:'true'}});fs.closeSync(log);
 const stop=()=>{child.kill();process.exit();};process.on('SIGINT',stop);process.on('SIGTERM',stop);child.on('exit',()=>process.exit());
 setTimeout(stop,10*60000);console.log('Vista temporal con datos ficticios: http://localhost:5176 (se cierra automáticamente).');
}
main().catch(()=>{console.error('No se pudo iniciar la vista ficticia.');process.exitCode=1;});
