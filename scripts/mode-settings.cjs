module.exports=function modeSettings(text,mode){
 if(!['demo','supabase-readonly','supabase-live'].includes(mode))throw Error('Modo inválido.');
 const lines=text.split(/\r?\n/).filter(line=>!/^\s*(?:DATA_MODE|RUN_DELIVERY_WORKER)=/.test(line));
 while(lines.at(-1)==='')lines.pop();
 return [...lines,'DATA_MODE='+mode,'RUN_DELIVERY_WORKER='+(mode==='supabase-live'?'true':'false'),''].join('\n');
};
