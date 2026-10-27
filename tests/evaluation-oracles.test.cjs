const {test}=require('node:test'),assert=require('node:assert/strict');
const {schemaErrors,score,percentile}=require('./evaluation/oracles.cjs');
const corpus=require('./evaluation/cases-v1.cjs');
test('el corpus de evaluación es identificable y tiene oráculos previos para MFT, INV, DIR y flujos',()=>{
 assert.equal(corpus.cases.length,52);assert.equal(corpus.flows.length,15);
 assert.equal(new Set(corpus.cases.map(c=>c.id)).size,52);
 for(const type of ['MFT','INV','DIR'])assert.ok(corpus.cases.some(c=>c.type===type));
 for(const c of corpus.cases)assert.ok(Object.keys(c.expect).length);
 for(const type of ['INV','DIR']){
  const groups=Object.groupBy(corpus.cases.filter(c=>c.type===type),c=>c.pair);for(const pair of Object.values(groups))assert.equal(pair.length,2);
 }
});
test('los oráculos detectan campos equivocados, ambigüedad ignorada y JSON fuera de contrato',()=>{
 assert.ok(score({intent:'reschedule',time:'14:30'},{intent:['reschedule'],fields:{time:'14:30'}}).every(c=>c.pass));
 assert.ok(score({intent:'reserve',reason:'Prefiero no decirlo'},{fields:{reason:null}}).some(c=>!c.pass));
 assert.ok(score({intent:'reschedule',dialogue_act:'answer'},{clarify:true}).some(c=>!c.pass));
 assert.ok(score({intent:'reschedule'},{date:'2026-10-19'},'2026-10-26').some(c=>!c.pass));
 const schema={required:['intent'],additionalProperties:false,properties:{intent:{type:'string',enum:['unknown']}}};
 assert.deepEqual(schemaErrors({intent:'unknown'},schema),[]);assert.ok(schemaErrors({intent:'reserve',token:'invented'},schema).length===2);
 assert.ok(schemaErrors({},schema).includes('missing:intent'));assert.ok(schemaErrors(null,schema).includes('not_object'));
 assert.equal(percentile([1,5,10,15],.95),15);assert.equal(percentile([], .5),null);
});
