// Verify housekeeping-free GET functions and restricted-role calls in a rollback trial.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
process.chdir(path.resolve(__dirname,'..'));
async function main(){const client=await require('./db-admin.cjs')();let checks=0;const q=(s,a=[])=>client.query(s,a);try{
 await q('BEGIN');await q(await fs.readFile('scripts/sql/008-read-only-queries.sql','utf8'));
 // A read-only subtransaction would inherit the write state, so verify function bodies and
 // execute them as restricted backend with a catalog-backed read-only guard on their SQL path.
 for(const name of ['availability','list_payment_receipts','administration_read']){const text=(await q('SELECT pg_get_functiondef(p.oid) AS body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=$2',['telecus_integration',name])).rows[0].body;assert.equal(/expire_holds/.test(text),false);checks++;}
 const users={};for(const role of ['PATIENT','ADMIN','DOCTOR']){const id=crypto.randomUUID();users[role]=id;await q("INSERT INTO auth.users(id,email,created_at,email_confirmed_at,raw_user_meta_data) VALUES($1,$2,now(),now(),'{}')",[id,'query-'+id+'@example.test']);await q('UPDATE public.profiles SET role=$1,active=true WHERE id=$2',[role,id]);}
 await q('GRANT telecus_backend TO postgres');await q('SET LOCAL ROLE telecus_backend');
 const calls=[['availability',[users.PATIENT,users.DOCTOR,'2099-10-19']],['list_payment_receipts',[users.PATIENT]],['administration_read',[users.ADMIN,'payments','{}']]];
 for(const [name,args]of calls){await q('SELECT telecus_integration.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+')',args);checks++;}
 await q('RESET ROLE');await q('ROLLBACK');console.log(JSON.stringify({status:'ok',checks,fixtures:'rolled_back',googleCalls:0,inferenceCalls:0}));
 }catch(e){await q('ROLLBACK').catch(()=>{});console.error(JSON.stringify({status:'failed',code:e.code||e.name,checks}));process.exitCode=1;}finally{await client.end();}}
main().catch(e=>{console.error(JSON.stringify({status:'setup_failed',code:e.code||e.name}));process.exitCode=1;});
