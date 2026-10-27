const {test}=require('node:test'),assert=require('node:assert/strict');
test('consultas usan filtros de negocio; explicaciones y acciones no se convierten en listados',async()=>{
 const {requestQuery,resolveInterpretation,emptyIntent}=await import('../apps/backend/dist/conversation.js');
 for(const message of ['¿Cómo revisar las solicitudes?','Cómo aprobar una solicitud','Aprueba la solicitud 1','Rechaza la solicitud','Confirmo la solicitud 4'])assert.equal(requestQuery(message,'ADMIN'),null);
 for(const role of ['PATIENT','ADMIN']){
  assert.equal(requestQuery('Ver solicitudes pendientes',role).request_view,'pending');
  assert.equal(requestQuery('Hay solicitudes no revisadas?',role).request_view,'pending');
  assert.equal(requestQuery('Hay solicitudes por aprobar?',role).request_view,'pending');
  assert.equal(requestQuery('Ver historial completo de solicitudes',role).request_view,'all');
  assert.equal(requestQuery('Consultar solicitudes ya revisadas de reprogramación',role).request_type,'RESCHEDULE');
  const corrected=resolveInterpretation('Hay solicitudes de cambios?',emptyIntent('list_appointments',{request_id:'inventado',reference_index:4}),{role});
  assert.equal(corrected.request_id,null);assert.equal(corrected.reference_index,null);
 }
});
test('bandeja prioriza pendientes y limita el historial conservando referencias y orden temporal',async()=>{
 const {requestList}=await import('../apps/backend/dist/application/change-requests.js'),{emptyIntent}=await import('../apps/backend/dist/conversation.js');
 const record=(id,status,created_at)=>({id,appointment_id:id,patient_id:'patient',request_type:'CANCEL',status,created_at});
 const old=Array.from({length:25},(_,i)=>record('old-'+i,'APPROVED','2026-10-09T14:00:00Z'));
 const result=requestList([...old,record('pending-old','PENDING','2026-10-08T14:00:00Z'),record('pending-new','PENDING','2026-10-10T14:00:00Z')],emptyIntent('request_status',{request_view:'all'}),'ADMIN');
 assert.equal(result.shown.length,20);assert.deepEqual(result.shown.slice(0,2).map(c=>c.id),['pending-new','pending-old']);
 assert.match(result.text,/3\. Cancelación/);assert.match(result.text,/hasta 20 solicitudes/);assert.match(result.text,/Solicitada el:/);
});
