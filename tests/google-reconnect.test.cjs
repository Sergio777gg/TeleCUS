const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
test('reconectar Google cambia la autorización de la próxima entrega sin recrear el trabajador',async()=>{
 const {configuredGoogle}=await import('../apps/backend/dist/integrations/google-config.js');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'telecus google fixture ')),secret=crypto.randomBytes(32).toString('hex');
 const clientFile=path.join(root,'client.json'),tokenFile=path.join(root,'token.enc');
 const keys=['GOOGLE_OAUTH_CLIENT_FILE','GOOGLE_TOKEN_FILE'],previous=keys.map(k=>process.env[k]),transport=global.fetch,observed=[];
 function writeToken(refresh){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update(secret).digest(),iv);const data=Buffer.concat([cipher.update(JSON.stringify({refresh_token:refresh})),cipher.final()]);fs.writeFileSync(tokenFile,JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}));}
 try{
  fs.writeFileSync(clientFile,JSON.stringify({web:{client_id:'fixture-client',client_secret:'fixture-secret'}}));
  process.env[keys[0]]=clientFile;process.env[keys[1]]=tokenFile;writeToken('fixture-old');
  global.fetch=async(url,options)=>{if(url.includes('/token')){observed.push(options.body.get('refresh_token'));return Response.json({access_token:'fixture-access'});}return Response.json({id:'fixture-event',hangoutLink:'https://meet.google.com/fixture'});};
  const gateway=configuredGoogle(secret),task={operation:'confirm',delivery_id:'fixture',appointment:{id:'fixture',code:'TCUS-TEST-001',start_time:'2030-01-07T19:00:00Z',end_time:'2030-01-07T19:30:00Z',patient_email:'patient@example.test',doctor_email:'doctor@example.test'}};
  await gateway.calendar(task);writeToken('fixture-renewed');await gateway.calendar(task);
  assert.deepEqual(observed,['fixture-old','fixture-renewed']);
 }finally{
  global.fetch=transport;keys.forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});
  const resolved=fs.realpathSync(root);if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('telecus google fixture '))throw Error('Ruta temporal no válida.');fs.rmSync(resolved,{recursive:true,force:true});
 }
});
