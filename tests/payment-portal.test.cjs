const {test}=require('node:test'),assert=require('node:assert/strict');

test('una pre-reserva usa SIREC y descarta enlaces y estados de pago aportados por el cliente',async()=>{
 const {PostgresAgenda}=await import('../apps/backend/dist/integrations/agenda.js');
 // Exercise the adapter boundary without connecting to Postgres or reading credentials.
 const agenda=Object.create(PostgresAgenda.prototype),calls=[];
 agenda.call=async(name,args)=>{calls.push({name,args});return 'Prueba';};
 const patient={id:'patient-test',role:'PATIENT'};
 await agenda.execute(patient,'proposal-test','reserve',{doctor_id:'doctor-test',date:'2026-10-19',time:'14:00',reason:'Consulta general',payment_link:'https://untrusted.example.test/',payment_status:'VERIFIED',patient_id:'another-patient'});
 assert.equal(calls[0].name,'execute');assert.equal(calls[0].args[0],patient.id);
 const payload=JSON.parse(calls[0].args[3]);
 assert.equal(payload.payment_link,'https://pagosonline.sirec.unicauca.edu.co/');
 assert.equal(payload.payment_status,undefined);assert.equal(payload.patient_id,undefined);
 await agenda.execute(patient,'another-proposal','cancel',{appointment_code:'TCUS-TEST',payment_link:'https://untrusted.example.test/'});
 assert.deepEqual(JSON.parse(calls[1].args[3]),{appointment_code:'TCUS-TEST'});
});

test('la configuración pública ofrece el pago externo solo en modo real habilitado',async()=>{
 const {Runtime}=await import('../apps/backend/dist/runtime.js');
 for(const mode of ['demo','supabase-readonly','supabase-live']){
  const runtime=Object.create(Runtime.prototype);
  runtime.cfg={mode,supabaseUrl:'https://example.supabase.co',supabaseKey:'public-test-key'};
  const {paymentPortal}=runtime.configuration();
  assert.equal(paymentPortal.provider,'SIREC');
  assert.equal(paymentPortal.url,mode==='supabase-live'?'https://pagosonline.sirec.unicauca.edu.co/':null);
 }
});
