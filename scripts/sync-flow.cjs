const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),target=path.join(root,'data/node-red/flows.json');
const generated=JSON.parse(fs.readFileSync(path.join(root,'node-red/flows.json'),'utf8'));
if(fs.existsSync(target)){
 const existing=JSON.parse(fs.readFileSync(target,'utf8')),ids=new Set(generated.map(n=>n.id));
 fs.copyFileSync(target,path.join(root,'data/node-red/flows-before-integration.json'));
 fs.writeFileSync(target+'.tmp',JSON.stringify([...existing.filter(n=>!ids.has(n.id)),...generated],null,2));
 fs.renameSync(target+'.tmp',target);
}else{fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(generated,null,2));}
console.log('Flujo de interpretación y conocimiento actualizado; nodos ajenos conservados.');
