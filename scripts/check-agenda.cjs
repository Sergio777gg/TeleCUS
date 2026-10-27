require('./runtime-env.cjs')();
async function main(){const {PostgresAgenda}=await import('../apps/backend/dist/integrations/agenda.js');
 const agenda=new PostgresAgenda(process.env.AGENDA_DATABASE_URL,process.env.AGENDA_CA_FILE,process.env.TELECUS_DATABASE_ADDRESS);
 try{await agenda.ready();console.log(JSON.stringify({status:'ok',connection:'restricted_backend',agendaVersion:1,notificationsVersion:2}));}finally{await agenda.close();}}
main().catch(()=>{console.error('No fue posible verificar la conexión restringida de agenda.');process.exitCode=1;});
