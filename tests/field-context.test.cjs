const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

test('el motivo se clasifica sin heredar actos del historial libre; otros campos conservan contexto acotado',()=>{
 const flow=JSON.parse(fs.readFileSync('node-red/flows.json','utf8')).find(n=>n.id==='prepare');
 const prepare=vm.runInNewContext('(function(msg){'+flow.func+'})',{env:{get:n=>n==='TELECUS_INTERNAL_TOKEN'?'test-token':undefined}});
 const history=[{user:'Primer turno',assistant:'Primera respuesta'},{user:'No canceles, solo estoy preguntando',assistant:'¿Quieres hacer una pregunta o indicar el motivo?'},{user:'Interrupción anterior',assistant:'Texto que no debe definir el acto actual'}];
 const run=slot=>prepare({req:{headers:{'x-telecus-internal':'test-token'}},payload:{stage:'field',message:'Revisión periódica',normalizedMessage:'revision periodica',context:{draft:{intent:'reserve'},dialogue:{activeTask:'reserve',expectedSlot:slot,lastQuestion:'Pregunta del campo actual',refusedField:slot==='reason'?'reason':null,recentTurns:history}}}})[0].payload;
 const reason=JSON.parse(run('reason').messages[1].content);
 assert.equal(reason.MENSAJE,'Revisión periódica');assert.equal(reason.field,'reason');assert.equal(reason.refusedField,'reason');assert.equal(reason.question,'Pregunta del campo actual');assert.deepEqual(reason.recentTurns,[]);
 const date=JSON.parse(run('date').messages[1].content);assert.deepEqual(date.recentTurns,history.slice(-2));
});
