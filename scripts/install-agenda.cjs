// Uses the administrator credential only during setup. Does not alter existing public objects.
const fs=require('node:fs/promises'),path=require('node:path'),{randomBytes}=require('node:crypto');
process.chdir(path.resolve(__dirname,'..'));
async function main(){
 const client=await require('./db-admin.cjs')();let committed=false;
 const envFile=await fs.readFile('.env','utf8');
 if(/^AGENDA_DATABASE_URL=.+$/m.test(envFile))throw new Error('La conexión de agenda ya está configurada.');
 const secret=randomBytes(32).toString('hex');
 try {
   await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='30s'");
   const existing=(await client.query("SELECT to_regnamespace('telecus_integration') IS NOT NULL AS exists")).rows[0].exists;
   if(existing)throw new Error('El esquema de integración ya existe; requiere una actualización versionada.');
   await client.query(await fs.readFile('scripts/sql/001-agenda-integration.sql','utf8'));
   // Secret is generated locally as hex; never comes from document/model/user SQL.
   await client.query("ALTER ROLE telecus_backend WITH LOGIN PASSWORD '"+secret+"'");
   await client.query('GRANT CONNECT ON DATABASE postgres TO telecus_backend');
   const values={AGENDA_DATABASE_URL:`postgresql://telecus_backend.nyqbvpjkdfdzyktieeuf:${secret}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,AGENDA_CA_FILE:'data/supabase-ca.crt',RUN_DELIVERY_WORKER:'false'};
   let next=envFile;
   for(const [key,value]of Object.entries(values)){const pattern=new RegExp('^'+key+'=.*$','m');next=pattern.test(next)?next.replace(pattern,key+'='+value):next.trimEnd()+'\n'+key+'='+value+'\n';}
   const temporary='.env.agenda.tmp';await fs.writeFile(temporary,next,{mode:0o600});
   await client.query('COMMIT');committed=true;
   await fs.rename(temporary,'.env');
   console.log(JSON.stringify({status:'ok',migration:1,existingPublicObjects:'preserved',backendRole:'restricted',writesEnabled:false,googleWorkerEnabled:false}));
 } catch(e){console.error(JSON.stringify({status:'failed',databaseCommitted:committed,code:e.code||e.name}));process.exitCode=1;}
 finally{if(!committed)await client.query('ROLLBACK').catch(()=>{});await client.end();}
}
main().catch(()=>{console.error('No fue posible instalar la integración de agenda.');process.exitCode=1;});
