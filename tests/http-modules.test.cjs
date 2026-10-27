require('reflect-metadata');
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('los módulos HTTP comparten autenticación, mantienen contratos y descartan identidades enviadas por el cliente',async()=>{
  const [{NestFactory},{UnauthorizedException,ForbiddenException},{ApiModule},{NotificationsService}]=await Promise.all([
    import('@nestjs/core'),import('@nestjs/common'),import('../apps/backend/dist/http/app.module.js'),import('../apps/backend/dist/notifications.js')]);
  const profile={id:'trusted-patient',role:'PATIENT',full_name:'Paciente ficticio',email:'patient@example.test',active:true,token:'test-only'};
  let reads=0,mutations=0,enqueued;
  const identity={authenticate:async header=>{if(header!=='Bearer test-patient')throw new UnauthorizedException();return profile;},demoLogin:async()=>{throw new ForbiddenException();}};
  const notifications=new NotificationsService({list:async(user,before,limit)=>{assert.equal(user.id,profile.id);reads++;return {items:[],unread:0,next_cursor:null};},read:async(user,ids)=>{assert.equal(user.id,profile.id);mutations++;return 0;}});
  const bindings={identity,notifications,
    chat:{enqueue:async(user,input,header)=>{enqueued={user,input,header};return{id:'job',status:'queued'};},get:async(user,id)=>({id,owner:user.id,status:'queued'})},
    deliveries:{list:async user=>[{owner:user.id,status:'review'}]},system:{configuration:()=>({mode:'demo'}),health:async()=>({status:'ok'})}};
  const app=await NestFactory.create(ApiModule.register(bindings),{logger:false});await app.listen(0,'127.0.0.1');const base=await app.getUrl();
  async function request(path,body,authorized=true){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(authorized?{Authorization:'Bearer test-patient'}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};}
  try{
    for(const path of ['/api/me','/api/notifications','/api/integrations/deliveries','/api/chat/jobs/job'])assert.equal((await request(path,undefined,false)).status,401);
    assert.equal((await request('/api/notifications/read',{ids:['1']},false)).status,401);
    assert.equal((await request('/api/chat/jobs',{},false)).status,401);assert.equal(reads,0);assert.equal(mutations,0);assert.equal(enqueued,undefined);
    const me=await request('/api/me');assert.equal(me.status,200);assert.equal(me.body.id,profile.id);assert.equal(me.body.token,undefined);
    assert.equal((await request('/api/config',undefined,false)).status,200);assert.equal((await request('/api/healthz',undefined,false)).status,200);
    assert.equal((await request('/api/auth/demo',{role:'ADMIN'},false)).status,403);
    assert.equal((await request('/api/notifications?limit=1000')).status,400);assert.equal(reads,0);
    assert.equal((await request('/api/notifications/read',{ids:[null]})).status,400);assert.equal(mutations,0);
    assert.equal((await request('/api/notifications?recipient_id=another-user')).status,200);assert.equal(reads,1);
    assert.equal((await request('/api/notifications/read',{ids:['1'],recipient_id:'another-user',role:'ADMIN'})).status,200);assert.equal(mutations,1);
    assert.equal((await request('/api/chat/jobs',{})).status,400);assert.equal(enqueued,undefined);
    const input={action:'sendMessage',chatInput:'Hola',sessionId:'http-test',requestId:randomUUID(),owner_id:'another-user',role:'ADMIN'};
    assert.equal((await request('/api/chat/jobs',input)).status,202);assert.equal(enqueued.user.role,'PATIENT');assert.equal(enqueued.input.owner_id,undefined);assert.equal(enqueued.input.role,undefined);
    assert.equal((await request('/api/chat/jobs/job')).body.owner,profile.id);
    assert.equal((await request('/api/integrations/deliveries')).body[0].owner,profile.id);
  }finally{await app.close();}
});
