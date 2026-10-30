const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {parseEnv}=require('node:util');
let url;
try{url=new URL(process.argv[2]);}catch{throw Error('Indica la URL HTTPS del tunel.');}
if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.hostname.endsWith('.trycloudflare.com'))throw Error('Se requiere el origen HTTPS exacto del tunel de prueba.');
const file=path.join(os.homedir(),'telecus-fiet/api.env');
const cfg=parseEnv(fs.readFileSync(file,'utf8'));
cfg.APP_ORIGIN=url.origin;
const text=Object.entries(cfg).map(([key,value])=>{
 if(/[\r\n']/.test(value))throw Error('Formato privado no admitido; no se modifico la configuracion.');
 return `${key}='${value}'`;
}).join('\n')+'\n';
fs.writeFileSync(file+'.origin-new',text,{mode:0o600,flag:'wx'});
fs.renameSync(file+'.origin-new',file);
console.log('Origen publico configurado. Reiniciar telecus-app.service.');
