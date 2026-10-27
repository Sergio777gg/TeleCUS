const fs=require('node:fs'),path=require('node:path');process.chdir(path.resolve(__dirname,'..'));
const mode=process.argv[2];if(!['demo','supabase-readonly','supabase-live'].includes(mode))throw Error('Modo inválido.');
require('./configure.cjs');require('./stop.cjs')();require('./sync-flow.cjs');
const settings=require('./mode-settings.cjs')(fs.readFileSync('.env','utf8'),mode);fs.writeFileSync('.env',settings);
process.env.DATA_MODE=mode;process.env.RUN_DELIVERY_WORKER=mode==='supabase-live'?'true':'false';
require('./start.cjs');
