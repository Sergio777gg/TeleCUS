import {useCallback,useEffect,useRef,useState} from 'react';
import {request} from './api';
import {mergeNotificationPage} from './notificationPages';
import {startVisiblePolling} from './visiblePolling';
const empty={items:[],unread:0,read_count:0,next_cursor:null};

/** One bounded request at a time; persistent server inbox, visibility-aware polling/backoff. */
export function useNotifications(token,identity,refreshKey){
  const [page,setPage]=useState(empty),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [undo,setUndo]=useState(null),[notice,setNotice]=useState(''),cleanup=useRef(null);
  const actor=useRef(identity),active=useRef(null),reading=useRef(false);
  actor.current=identity;
  const load=useCallback(async(before,manual=false)=>{
    if(!token||active.current||reading.current)return;
    const current=identity,controller=new AbortController();active.current=controller;if(manual)setBusy(true);
    try{
      const result=await request('/api/notifications'+(before?'?before='+encodeURIComponent(before):''),{token,signal:controller.signal,timeoutMs:45000});
      if(actor.current!==current)return;
      if(controller.signal.aborted||active.current!==controller)return;
      setPage(old=>mergeNotificationPage(old,result,before));setError('');return true;
    }catch(e){if(e.name!=='AbortError'&&actor.current===current){setError('No pudimos actualizar las notificaciones. Tus gestiones siguen guardadas. Puedes volver a intentar.');}return false;}
    finally{if(active.current===controller)active.current=null;if(actor.current===current&&manual&&!reading.current)setBusy(false);}
  },[token,identity]);
  useEffect(()=>{
    setPage(empty);setError('');setBusy(false);setUndo(null);setNotice('');if(!token)return;
    const stop=startVisiblePolling({intervalMs:15000,canRun:()=>!active.current&&!reading.current,task:()=>load()});
    return()=>{stop();active.current?.abort();active.current=null;cleanup.current?.abort();cleanup.current=null;reading.current=false;};
  },[load]);
  useEffect(()=>{if(refreshKey&&document.visibilityState==='visible')void load();},[refreshKey,load]);
  async function markRead(ids){
    if(reading.current||busy||!ids.length)return;reading.current=true;active.current?.abort();active.current=null;setBusy(true);const current=identity;
    try{await request('/api/notifications/read',{token,body:{ids},timeoutMs:45000});if(actor.current!==current)return;
      setPage(old=>({...old,unread:Math.max(0,old.unread-old.items.filter(n=>ids.includes(n.id)&&!n.read_at).length),items:old.items.map(n=>ids.includes(n.id)?{...n,read_at:n.read_at||new Date().toISOString()}:n)}));setError('');
    }catch{if(actor.current===current)setError('No pudimos marcar la lectura. Vuelve a intentarlo.');}
    finally{reading.current=false;if(actor.current===current){setBusy(false);void load();}}
  }
  async function clean(path,body,removeMode){
    if(reading.current||busy)return;reading.current=true;active.current?.abort();active.current=null;const controller=new AbortController();cleanup.current=controller;setBusy(true);setError('');setNotice('');const current=identity,previousUndo=undo;
    if(removeMode)setUndo({batchId:body.batchId});
    try{const result=await request('/api/notifications/'+path,{token,body,signal:controller.signal,timeoutMs:45000});if(actor.current!==current||controller.signal.aborted)return;
      if(removeMode){setUndo(result.removed?{batchId:body.batchId}:previousUndo);setNotice(result.removed?`${result.removed===1?'Notificación eliminada.':result.removed+' notificaciones eliminadas.'}`:'No había notificaciones que eliminar.');setPage(old=>({...old,items:old.items.filter(n=>body.read?!n.read_at:!body.ids.includes(n.id)),read_count:body.read?0:Math.max(0,(old.read_count||0)-old.items.filter(n=>body.ids.includes(n.id)&&n.read_at).length),unread:Math.max(0,old.unread-old.items.filter(n=>!body.read&&body.ids.includes(n.id)&&!n.read_at).length)}));}
      else{setUndo(null);setNotice('Notificaciones restauradas.');}
    }catch(e){if(actor.current===current&&!controller.signal.aborted)setError(removeMode?'No pudimos confirmar la limpieza. Puedes actualizar o pulsar Deshacer.':'No pudimos restaurar los avisos. Vuelve a intentarlo.');}
    finally{if(cleanup.current===controller)cleanup.current=null;if(actor.current===current){reading.current=false;setBusy(false);void load();}}
  }
  return {...page,error,busy,notice,canUndo:Boolean(undo),refresh:()=>load(undefined,true),more:()=>page.next_cursor&&load(page.next_cursor,true),markRead,remove:(ids=[],read=false)=>clean('remove',{ids,read,batchId:crypto.randomUUID()},true),restore:()=>undo&&clean('restore',{batchId:undo.batchId},false)};
}
