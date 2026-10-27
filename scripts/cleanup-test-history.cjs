// Offline maintenance only: explicit account and codes; caller owns the transaction.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
async function plan(client,email,codes){
 if(!email||!codes.length||new Set(codes).size!==codes.length||codes.some(c=>!/^TCUS-\d{4}-[A-Z0-9]+$/.test(c)))throw Error('Invalid scope');
 const appointments=(await client.query(`SELECT a.* FROM public.appointments a JOIN public.profiles p ON p.id=a.patient_id
  WHERE lower(p.email)=lower($1) AND p.role='PATIENT' AND a.code=ANY($2) ORDER BY a.id FOR UPDATE OF a`,[email,codes])).rows;
 if(appointments.length!==codes.length||appointments.some(a=>!['CANCELLED','COMPLETED'].includes(a.status)||a.payment_status==='PENDING'))throw Error('Scope changed');
 const ids=appointments.map(a=>a.id);
 const requests=(await client.query('SELECT * FROM public.appointment_change_requests WHERE appointment_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids])).rows;
 const deliveries=(await client.query('SELECT * FROM telecus_integration.deliveries WHERE appointment_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids])).rows;
 if(requests.some(r=>r.status==='PENDING')||deliveries.some(d=>d.status!=='done'))throw Error('Unfinished work');
 const logs=(await client.query('SELECT * FROM public.appointment_logs WHERE appointment_id=ANY($1::uuid[]) FOR UPDATE',[ids])).rows;
 const events=(await client.query("SELECT * FROM telecus_integration.notification_events WHERE payload->>'code'=ANY($1) ORDER BY id FOR UPDATE",[codes])).rows;
 const notifications=(await client.query('SELECT * FROM telecus_integration.notifications WHERE event_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE',[events.map(e=>e.id)])).rows;
 // Reject unknown referencing tables rather than allowing unexpected cascades.
 const expected=new Set([
  'public.appointment_change_requests>public.appointments','public.appointment_logs>public.appointments',
  'telecus_integration.deliveries>public.appointments','telecus_integration.deliveries>public.appointment_change_requests',
  'telecus_integration.notifications>telecus_integration.notification_events'
 ]);
 const refs=(await client.query(`SELECT sn.nspname||'.'||s.relname AS source,tn.nspname||'.'||t.relname AS target FROM pg_constraint k
  JOIN pg_class s ON s.oid=k.conrelid JOIN pg_namespace sn ON sn.oid=s.relnamespace
  JOIN pg_class t ON t.oid=k.confrelid JOIN pg_namespace tn ON tn.oid=t.relnamespace
  WHERE k.contype='f' AND k.confrelid=ANY($1::regclass[])`,[['public.appointments','public.appointment_change_requests','public.appointment_logs','telecus_integration.deliveries','telecus_integration.notification_events','telecus_integration.notifications']])).rows;
 if(refs.some(r=>!expected.has(r.source+'>'+r.target)))throw Error('Unknown references');
 const deleteTriggers=await client.query(`SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND (tgtype::int & 8)=8 AND tgrelid=ANY($1::regclass[])`,[['public.appointments','public.appointment_change_requests','public.appointment_logs','telecus_integration.deliveries','telecus_integration.notification_events','telecus_integration.notifications']]);
 if(deleteTriggers.rowCount)throw Error('Unknown delete trigger');
 return {format:'telecus-test-history-v1',createdAt:new Date().toISOString(),appointments,requests,deliveries,logs,events,notifications};
}
function counts(snapshot){return Object.fromEntries(['appointments','requests','deliveries','logs','events','notifications'].map(k=>[k,snapshot[k].length]));}
function seal(snapshot,secret){
 if(!secret||secret.length<16)throw Error('Missing backup key');
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update(secret).digest(),iv);
 const content=Buffer.concat([cipher.update(JSON.stringify(snapshot),'utf8'),cipher.final()]);
 return JSON.stringify({format:'telecus-test-history-encrypted-v1',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),content:content.toString('base64')});
}
function unseal(encrypted,secret){
 const envelope=JSON.parse(encrypted);if(envelope.format!=='telecus-test-history-encrypted-v1')throw Error('Invalid backup');
 const decipher=crypto.createDecipheriv('aes-256-gcm',crypto.createHash('sha256').update(secret).digest(),Buffer.from(envelope.iv,'base64'));
 decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
 return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.content,'base64')),decipher.final()]).toString('utf8'));
}
async function backup(snapshot,secret){
 const directory=path.resolve(__dirname,'../data/maintenance-backups');await fs.mkdir(directory,{recursive:true});
 const file=path.join(directory,'test-history-'+crypto.randomUUID()+'.enc');const encrypted=seal(snapshot,secret);
 const handle=await fs.open(file,'wx',0o600);
 try{await handle.writeFile(encrypted,'utf8');await handle.sync();}finally{await handle.close();}
 if(JSON.stringify(unseal(await fs.readFile(file,'utf8'),secret))!==JSON.stringify(snapshot))throw Error('Backup verification failed');
 return file;
}
async function remove(client,snapshot,saveBackup){
 if(typeof saveBackup!=='function')throw Error('Backup required');
 const backupFile=await saveBackup(snapshot);if(!backupFile)throw Error('Backup required');
 const eventIds=snapshot.events.map(e=>e.id),ids=snapshot.appointments.map(a=>a.id);
 for(const [sql,args,n] of [
  ['DELETE FROM telecus_integration.notifications WHERE event_id=ANY($1::bigint[])',[eventIds],snapshot.notifications.length],
  ['DELETE FROM telecus_integration.notification_events WHERE id=ANY($1::bigint[])',[eventIds],snapshot.events.length],
  ['DELETE FROM telecus_integration.deliveries WHERE appointment_id=ANY($1::uuid[])',[ids],snapshot.deliveries.length],
  ['DELETE FROM public.appointments WHERE id=ANY($1::uuid[])',[ids],snapshot.appointments.length]
 ]){const result=await client.query(sql,args);if(result.rowCount!==n)throw Error('Rows changed');}
 // Keep operations/idempotency records: old job IDs must never replay side effects.
 return {removed:counts(snapshot),backupFile};
}
module.exports={plan,counts,seal,unseal,backup,remove};
if(require.main===module){
 require('./runtime-env.cjs')();
 async function main(){
  const [flag,email,...codes]=process.argv.slice(2);if(!['--preview','--apply'].includes(flag))throw Error('Explicit mode required');
  let credential=await require('./read-secret.cjs')('Credencial de mantenimiento (oculta): ');
  const client=await require('./db-admin.cjs')(credential);credential='';
  try{
   await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await client.query("SET LOCAL statement_timeout='20s'");await client.query("SET LOCAL lock_timeout='5s'");
   const snapshot=await plan(client,email,codes);
   if(flag==='--preview'){console.log(JSON.stringify({eligibleCodes:snapshot.appointments.map(a=>a.code),counts:counts(snapshot),writes:0}));await client.query('ROLLBACK');return;}
   const result=await remove(client,snapshot,s=>backup(s,process.env.DEMO_SESSION_SECRET));
   await client.query('COMMIT');console.log(JSON.stringify({status:'committed',...result,calendarCalls:0,emailsSent:0}));
  }finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
 }
 main().then(()=>process.exit(0)).catch(()=>{console.error('Limpieza abortada: no se confirmó ningún borrado. Revisa el alcance, los estados y la copia cifrada.');process.exit(1);});
}
