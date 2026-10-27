// Versioned, additive update of the existing agenda. Admin credential arrives only on stdin.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
process.chdir(path.resolve(__dirname,'..'));
async function main(){
 const client=await require('./db-admin.cjs')();
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='30s'");await client.query("SELECT pg_advisory_xact_lock(hashtext('telecus-migrations')::bigint)");
  if((await client.query('SELECT telecus_integration.version() AS version')).rows[0].version!==1)throw Error('Falta la integración de agenda compatible.');
  const before=(await client.query("SELECT relname,relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1) ORDER BY relname",[['profiles','appointments','appointment_change_requests','appointment_logs']])).rows;
  await client.query('CREATE TABLE IF NOT EXISTS telecus_integration.schema_migrations (name text PRIMARY KEY,sha256 text NOT NULL,installed_at timestamptz NOT NULL DEFAULT now())');
  await client.query('REVOKE ALL ON telecus_integration.schema_migrations FROM PUBLIC,anon,authenticated,service_role,telecus_backend');
  const installed=[];
  for(const name of ['002-notifications','003-notification-inputs']){
   const sql=await fs.readFile('scripts/sql/'+name+'.sql','utf8'),hash=crypto.createHash('sha256').update(sql).digest('hex');
   const existing=(await client.query('SELECT sha256 FROM telecus_integration.schema_migrations WHERE name=$1',[name])).rows[0];
   if(existing&&existing.sha256!==hash)throw Error('La migración instalada tiene otra huella; utiliza una nueva migración para actualizarla.');
   if(!existing){await client.query(sql);await client.query('INSERT INTO telecus_integration.schema_migrations(name,sha256) VALUES($1,$2)',[name,hash]);installed.push(name);}
  }
  const after=(await client.query("SELECT relname,relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1) ORDER BY relname",[['profiles','appointments','appointment_change_requests','appointment_logs']])).rows;
  if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Cambió la configuración de las tablas originales.');
  await client.query('COMMIT');console.log(JSON.stringify({status:installed.length?'installed':'already_installed',migrations:installed,originalTablesAndRLS:'preserved',historicalBackfill:false}));
 }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({status:'failed',code:e.code||e.message}));process.exitCode=1;}finally{await client.end();}
}
main().catch(()=>{console.error('No se pudo preparar la actualización de notificaciones.');process.exitCode=1;});
