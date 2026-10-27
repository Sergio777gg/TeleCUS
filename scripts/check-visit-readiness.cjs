// Loads runtime configuration internally; prints capability booleans only, never credentials or rows.
const path=require('node:path');process.chdir(path.resolve(__dirname,'..'));
async function main(){
 process.loadEnvFile('.env');const {PostgresAgenda}=await import('../apps/backend/dist/integrations/agenda.js'),{config}=await import('../apps/backend/dist/config.js');const cfg=config();
 if(!cfg.agendaUrl){console.log(JSON.stringify({status:'missing_agenda_connection'}));return;}
 const agenda=new PostgresAgenda(cfg.agendaUrl,cfg.agendaCaFile,cfg.agendaAddress);
 try{await agenda.ready();console.log(JSON.stringify({status:'ok',typedVisits:agenda.visitsAvailable,clinicalDocuments:await agenda.call('clinical_documents_version')===1&&await agenda.call('clinical_document_list_version')===1,patientWorkspace:await agenda.call('patient_workspace_version')===1,credentialsPrinted:false}));}
 catch(e){console.error(JSON.stringify({status:'unavailable',code:e.code||e.getStatus?.()||'connection_failed'}));process.exitCode=1;}finally{await agenda.close();}
}
main().catch(()=>{console.error(JSON.stringify({status:'configuration_unavailable'}));process.exitCode=1;});
