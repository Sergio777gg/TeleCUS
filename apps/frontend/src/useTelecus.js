import {useEffect,useRef,useState} from 'react';
import {request,runJob} from './api';
export function useTelecus(){
  const [config,setConfig]=useState(null),[profile,setProfile]=useState(null),[token,setToken]=useState(''),[messages,setMessages]=useState([]),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState(''),[retry,setRetry]=useState(null),[proposal,setProposal]=useState(null),[paymentRefreshKey,setPaymentRefreshKey]=useState(0);
  const client=useRef(null),session=useRef(crypto.randomUUID()),active=useRef(null),working=useRef(false),identity=useRef('');
  async function accept(newToken){const user=await request('/api/me',{token:newToken});identity.current=user.id;setProfile(user);setToken(newToken);setError('');}
  useEffect(()=>{
    let disposed=false,subscription;
    request('/api/config').then(async c=>{
      if(disposed)return;setConfig(c);
      if(c.mode==='demo'){const saved=sessionStorage.getItem('telecus-demo-token');if(saved)await accept(saved).catch(()=>sessionStorage.removeItem('telecus-demo-token'));}
      else{const {createClient}=await import('@supabase/supabase-js');if(disposed)return;client.current=createClient(c.supabaseUrl,c.supabasePublishableKey);const {data}=await client.current.auth.getSession();if(data.session)await accept(data.session.access_token);subscription=client.current.auth.onAuthStateChange((event,s)=>{if(s&&!disposed)setTimeout(()=>accept(s.access_token).catch(e=>setError(e.message)),0);}).data.subscription;}
    }).catch(e=>{if(!disposed)setError(e.message);});
    return()=>{disposed=true;subscription?.unsubscribe();active.current?.abort();};
  },[]);
  async function refreshConfiguration(){const next=await request('/api/config',{timeoutMs:15000});setConfig(next);}
  useEffect(()=>{const refresh=()=>{if(document.visibilityState==='visible')void refreshConfiguration().catch(()=>{});};const timer=setInterval(refresh,60000);window.addEventListener('focus',refresh);return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);};},[]);
  async function login(role){setError('');try{if(config.mode==='demo'){const result=await request('/api/auth/demo',{body:{role}});sessionStorage.setItem('telecus-demo-token',result.token);await accept(result.token);}else{const {error:e}=await client.current.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.origin}});if(e)throw e;}}catch(e){setError(e.message);}}
  async function logout(){active.current?.abort();identity.current='';working.current=false;setBusy(false);sessionStorage.removeItem('telecus-demo-token');if(client.current)await client.current.auth.signOut();setToken('');setProfile(null);newChat();}
  function newChat(){session.current=crypto.randomUUID();setMessages([]);setStatus('');setError('');setProposal(null);setRetry(null);}
  async function execute(input,append=true,displayText){
    if(working.current||!token)return;working.current=true;setBusy(true);setError('');setRetry(null);setProposal(null);
    const current=profile.id,controller=new AbortController();active.current=controller;
    if(append)setMessages(m=>[...m,{id:input.requestId,author:'user',text:displayText||input.chatInput||({roleOverview:'Ver opciones',confirm:'Confirmar operación',dismiss:'Descartar operación'}[input.action])}]);
    try{const result=await runJob(input,token,controller.signal,setStatus);if(identity.current!==current)return;setMessages(m=>[...m,{id:crypto.randomUUID(),author:'assistant',text:result.reply,proposal:result.proposal,handoff:result.handoff,ui_action:result.ui_action,choices:result.choices}]);setProposal(result.proposal||null);setPaymentRefreshKey(k=>k+1);setStatus('');}
    catch(e){if(e.name==='AbortError'||identity.current!==current)return;setError(e.message);setStatus('');setMessages(m=>[...m,{id:crypto.randomUUID(),author:'assistant',text:(input.action==='confirm'?'No pude completar la confirmación. ':'No pude completar esta solicitud. ')+e.message,handoff:{reason:'technical'}}]);if(!e.completed)setRetry(input);}
    finally{if(identity.current===current){working.current=false;setBusy(false);}}
  }
  function send(text,action='sendMessage',proposalId,displayText){return execute({chatInput:text,action,sessionId:session.current,requestId:crypto.randomUUID(),...(proposalId?{proposalId}:{})},true,displayText);}
  async function checkDeliveries(){
    if(working.current||!token)return;working.current=true;setBusy(true);setError('');const current=profile.id;
    try{const rows=await request('/api/integrations/deliveries',{token});if(identity.current!==current)return;
      const labels={queued:'Pendiente',running:'En proceso',sending:'Enviando correo',review:'Requiere revisión administrativa',done:'Sincronización y correo completados'};
      const text=rows.length?rows.map(d=>`${d.code}: ${labels[d.status]||'Pendiente'}${d.status==='done'?'':d.stage==='calendar'?' · confirmación de agenda':' · notificación por correo'}`).join('\n'):'No hay sincronizaciones registradas dentro de tu acceso.';
      setMessages(m=>[...m,{id:crypto.randomUUID(),author:'assistant',text}]);
    }catch(e){if(identity.current===current)setError(e.message);}finally{if(identity.current===current){working.current=false;setBusy(false);}}
  }
  return {config,profile,token,messages,busy,status,error,retry,proposal,paymentRefreshKey,refreshConfiguration,login,logout,newChat,send,checkDeliveries,retryLast:()=>retry&&execute(retry,false)};
}
