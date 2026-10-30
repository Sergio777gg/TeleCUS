const fs=require('node:fs'),path=require('node:path');
require('./runtime-env.cjs')();
(async()=>{
 if(process.env.DATA_MODE!=='supabase-readonly'||process.env.RUN_DELIVERY_WORKER==='true')throw Error('readonly-config');
 const {Pool}=require('pg'),uri=new URL(process.env.AGENDA_DATABASE_URL);
 const pool=new Pool({host:process.env.AGENDA_DATABASE_ADDRESS||uri.hostname,port:Number(uri.port||5432),
  user:decodeURIComponent(uri.username),password:decodeURIComponent(uri.password),database:uri.pathname.slice(1),
  ssl:{rejectUnauthorized:true,servername:uri.hostname,ca:fs.readFileSync(process.env.AGENDA_CA_FILE,'utf8')},
  max:1,connectionTimeoutMillis:10000,statement_timeout:10000});
 try{
  const client=await pool.connect();
  try{
   await client.query('BEGIN READ ONLY');
   const {rows}=await client.query("SELECT current_setting('transaction_read_only') AS readonly");
   if(rows[0]?.readonly!=='on')throw Error('readonly-not-active');
   await client.query('ROLLBACK');
  }finally{client.release();}
  const {PostgresAgenda}=await import('../apps/backend/dist/integrations/agenda.js');
  const agenda=new PostgresAgenda(process.env.AGENDA_DATABASE_URL,process.env.AGENDA_CA_FILE,process.env.AGENDA_DATABASE_ADDRESS,undefined,true);
  try{
   await agenda.ready();
   console.log(JSON.stringify({status:'ok',mode:'supabase-readonly',postgresTransactionReadOnly:true,metadataOnly:true,deliveries:false}));
  }finally{await agenda.close();}
 }finally{await pool.end();}
})().catch(()=>{console.error('No se pudo verificar agenda en solo lectura. Revisa configuraci�n, certificado y migraciones compatibles. Valores privados ocultos.');process.exitCode=1;});
