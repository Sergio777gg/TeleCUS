// CLI helpers accept an inherited environment (e.g. node --env-file on a server).
// The existing local .env remains optional; no configuration values are printed.
const fs=require('node:fs'),path=require('node:path');
module.exports=function loadRuntimeEnvironment(){
 const root=path.resolve(__dirname,'..');process.chdir(root);
 if(fs.existsSync('.env'))process.loadEnvFile('.env');
 return root;
};
