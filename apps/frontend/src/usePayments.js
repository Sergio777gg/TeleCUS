import {useCallback,useEffect,useRef,useState} from 'react';
import {downloadPaymentReceipt,request,uploadPaymentReceipt} from './api';
import {startVisiblePolling} from './visiblePolling';

const empty={items:[],receiptsAvailable:false,loaded:false};
const maxBytes=5*1024*1024;
const allowedTypes={pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png'};

/** Read model scoped by the server; upload and financial verification remain separate. */
export function usePayments({token,profile,mode,refreshKey,chatBusy,loadPending=true}){
  const enabled=Boolean(token&&profile&&['PATIENT','ADMIN'].includes(profile.role));
  const identity=enabled?profile.id+'|'+profile.role+'|'+mode+'|'+token:'';
  const current=useRef(identity),active=useRef(null),operation=useRef(null),known=useRef(null),jobIds=useRef(null),pendingChat=useRef(false),lastRefresh=useRef(refreshKey),wasBusy=useRef(false);
  const [state,setState]=useState({...empty,identity:''}),[working,setWorking]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[selection,setSelection]=useState(null),[autoOpenKey,setAutoOpenKey]=useState(0);
  current.current=identity;
  const load=useCallback(async(reason='refresh')=>{
    if(!enabled||!loadPending||current.current!==identity)return;
    if(reason==='background'&&(active.current||operation.current))return;
    const purpose=pendingChat.current?'chat':reason;
    active.current?.abort();const controller=new AbortController();active.current=controller;
    try{
      const result=await request('/api/payments',{token,signal:controller.signal,timeoutMs:45000});
      if(current.current!==identity||active.current!==controller)return;
      const items=Array.isArray(result.items)?result.items:[],previous=jobIds.current||known.current;
      if(purpose==='chat'&&profile.role==='PATIENT'&&previous&&items.some(item=>!previous.has(item.appointment_id)))setAutoOpenKey(value=>value+1);
      known.current=new Set(items.map(item=>item.appointment_id));if(purpose==='chat'){jobIds.current=null;pendingChat.current=false;}
      setState({identity,items,receiptsAvailable:result.receiptsAvailable===true,loaded:true});
      setSelection(old=>old&&items.some(item=>item.appointment_id===old.appointmentId&&item.can_upload&&!item.receipt)?old:null);
      setError('');return true;
    }catch(e){
      if(controller.signal.aborted||current.current!==identity||active.current!==controller)return;
      if(reason!=='background'||known.current===null)setState({...empty,identity,loaded:true});
      setError('No pudimos consultar los pagos. Actualiza para revisar su estado antes de continuar.');
      return false;
    }finally{if(active.current===controller)active.current=null;}
  },[enabled,loadPending,identity,token,profile?.role]);

  useEffect(()=>{
    setState({...empty,identity});setSelection(null);setError('');setNotice('');setWorking('');setAutoOpenKey(0);
    known.current=null;jobIds.current=null;pendingChat.current=false;lastRefresh.current=refreshKey;wasBusy.current=chatBusy;
    if(!enabled||!loadPending)return;
    const stop=startVisiblePolling({intervalMs:15000,canRun:()=>!active.current&&!operation.current,task:()=>load('background')});
    return()=>{stop();active.current?.abort();active.current=null;operation.current?.abort();operation.current=null;};
  },[enabled,loadPending,identity,load]);

  useEffect(()=>{if(chatBusy&&!wasBusy.current)jobIds.current=known.current?new Set(known.current):null;wasBusy.current=chatBusy;},[chatBusy]);
  useEffect(()=>{
    if(lastRefresh.current===refreshKey)return;lastRefresh.current=refreshKey;
    if(!enabled||!loadPending)return;
    pendingChat.current=true;if(document.visibilityState==='visible')void load('chat');
  },[refreshKey,enabled,loadPending,load]);

  function chooseFile(appointmentId,file){
    setError('');setNotice('');if(!file){setSelection(null);return;}
    const extension=file.name.split('.').pop().toLowerCase();
    if(!allowedTypes[extension]||(file.type&&file.type!==allowedTypes[extension])){setSelection(null);setError('Elige un PDF, JPG o PNG.');return;}
    if(!file.size||file.size>maxBytes){setSelection(null);setError('El archivo debe tener contenido y pesar como máximo 5 MB.');return;}
    setSelection(old=>old?.file===file&&old.appointmentId===appointmentId?old:{appointmentId,file,idempotencyKey:crypto.randomUUID()});
  }
  async function upload(){
    if(!selection||operation.current||current.current!==identity)return;
    const item=state.identity===identity&&state.items.find(row=>row.appointment_id===selection.appointmentId);
    if(!state.receiptsAvailable||!item?.can_upload||item.receipt)return;
    const chosen=selection,controller=new AbortController();operation.current=controller;setWorking('upload');setError('');setNotice('');
    try{
      await uploadPaymentReceipt(chosen.appointmentId,chosen.file,chosen.idempotencyKey,token,controller.signal);
      if(current.current!==identity||controller.signal.aborted)return;
      setSelection(null);setNotice('Recibimos tu comprobante. El Administrador lo revisará; tu cita aún no está confirmada.');await load();
    }catch(e){if(current.current===identity&&!controller.signal.aborted)setError(e.name==='TimeoutError'?'La recepción tardó más de lo esperado. Vuelve a intentar con el mismo archivo; evitaremos duplicarlo.':e.message);}
    finally{if(operation.current===controller)operation.current=null;if(current.current===identity)setWorking('');}
  }
  const withdrawal=useRef(null);
  async function withdraw(receipt){
    if(operation.current||current.current!==identity)return;
    if(withdrawal.current?.id!==receipt.id)withdrawal.current={id:receipt.id,requestId:crypto.randomUUID()};
    const controller=new AbortController();operation.current=controller;setWorking('withdraw');setError('');setNotice('');
    try{
      await request('/api/payments/receipts/'+encodeURIComponent(receipt.id)+'/withdraw',{token,body:{requestId:withdrawal.current.requestId},signal:controller.signal,timeoutMs:45000});
      if(current.current!==identity||controller.signal.aborted)return;
      withdrawal.current=null;setNotice('Retiramos ese comprobante de la revisión. Tu pre-reserva se mantiene; adjunta el archivo correcto. Si ya pagaste, no vuelvas a pagar.');await load();
    }catch(e){if(current.current===identity&&!controller.signal.aborted)setError(e.message);}
    finally{if(operation.current===controller)operation.current=null;if(current.current===identity)setWorking('');}
  }
  async function download(receipt){
    if(operation.current||current.current!==identity)return;
    const controller=new AbortController();operation.current=controller;setWorking(receipt.id);setError('');
    try{
      const blob=await downloadPaymentReceipt(receipt.id,token,controller.signal);
      if(current.current!==identity||controller.signal.aborted)return;
      const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=receipt.file_name||'comprobante';anchor.rel='noopener';document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){if(current.current===identity&&!controller.signal.aborted)setError(e.message);}
    finally{if(operation.current===controller)operation.current=null;if(current.current===identity)setWorking('');}
  }
  const page=state.identity===identity?state:empty;
  return {...page,selection:state.identity===identity?selection:null,error:state.identity===identity?error:'',notice:state.identity===identity?notice:'',busy:Boolean(working),working,autoOpenKey,refresh:()=>load(),chooseFile,clearFile:()=>{setSelection(null);setError('');},upload,download,withdraw};
}
