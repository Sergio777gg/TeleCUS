// Recover the already authorized Calendar delivery. No new verification or mail retry.
require('./runtime-env.cjs')();
const {execFileSync}=require('node:child_process');
async function main(){
 const code=process.argv[2];if(!/^TCUS-[A-Z0-9]+-[A-Z0-9]+$/.test(code||''))throw Error('Indica el código de la cita.');
 const health=await(await fetch('http://127.0.0.1:5173/api/healthz',{signal:AbortSignal.timeout(5000)})).json();
 if(health.mode!=='supabase-live'||!health.deliveryWorker)throw Error('Reinicia TeleCUS en modo real antes de recuperar la entrega.');
 try{execFileSync(process.execPath,['scripts/check-google.cjs'],{stdio:'pipe',windowsHide:true});}catch{throw Error('Primero renueva la conexión de Google.');}
 let credential=await require('./read-secret.cjs')('Credencial de recuperación (oculta): ');
 const client=await require('./db-admin.cjs')(credential);credential='';
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='10s'");
  const result=await require('./payment-recovery.cjs')(client,code);
  await client.query('COMMIT');console.log(JSON.stringify(result));
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{await client.end();}
}
main().then(()=>process.exit(0)).catch(error=>{console.error(['Reinicia TeleCUS en modo real antes de recuperar la entrega.','Primero renueva la conexión de Google.'].includes(error.message)?error.message:'No se pudo recuperar la entrega; no se creó otra operación de pago.');process.exit(1);});
