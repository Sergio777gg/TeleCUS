import {useCallback,useEffect,useRef,useState} from 'react';
import {request} from './api';
import {startVisiblePolling} from './visiblePolling';
export function useAdministration({token,profile,mode,onConfigurationChange}){
  const identity=profile?.id+'|'+profile?.role+'|'+mode+'|'+token,current=useRef(identity),active=useRef(null),command=useRef(null),last=useRef(null),viewVersion=useRef(0);
  const [loading,setLoading]=useState(false),[updatedAt,setUpdatedAt]=useState(null),[opened,setOpened]=useState(false),[tab,setTab]=useState('payments'),[role,setRole]=useState('PATIENT'),[query,setQuery]=useState(''),[offset,setOffset]=useState(0),[paymentView,setPaymentView]=useState('received'),[data,setData]=useState(null),[detail,setDetail]=useState(null),[review,setReview]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  current.current=identity;
  const allowed=profile?.role==='ADMIN',readOnly=mode==='supabase-readonly';
  useEffect(()=>{active.current?.abort();command.current?.abort();setOpened(false);setLoading(false);setUpdatedAt(null);setData(null);setDetail(null);setReview(null);setError('');setBusy(false);last.current=null;},[identity]);
  const load=useCallback(async(resource=tab,extra={},options={})=>{
    const background=options.background===true;
    if(!allowed)return;if(background&&(active.current||command.current))return;
    active.current?.abort();const controller=new AbortController(),version=viewVersion.current;active.current=controller;if(!background)setLoading(true);
    const params=new URLSearchParams({role,q:query,offset:String(offset),view:paymentView,...extra});
    try{const result=await request('/api/admin/'+resource+'?'+params,{token,signal:controller.signal,timeoutMs:30000});if(current.current===identity&&!controller.signal.aborted&&viewVersion.current===version&&active.current===controller){if(resource==='knowledge'&&extra.file)setDetail(result);else setData(result);setUpdatedAt(new Date().toISOString());setError('');}return result;}
    catch(e){if(current.current===identity&&!controller.signal.aborted&&viewVersion.current===version&&active.current===controller){if(!background){if(resource==='knowledge'&&extra.file)setDetail(null);else setData(null);}setError(background?'No pudimos renovar esta sección. Se conservan los datos de la última consulta; actualiza antes de actuar.':e.message);}return null;}
    finally{if(active.current===controller){active.current=null;if(current.current===identity&&!background)setLoading(false);}}
  },[identity,token,allowed,tab,role,query,offset,paymentView]);
  useEffect(()=>{if(!opened||!allowed)return;setData(null);void load();},[opened,load]);
  useEffect(()=>{if(!opened||!allowed||tab!=='payments'||review)return;return startVisiblePolling({intervalMs:paymentView==='history'?30000:15000,immediate:false,canRun:()=>!command.current&&!active.current,task:async()=>await load(tab,{}, {background:true})!==null});},[opened,allowed,tab,load,review,paymentView]);
  function select(next){if(command.current)return;viewVersion.current++;active.current?.abort();setLoading(false);setUpdatedAt(null);setTab(next);setOffset(0);setQuery('');setData(null);setDetail(null);setReview(null);setError('');setNotice('');}
  async function mutate(resource,expected,payload){
    if(command.current||readOnly)return false;
    const navigation=viewVersion.current,signature=JSON.stringify([resource,expected,payload]);if(last.current?.signature!==signature)last.current={signature,id:crypto.randomUUID()};
    const controller=new AbortController();command.current=controller;setBusy(true);setError('');setNotice('');
    try{
      await request('/api/admin/commands',{token,body:{resource,expected,payload,requestId:last.current.id},signal:controller.signal,timeoutMs:45000});
      if(current.current!==identity||controller.signal.aborted)return false;
      last.current=null;setNotice(resource==='registration'?'Preinscripción guardada. La persona debe iniciar sesión con ese correo verificado para activar su perfil.':'Cambios guardados.');
      if(['settings','schedule'].includes(resource))await onConfigurationChange?.();
      if(navigation!==viewVersion.current)return true;
      if(resource.startsWith('knowledge_'))await load('knowledge',{file:payload.file});else await load();return true;
    }catch(e){if(current.current===identity&&!controller.signal.aborted)setError(e.message);return false;}
    finally{if(command.current===controller)command.current=null;if(current.current===identity)setBusy(false);}
  }
  async function openReview(item){
    if(command.current||readOnly)return;viewVersion.current++;active.current?.abort();active.current=null;setLoading(false);setOpened(true);setTab('payments');setData(null);setReview(null);setDetail(null);setError('');setNotice('');
    const controller=new AbortController();command.current=controller;setBusy(true);
    try{const result=await request('/api/admin/payments/'+encodeURIComponent(item.appointment_id)+'/review',{token,body:{requestId:crypto.randomUUID()},signal:controller.signal,timeoutMs:30000});if(current.current===identity&&!controller.signal.aborted)setReview(result);}
    catch(e){if(current.current===identity&&!controller.signal.aborted)setError(e.message);}
    finally{if(command.current===controller)command.current=null;if(current.current===identity)setBusy(false);}
  }
  async function confirmReview(){
    if(!review||command.current||readOnly)return;const controller=new AbortController();command.current=controller;setBusy(true);setError('');
    try{
      const result=await request('/api/admin/payment-reviews/'+encodeURIComponent(review.id)+'/confirm',{token,body:{verified:true},signal:controller.signal,timeoutMs:45000});
      if(current.current!==identity||controller.signal.aborted)return;
      setReview(null);setNotice(result.mode==='demo'?'Pago confirmado en datos ficticios. No se modificó Google.':'La verificación quedó registrada. La agenda se está sincronizando; recibirás el resultado en Notificaciones.');await load('payments');
    }catch(e){if(current.current===identity&&!controller.signal.aborted)setError(e.message);}
    finally{if(command.current===controller)command.current=null;if(current.current===identity)setBusy(false);}
  }
  async function previewKnowledge(input){
    if(command.current)return;const controller=new AbortController();command.current=controller;setBusy(true);setError('');
    try{const result=await request('/api/admin/knowledge/preview',{token,body:input,signal:controller.signal,timeoutMs:15000});return current.current===identity?result:null;}
    catch(e){if(current.current===identity)setError(e.message);return null;}
    finally{if(command.current===controller)command.current=null;if(current.current===identity)setBusy(false);}
  }
  return {loading,updatedAt,opened,tab,role,query,offset,paymentView,setPaymentView:v=>{viewVersion.current++;active.current?.abort();setData(null);setReview(null);setPaymentView(v);setQuery('');setOffset(0);setError('');setNotice('');},data,detail,review,busy,error,notice,readOnly,open:()=>setOpened(true),close:()=>{setOpened(false);setReview(null);},select,setRole:r=>{viewVersion.current++;setData(null);setRole(r);setOffset(0);},search:q=>{viewVersion.current++;setData(null);setQuery(q);setOffset(0);},setOffset:n=>{viewVersion.current++;setData(null);setOffset(n);},load,mutate,openReview,confirmReview,discardReview:()=>{setReview(null);void load('payments');},previewKnowledge};
}
