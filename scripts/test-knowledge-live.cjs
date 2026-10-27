const path=require('node:path'),assert=require('node:assert/strict');process.chdir(path.resolve(__dirname,'..'));process.loadEnvFile('.env');
async function main(){const {KnowledgeIndex,LocalKnowledge}=await import('../apps/backend/dist/knowledge.js');
 const rag=new LocalKnowledge(new KnowledgeIndex('knowledge/telecus'),process.env.INFERENCE_URL.replace(/\/interpret$/,'/answer'),process.env.TELECUS_INTERNAL_TOKEN);
 const answer=await rag.answer('¿Cuál es el horario del piloto y cuánto dura una cita?','PATIENT');
 assert.match(answer,/lunes/i);assert.match(answer,/30/);assert.match(answer,/Fuentes:/);
 const deadline=await rag.answer('¿Cuántos días tengo para pagar la pre-reserva?','PATIENT');
 assert.match(deadline,/administrativ|no.*defin|no.*disponib|confirmad/i);
 console.log(JSON.stringify({status:'ok',corpus:'2026-09-20',model:process.env.TELECUS_AI_MODEL,checked:['horario','duracion','fuentes','plazo_no_inventado']}));}
main().catch(e=>{console.error('No se verificó la respuesta del RAG: '+e.message);process.exitCode=1;});
