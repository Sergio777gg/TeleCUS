// Input from a terminal or a private stdin pipe; never echoes or stores it.
module.exports=function readSecret(label){
 process.stdout.write(label);
 if(!process.stdin.isTTY)return (async()=>{let value='';for await(const chunk of process.stdin)value+=chunk;process.stdout.write('\n');return value.replace(/\r?\n$/,'');})();
 if(process.stdin.isTTY)process.stdin.setRawMode(true);
 return new Promise((resolve,reject)=>{
  let value='';
  const finish=()=>{process.stdin.removeListener('data',onData);if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stdin.pause();process.stdin.unref?.();process.stdout.write('\n');};
  const onData=data=>{for(const c of data.toString('utf8')){
   if(c==='\u0003'){finish();reject(Error('Operación cancelada.'));return;}
   if(c==='\r'||c==='\n'){finish();resolve(value);return;}
   if(c==='\u007f'||c==='\b')value=value.slice(0,-1);else if(c>=' '&&c!=='\u001b')value+=c;
  }};process.stdin.on('data',onData);process.stdin.resume();
 });
};
