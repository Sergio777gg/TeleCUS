// Explicit additive migration. The owner credential is entered locally without echo or storage.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
process.chdir(path.resolve(__dirname,'..'));
async function main(){
 let credential=await require('./read-secret.cjs')('Contraseña de administración de la base (entrada oculta): ');
 const trial=spawnSync(process.execPath,['scripts/test-payment-receipts-db.cjs'],{cwd:process.cwd(),input:credential+'\n',encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:1024*1024});
 let report;try{report=JSON.parse((trial.stdout||'').trim());}catch{}
 if(trial.status!==0||report?.status!=='ok'){credential='';throw new Error('No pasó la prueba transaccional de comprobantes. No se instaló la migración.');}
 console.log(JSON.stringify({transactionalCheck:'passed',checks:report.checks,fixtures:'rolled_back',googleCalls:0}));
 const client=await require('./db-admin.cjs')(credential);credential='';
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='30s'");await client.query("SELECT pg_advisory_xact_lock(hashtext('telecus-migrations')::bigint)");
  const versions=(await client.query('SELECT telecus_integration.version() AS agenda,telecus_integration.notification_version() AS notifications')).rows[0];
  if(versions.agenda!==1||versions.notifications!==2)throw Error('Falta la integración compatible de agenda y notificaciones.');
  const publicState=async()=>(await client.query("SELECT c.relname,c.relrowsecurity,COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb) AS policies FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1) ORDER BY c.relname",[['profiles','appointments','appointment_change_requests','appointment_logs']])).rows;
  const before=await publicState();
  await client.query('CREATE TABLE IF NOT EXISTS telecus_integration.schema_migrations (name text PRIMARY KEY,sha256 text NOT NULL,installed_at timestamptz NOT NULL DEFAULT now())');
  await client.query('REVOKE ALL ON telecus_integration.schema_migrations FROM PUBLIC,anon,authenticated,service_role,telecus_backend');
  const name='004-payment-receipts',sql=await fs.readFile('scripts/sql/'+name+'.sql','utf8'),hash=crypto.createHash('sha256').update(sql).digest('hex');
  const existing=(await client.query('SELECT sha256 FROM telecus_integration.schema_migrations WHERE name=$1',[name])).rows[0];
  if(existing&&existing.sha256!==hash)throw Error('La migración instalada tiene otra huella. Crea otra migración.');
  if(!existing){await client.query(sql);await client.query('INSERT INTO telecus_integration.schema_migrations(name,sha256) VALUES($1,$2)',[name,hash]);}
  if(JSON.stringify(before)!==JSON.stringify(await publicState()))throw Error('Cambió la configuración de las tablas originales.');
  await client.query('COMMIT');console.log(JSON.stringify({status:existing?'already_installed':'installed',migration:name,originalTablesAndRLS:'preserved',automaticPaymentVerification:false}));
 }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({status:'failed',code:e.code||e.message}));process.exitCode=1;}finally{await client.end();}
}
main().catch(()=>{console.error('No se pudo preparar la actualización privada de comprobantes.');process.exitCode=1;});
