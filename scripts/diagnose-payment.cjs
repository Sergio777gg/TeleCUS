// One supplied appointment only; read-only transaction and operational flags only.
require('./runtime-env.cjs')();
async function main(){
 const code=process.argv[2];if(!/^TCUS-[A-Z0-9]+-[A-Z0-9]+$/.test(code||''))throw Error('Indica el código de la cita.');
 let credential=await require('./read-secret.cjs')('Credencial de diagnóstico (oculta): ');
 const client=await require('./db-admin.cjs')(credential);credential='';
 try{
  await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='10s'");
  const result=await client.query(`SELECT a.status,a.payment_status,a.start_time>now() AS future_slot,
   (COALESCE(a.calendar_event_id,'')<>'' AND COALESCE(a.meet_url,'') LIKE 'https://meet.google.com/%') AS calendar_linked,
   (SELECT count(*)::int FROM telecus_integration.deliveries d WHERE d.appointment_id=a.id AND d.operation='confirm') AS confirmation_deliveries,
   COALESCE((SELECT bool_or(d.stage='mail' AND d.status='done' AND d.message_id IS NOT NULL) FROM telecus_integration.deliveries d WHERE d.appointment_id=a.id AND d.operation='confirm'),false) AS confirmation_mail_completed,
   EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=a.doctor_id AND p.role='DOCTOR' AND p.active) AS active_doctor,
   EXISTS(SELECT 1 FROM public.appointments other WHERE other.id<>a.id AND other.doctor_id=a.doctor_id
    AND other.status IN ('PRE_RESERVED','CONFIRMED','RESCHEDULED') AND other.start_time<a.end_time AND other.end_time>a.start_time) AS overlapping_appointment,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('stage',d.stage,'status',d.status,'operation',d.operation,'error',
    CASE WHEN d.last_error IN ('calendar_failed','mail_delivery_uncertain','actor_access_changed','agenda_changed_after_calendar','calendar_retry_limit') THEN d.last_error ELSE NULL END,'attempts',d.attempts))
    FROM telecus_integration.deliveries d WHERE d.appointment_id=a.id AND d.status<>'done'),'[]'::jsonb) AS pending_deliveries
   FROM public.appointments a WHERE a.code=$1`,[code]);
  console.log(JSON.stringify({found:result.rows.length===1,diagnosis:result.rows[0]||null,writes:0}));
 }finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
}
main().then(()=>process.exit(0)).catch(()=>{console.error('No se pudo completar el diagnóstico de solo lectura.');process.exit(1);});
