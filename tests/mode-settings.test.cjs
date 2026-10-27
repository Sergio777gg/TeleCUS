const {test}=require('node:test'),assert=require('node:assert/strict'),modeSettings=require('../scripts/mode-settings.cjs');
test('modo real habilita entregas aunque falte el ajuste y prueba las deshabilita al cambiar de modo',()=>{
 const original='DATA_MODE=demo\nSQLITE_FILE=data/fixture.sqlite\nOTHER_SETTING=preserved\n';
 const real=modeSettings(original,'supabase-live');assert.match(real,/RUN_DELIVERY_WORKER=true/);assert.match(real,/OTHER_SETTING=preserved/);
 const demo=modeSettings(real,'demo');assert.match(demo,/RUN_DELIVERY_WORKER=false/);assert.match(demo,/DATA_MODE=demo/);assert.doesNotMatch(demo,/DATA_MODE=supabase-live/);
 const readonly=modeSettings(real,'supabase-readonly');assert.match(readonly,/RUN_DELIVERY_WORKER=false/);
 assert.throws(()=>modeSettings(original,'invalid'));
});
test('ajustes duplicados no pueden dejar habilitadas entregas reales en pruebas',()=>{
 const result=modeSettings('DATA_MODE=supabase-live\nRUN_DELIVERY_WORKER=true\nDATA_MODE=demo\nRUN_DELIVERY_WORKER=true\n','demo');
 assert.equal((result.match(/DATA_MODE=/g)||[]).length,1);assert.equal((result.match(/RUN_DELIVERY_WORKER=/g)||[]).length,1);assert.match(result,/RUN_DELIVERY_WORKER=false/);
});
