const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('el contrato compacto omite datos vacíos y el adaptador conserva el contrato normalizado',()=>{
 const flow=JSON.parse(fs.readFileSync('node-red/flows.json','utf8'));const fn=id=>vm.runInNewContext('(function(msg){'+flow.find(n=>n.id===id).func+'})',{env:{get:k=>k==='TELECUS_INTERNAL_TOKEN'?'synthetic':undefined}});
 const prepare=fn('prepare'),parse=fn('parse'),raw=prepare({req:{headers:{'x-telecus-internal':'synthetic'}},payload:{message:'Texto ficticio',context:{role:'PATIENT'}}})[0].payload;
 assert.deepEqual([...raw.format.required],['intent','dialogue_act']);assert.ok(raw.messages[0].content.length<3500);
 const general=parse({statusCode:200,payload:{message:{content:JSON.stringify({intent:'greeting',dialogue_act:'social'})}}});assert.equal(general.statusCode,200);assert.equal(general.payload.intent,'greeting');for(const k of ['appointment_code','doctor_name','date','time','reason','request_id'])assert.equal(general.payload[k],null);
 const field=parse({statusCode:200,payload:{message:{content:JSON.stringify({act:'refuse',target:'reason'})}}});assert.equal(field.statusCode,200);assert.equal(field.payload.field_understanding.value,null);
 assert.equal(parse({statusCode:200,payload:{message:{content:'{invalid'}}}).statusCode,502);
});
