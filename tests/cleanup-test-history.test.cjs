const {test}=require('node:test'),assert=require('node:assert/strict');
const {seal,unseal,remove}=require('../scripts/cleanup-test-history.cjs');
test('maintenance backup authenticates its content and key',()=>{
 const key='fictitious-backup-key-only-for-tests',snapshot={appointments:[{code:'TCUS-2099-ABCDEF'}],requests:[]};
 const encrypted=seal(snapshot,key);assert.deepEqual(unseal(encrypted,key),snapshot);
 assert.ok(!encrypted.includes('TCUS-2099-ABCDEF'));assert.throws(()=>unseal(encrypted,key+'wrong'));
 const corrupt=JSON.parse(encrypted);corrupt.content=Buffer.from('altered').toString('base64');assert.throws(()=>unseal(JSON.stringify(corrupt),key));
 assert.throws(()=>seal(snapshot,''));
});
test('maintenance never deletes when backup fails',async()=>{
 let queries=0;const client={query:async()=>{queries++;}};
 await assert.rejects(remove(client,{},async()=>{throw Error('backup unavailable');}));assert.equal(queries,0);
 await assert.rejects(remove(client,{},undefined));assert.equal(queries,0);
});
