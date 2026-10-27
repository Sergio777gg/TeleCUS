// Inventory only. Scope is the patient test account explicitly supplied by the user.
require('./runtime-env.cjs')();
async function main(){
 const email=process.argv[2];if(!email||!/^[^\s@]+@[^\s@]+$/.test(email))throw Error('Indica la cuenta de prueba.');
 let credential=await require('./read-secret.cjs')('Credencial de inventario (oculta): ');
 const client=await require('./db-admin.cjs')(credential);credential='';
 try{
  await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='10s'");
  const rows=(await client.query(`SELECT a.code,a.status,a.payment_status,
   EXISTS(SELECT 1 FROM telecus_integration.deliveries d WHERE d.appointment_id=a.id AND d.status<>'done') AS unfinished_delivery,
   EXISTS(SELECT 1 FROM public.appointment_change_requests r WHERE r.appointment_id=a.id AND r.status='PENDING') AS pending_change,
   COALESCE(a.calendar_event_id,'')<>'' AS linked_calendar,
   (SELECT count(*)::int FROM public.appointment_change_requests r WHERE r.appointment_id=a.id AND r.status<>'PENDING') AS reviewed_requests
   FROM public.appointments a JOIN public.profiles p ON p.id=a.patient_id
   WHERE lower(p.email)=lower($1) ORDER BY a.start_time`,[email])).rows;
  const safe=rows.filter(a=>['CANCELLED','COMPLETED'].includes(a.status)&&!a.unfinished_delivery&&!a.pending_change);
  const reviewed=(await client.query(`SELECT r.status,count(*)::int AS count FROM public.appointment_change_requests r
   JOIN public.profiles p ON p.id=r.patient_id WHERE lower(p.email)=lower($1) GROUP BY r.status`,[email])).rows;
  const references=(await client.query(`SELECT conrelid::regclass::text AS table_name,pg_get_constraintdef(oid) AS constraint_definition
   FROM pg_constraint WHERE contype='f' AND confrelid IN ('public.appointments'::regclass,'public.appointment_change_requests'::regclass) ORDER BY conrelid::regclass::text`)).rows;
  console.log(JSON.stringify({appointments:rows,closedEligible:safe.map(a=>a.code),requests:reviewed,references,writes:0}));
 }finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
}
main().then(()=>process.exit(0)).catch(()=>{console.error('No se pudo completar el inventario de solo lectura.');process.exit(1);});
