// Called inside the operator's transaction; eligibility is checked and locked in PostgreSQL.
module.exports=async function recoverPayment(client,code){
 const {rows}=await client.query(`SELECT d.id,d.actor_id,d.operation_id,a.id AS appointment_id
  FROM telecus_integration.deliveries d JOIN public.appointments a ON a.id=d.appointment_id
  JOIN public.profiles actor ON actor.id=d.actor_id AND actor.active AND actor.role=d.actor_role AND actor.role='ADMIN'
  WHERE a.code=$1 AND a.status='PRE_RESERVED' AND a.payment_status='PENDING' AND a.start_time>now()
   AND a.updated_at=d.expected_updated_at AND d.operation='confirm' AND d.stage='calendar' AND d.status='review'
   AND d.last_error IN ('calendar_failed','calendar_retry_limit')
   AND telecus_integration.slot_free(a.doctor_id,a.start_time,a.end_time,a.id)
  FOR UPDATE OF d,a`,[code]);
 if(rows.length!==1)return {recovered:false,reason:'No hay una entrega de pago elegible; consulta su estado actual.',newOperations:0};
 const row=rows[0];
 await client.query("UPDATE telecus_integration.deliveries SET status='queued',attempts=0,available_at=now(),last_error=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[row.id]);
 await client.query("INSERT INTO public.appointment_logs(appointment_id,actor_user_id,action,details) VALUES($1,$2,'verify_payment_RETRY_QUEUED',$3)",[row.appointment_id,row.actor_id,JSON.stringify({operation_id:row.operation_id,source:'telecus',reason:'google_authorization_restored'})]);
 return {recovered:true,sameDelivery:true,newOperations:0,stage:'calendar'};
};
