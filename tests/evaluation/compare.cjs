// Compare the same predeclared scenarios. Model-adapter and API-flow results stay separate.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const [beforeDir,afterDir]=process.argv.slice(2);
if(!beforeDir||!afterDir)throw Error('Usage: node tests/evaluation/compare.cjs BASELINE_RUN CURRENT_RUN');
const read=(dir,name)=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
const bp=read(beforeDir,'protocol.json'),ap=read(afterDir,'protocol.json'),br=read(beforeDir,'results.json'),ar=read(afterDir,'results.json');
assert.equal(br.status,'completed');assert.equal(ar.status,'completed');
const amap=new Map(ap.cases.map(c=>[c.id,c])),fmap=new Map(ap.flows.map(f=>[f.id,f]));
for(const c of bp.cases)assert.deepEqual(amap.get(c.id),c,'Changed case/oracle '+c.id);
for(const f of bp.flows)assert.deepEqual(fmap.get(f.id),f,'Changed flow/oracle '+f.id);
const ids=new Set(bp.cases.map(c=>c.id)),flows=new Set(bp.flows.map(f=>f.id));
const stats=rows=>({passed:rows.filter(r=>r.pass).length,total:rows.length});
const result={baselineRun:path.basename(beforeDir),currentRun:path.basename(afterDir),sameModelDigest:bp.model.digest===ap.model.digest,originalCasesUnchanged:true,originalFlowsUnchanged:true,
 before:{direct:stats(br.direct),flows:stats(br.flows)},
 after:{matchedDirect:stats(ar.direct.filter(r=>ids.has(r.id))),matchedFlows:stats(ar.flows.filter(r=>flows.has(r.id))),newDirect:stats(ar.direct.filter(r=>!ids.has(r.id))),newFlows:stats(ar.flows.filter(r=>!flows.has(r.id)))},
 failures:ar.direct.filter(r=>!r.pass).map(r=>({id:r.id,checks:r.checks.filter(c=>!c.pass).map(c=>c.key)})),
 stages:Object.fromEntries(Object.entries(Object.groupBy(ar.calls,c=>c.stage)).map(([k,v])=>[k,v.length]))};
fs.writeFileSync(path.join(afterDir,'comparison.json'),JSON.stringify(result,null,2));
const label=v=>v.passed+'/'+v.total+' ('+(100*v.passed/v.total).toFixed(1)+' %)';
const changeDoc=ap.version.endsWith('-v4')?'COMPRENSION_CONTEXTUAL_V4.md':ap.version.endsWith('-v3')?'COMPRENSION_CONTEXTUAL_V3.md':'COMPRENSION_CONTEXTUAL_V2.md';
const md=`# Comparación de comprensión y conversaciones

Ejecución anterior: ${result.baselineRun}. Ejecución evaluada: ${result.currentRun}. La batería anterior se conserva: este comparador verificó igualdad de casos, conversaciones y oráculos por identificador. Digest del modelo igual: **${result.sameModelDigest?'sí':'no'}**. Cambiaron el prompt, el adaptador y los controles de aplicación; no es una medición de entrenamiento o inteligencia general.

| Medida | Inicial | Versión evaluada |
|---|---|---|
| Intérprete, mismos ${result.before.direct.total} casos | ${label(result.before.direct)} | ${label(result.after.matchedDirect)} |
| API, mismos ${result.before.flows.total} flujos | ${label(result.before.flows)} | ${label(result.after.matchedFlows)} |
| Intérprete, ${result.after.newDirect.total} casos añadidos | — | ${label(result.after.newDirect)} |
| API, ${result.after.newFlows.total} flujos añadidos | — | ${label(result.after.newFlows)} |

El componente de interpretación puede usar comprensión reducida de actos, señales lingüísticas y conversiones de hora deterministas. Por tanto, la primera fila compara la salida de ese componente en dos implementaciones; no representa exclusivamente etiquetas crudas del mismo prompt. Los flujos API pasan también por el estado y los controles de negocio. Las variantes añadidas son diagnósticas y algunas se usaron en pruebas preliminares, no constituyen un holdout independiente.

Permanecen estos fallos en los casos directos: ${result.failures.map(r=>r.id+' ('+r.checks.join(', ')+')').join('; ')||'ninguno'}. Se conservan en el informe; no se sustituyen por el resultado de las reglas posteriores.

Llamadas por etapa: ${Object.entries(result.stages).map(([k,n])=>k+'='+n).join(', ')}. Las llamadas crudas y la salida normalizada por caso están en [results.json](results.json). No todos los casos directos llaman al modelo: algunas consultas de formato y negativas de propuesta se resuelven con controles del backend. Una inferencia de campo usa 180 tokens de salida como máximo; la clasificación general conserva 350. other puede provocar una segunda llamada bajo el mismo plazo de espera.

[Informe completo y límites](REPORT.md), [comparación calculada](comparison.json) y [cambios y responsabilidades](../../../integration/${changeDoc}).

La integración usa datos ficticios en memoria, funciones de Node-RED en VM y el modelo local real. No incluye motor Node-RED, navegador, Google, Supabase, carga de 100–400 usuarios ni revisión humana de usabilidad. No demuestra preparación integral para producción.
`;
fs.writeFileSync(path.join(afterDir,'COMPARACION.md'),md);console.log(JSON.stringify(result));
