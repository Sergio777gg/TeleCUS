const {test}=require('node:test'),assert=require('node:assert/strict');
test('las capas respetan sus contratos, sin dependencias circulares ni SQL en conversación, avisos o controladores',()=>{
  const {validateArchitecture}=require('../scripts/check-architecture.cjs');
  assert.ok(validateArchitecture().files>30);
});
