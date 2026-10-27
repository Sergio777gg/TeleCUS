import {useCallback,useEffect,useRef,useState} from 'react';
import {request} from './api';
import {startVisiblePolling,workspaceReads} from './visiblePolling';
/** Explicit REST operations. This hook never invokes chat jobs or an interpreter. */
export function useWorkspace({token,profile,mode,section='summary',paused=false}){
  const identity=profile?.id+'|'+profile?.role+'|'+mode+'|'+token,current=useRef(identity),active=useRef(null),command=useRef(null),last=useRef(null);
  current.current=identity;
  const [appointments,setAppointments]=useState([]),[requests,setRequests]=useState([]),[doctors,setDoctors]=useState([]),[counts,setCounts]=useState(null),[information,setInformation]=useState(null),[usage,setUsage]=useState(null);
  const [agendaFilter,setAgendaFilter]=useState({view:'current',q:'',offset:0}),[requestFilter,setRequestFilter]=useState({view:'current',q:'',offset:0}),[nextAgenda,setNextAgenda]=useState(null),[nextRequests,setNextRequests]=useState(null);
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[updated,setUpdated]=useState(null);
  const [refreshKey,setRefreshKey]=useState(0);
  const refresh=useCallback(async(options={})=>{
    const background=options.background===true;
    if(!token||!['ADMIN','DOCTOR'].includes(profile?.role))return;
    if(background&&(active.current||command.current))return;
    const reads=workspaceReads(profile.role,section);if(!Object.values(reads).some(Boolean))return;
    active.current?.abort();const controller=new AbortController();active.current=controller;if(!background)setLoading(true);
    const get=(path)=>request(path,{token,signal:controller.signal,timeoutMs:30000});
    try{
      const [agenda,changes,people]=await Promise.all([reads.appointments?get('/api/workspace/appointments?'+new URLSearchParams(agendaFilter)):null,reads.requests?get('/api/workspace/requests?'+new URLSearchParams(requestFilter)):null,reads.doctors?get('/api/workspace/doctors'):null]);
      if([agenda,changes,people].some(value=>value&&!Array.isArray(value.items)))throw Error('La respuesta de la sección está incompleta. Vuelve a consultar.');
      if(controller.signal.aborted||current.current!==identity)return;
      if(agenda){setAppointments(agenda.items);setCounts(agenda.counts);setNextAgenda(agenda.next_offset);}if(changes){setRequests(changes.items);setNextRequests(changes.next_offset);}if(people)setDoctors(people.items);setUpdated(new Date());setError('');return true;
    }catch(e){if(!controller.signal.aborted&&current.current===identity){controller.abort();if(!background){setAppointments([]);setRequests([]);setCounts(null);}setError(background?'No pudimos renovar la agenda. Se conservan los datos de la última consulta; actualiza antes de actuar.':e.message);}return false;}
    finally{if(active.current===controller){active.current=null;if(current.current===identity&&!background)setLoading(false);}}
  },[identity,token,profile?.role,agendaFilter,requestFilter,section]);
  useEffect(()=>{void refresh();return()=>active.current?.abort();},[refresh]);
  useEffect(()=>{if(paused||!token||!Object.values(workspaceReads(profile?.role,section)).some(Boolean))return;return startVisiblePolling({intervalMs:30000,immediate:false,canRun:()=>!command.current&&!active.current,task:()=>refresh({background:true})});},[refresh,paused,token,profile?.role,section]);
  useEffect(()=>()=>{command.current?.abort();},[identity]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),8000);return()=>clearTimeout(timer);},[notice]);
  useEffect(()=>{setNotice('');},[section]);
  async function run(path,body,success){
    if(command.current)return null;const controller=new AbortController();command.current=controller;setBusy(true);setError('');setNotice('');
    try{const result=await request(path,{token,body,signal:controller.signal,timeoutMs:45000});if(controller.signal.aborted||current.current!==identity)return null;if(success)await success(result);return result;}
    catch(e){if(!controller.signal.aborted&&current.current===identity)setError(e.message);return null;}
    finally{if(command.current===controller)command.current=null;if(current.current===identity)setBusy(false);}
  }
  async function prepare(action){const signature=JSON.stringify(action);if(last.current?.signature!==signature)last.current={signature,id:crypto.randomUUID()};return run('/api/workspace/reviews',{...action,requestId:last.current.id});}
  async function execute(review){const result=await run('/api/workspace/actions',{token:review.token,confirmed:true,...(review.kind==='complete'?{attended:true}:review.kind==='confirm_free'?{admission_checked:true}:{})},async r=>{last.current=null;setNotice(r.message);setRefreshKey(n=>n+1);await refresh();});return Boolean(result);}
  async function checkAvailability(doctorId,date){try{const result=await request('/api/workspace/availability?'+new URLSearchParams({doctor:doctorId,date}),{token,timeoutMs:30000});return current.current===identity?result:null;}catch(e){if(current.current===identity)setError(e.message);return null;}}
  async function loadInformation(){return run('/api/workspace/information',undefined,r=>setInformation(r));}
  async function loadUsage(){return run('/api/workspace/usage',undefined,r=>setUsage(r));}
  return {appointments,requests,doctors,counts,information,usage,agendaFilter,requestFilter,nextAgenda,nextRequests,setAgendaFilter,setRequestFilter,loading,busy,error,notice,updated,refreshKey,refresh,prepare,execute,checkAvailability,loadInformation,loadUsage};
}
