// Additive installer: private stdin, rollback trial, public schema/RLS guard, immutable checksum.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
process.chdir(path.resolve(__dirname,'..'));
async function main(){
 let credential=await require('./read-secret.cjs')('Contraseña temporal de administración (entrada oculta): ');
 const trial=spawnSync(process.execPath,['scripts/test-read-only-queries-db.cjs'],{cwd:process.cwd(),input:credential+'\n',encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:1024*1024});
 let report;try{report=JSON.parse((trial.stdout||trial.stderr||'').trim());}catch{}
 if(trial.status!==0||report?.status!=='ok'){credential='';console.error(JSON.stringify({status:'trial_failed',code:report?.code||'integration_test_failed',checks:report?.checks||0,context:report?.context,installed:false}));process.exitCode=1;return;}
 console.log(JSON.stringify({transactionalCheck:'passed',checks:report.checks,fixtures:'rolled_back',googleCalls:0,inferenceCalls:0}));
 const client=await require('./db-admin.cjs')(credential);credential='';
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='30s'");await client.query("SELECT pg_advisory_xact_lock(hashtext('telecus-migrations')::bigint)");
  const state=async()=>(await client.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb) AS policies FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1) ORDER BY c.relname",[['profiles','appointments','appointment_change_requests','appointment_logs']])).rows;
  const before=await state(),name='008-read-only-queries',sql=await fs.readFile('scripts/sql/'+name+'.sql','utf8'),hash=crypto.createHash('sha256').update(sql).digest('hex'),existing=(await client.query('SELECT sha256 FROM telecus_integration.schema_migrations WHERE name=$1',[name])).rows[0];
  if(existing&&existing.sha256!==hash)throw Error('migration_checksum_mismatch');
  if(!existing){await client.query(sql);await client.query('INSERT INTO telecus_integration.schema_migrations(name,sha256) VALUES($1,$2)',[name,hash]);}
  if(JSON.stringify(before)!==JSON.stringify(await state()))throw Error('public_schema_or_rls_changed');
  await client.query('COMMIT');console.log(JSON.stringify({status:existing?'already_installed':'installed',migration:name,sha256:hash,originalSchemaAndRLS:'preserved',inferenceCalls:0}));
 }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({status:'failed',code:e.code||e.message}));process.exitCode=1;}finally{await client.end();}
}
main().catch(e=>{console.error(JSON.stringify({status:'setup_failed',code:e.code||'setup_error'}));process.exitCode=1;});
