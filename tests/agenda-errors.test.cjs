const {test}=require('node:test'),assert=require('node:assert/strict');
test('conflictos distinguen entrega pendiente de solapamiento sin revelar errores SQL arbitrarios',async()=>{
 const {agendaConflict}=await import('../apps/backend/dist/application/agenda-errors.js');
 assert.match(agendaConflict('P0002','Appointment changed or delivery pending'),/sincronización pendiente/);
 assert.match(agendaConflict('23P01','Slot taken'),/horario está ocupado/);
 assert.match(agendaConflict('P0002','Request changed'),/solicitud ya fue revisada/);
 assert.doesNotMatch(agendaConflict('23505','private@example.test'),/private@example/);
});
