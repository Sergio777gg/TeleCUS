// Private credential input, rollback integration trial, additive migrations and immutable checksums.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');process.chdir(path.resolve(__dirname,'..'));
async function main(){
 let credential=await require('./read-secret.cjs')('Contraseña de administración de Supabase (entrada oculta): ');
 const client=await require('./db-admin.cjs')(credential);credential='';
 try{
  const trial=await require('./test-visit-workflow-db.cjs').run(client);console.log(JSON.stringify({...trial,installed:false}));
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='30s'");await client.query("SELECT pg_advisory_xact_lock(hashtext('telecus-migrations')::bigint)");
  const state=async()=>(await client.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb) AS policies FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1) ORDER BY c.relname",[['profiles','appointments','appointment_change_requests','appointment_logs']])).rows;
  const before=await state(),installed=[];
  for(const name of require('./test-visit-workflow-db.cjs').migrations){
   const sql=await fs.readFile('scripts/sql/'+name+'.sql','utf8'),hash=crypto.createHash('sha256').update(sql).digest('hex'),old=(await client.query('SELECT sha256 FROM telecus_integration.schema_migrations WHERE name=$1',[name])).rows[0];
   if(old&&old.sha256!==hash)throw Error('migration_checksum_mismatch');
   if(!old){await client.query(sql);await client.query('INSERT INTO telecus_integration.schema_migrations(name,sha256) VALUES($1,$2)',[name,hash]);installed.push(name);}
  }
  if(JSON.stringify(before)!==JSON.stringify(await state()))throw Error('public_schema_or_rls_changed');
  await client.query('COMMIT');console.log(JSON.stringify({status:'ok',installed,originalSchemaAndRLS:'preserved',paymentsEnabled:'unchanged; administrator selects mode',googleCalls:0,inferenceCalls:0}));
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{await client.end();}
}
main().catch(e=>{console.error(JSON.stringify({status:'failed',stage:e.stage,checks:e.checks,code:e.code||e.message,detail:['42501','42702','42703','42883'].includes(e.code)?e.message:undefined,installed:false}));process.exitCode=1;});
