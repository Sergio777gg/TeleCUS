import {useCallback,useEffect,useRef,useState} from 'react';
import {request,uploadClinicalDocument} from './api';
import {documentAppointments,clinicalSelectionError,clinicalUploadIdentity} from './clinicalDocumentPolicy';
export function useClinicalDocuments({token,identity,role,enabled,readOnly=false,refreshKey=0,managed=false}){
 const [opened,setOpened]=useState(false),[focused,setFocused]=useState(null),[page,setPage]=useState({owner:identity,items:[]}),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const current=useRef(identity),read=useRef(null),command=useRef(null),keys=useRef(null);current.current=identity;if(!keys.current)keys.current=clinicalUploadIdentity();
 const visible=role==='DOCTOR'?page.items:documentAppointments(page.items),items=page.owner===identity?visible.filter(a=>!focused||a.id===focused):[],canOpen=Boolean(enabled&&token&&(role==='DOCTOR'||role==='PATIENT'&&items.length));
 useEffect(()=>{read.current?.abort();command.current?.abort();read.current=null;command.current=null;setOpened(false);setFocused(null);setPage({owner:identity,items:[]});setError('');setNotice('');setBusy(false);setLoading(false);keys.current=clinicalUploadIdentity();return()=>{read.current?.abort();command.current?.abort();};},[identity]);
 const refresh=useCallback(async({silent=false,appointment=focused}={})=>{
  if(!enabled||!token||!['PATIENT','DOCTOR'].includes(role)||command.current||read.current)return false;
  const controller=new AbortController();read.current=controller;if(!silent)setLoading(true);
  try{const result=await request('/api/clinical-documents'+(appointment?'?'+new URLSearchParams({appointment}):''),{token,signal:controller.signal,timeoutMs:30000});if(!Array.isArray(result.items))throw Error('No pudimos comprobar los documentos de esta cita.');if(current.current!==identity||controller.signal.aborted)return false;const rows=role==='DOCTOR'?result.items:documentAppointments(result.items);setPage({owner:identity,items:rows});if(role==='PATIENT'&&!rows.length)setOpened(false);setError('');return true;}
  catch(e){if(current.current===identity&&!controller.signal.aborted&&!silent)setError(e.message);return false;}
  finally{if(read.current===controller){read.current=null;if(current.current===identity)setLoading(false);}}
 },[token,identity,role,enabled,focused]);
 useEffect(()=>{if(role==='PATIENT'&&(!managed||opened)){read.current?.abort();read.current=null;void refresh({silent:true});}},[refresh,refreshKey,role,managed]);
 useEffect(()=>{const focus=()=>{if(role==='PATIENT'&&(!managed||opened)&&document.visibilityState==='visible')void refresh({silent:true});};window.addEventListener('focus',focus);return()=>window.removeEventListener('focus',focus);},[refresh,role,managed,opened]);
 async function open(appointmentId){if(!enabled||!token||!canOpen&&typeof appointmentId!=='string')return;read.current?.abort();read.current=null;const target=typeof appointmentId==='string'?appointmentId:null;setFocused(target);setOpened(true);setError('');setNotice('');await refresh({appointment:target});}
 async function mutate(work,apply,message){
  if(command.current||readOnly)return false;read.current?.abort();read.current=null;setLoading(false);
  const controller=new AbortController();command.current=controller;setBusy(true);setError('');setNotice('');let committed=false;
  try{const result=await work(controller.signal);if(current.current!==identity||controller.signal.aborted)return false;committed=true;setPage(old=>old.owner===identity?{...old,items:apply(old.items,result)}:old);setNotice(message);return true;}
  catch(e){if(current.current===identity&&!controller.signal.aborted)setError(e.message);return false;}
  finally{if(command.current===controller){command.current=null;if(current.current===identity){setBusy(false);if(committed)void refresh({silent:true});}}}
 }
 async function upload(appointment,file){
  if(role!=='PATIENT'||!file)return false;const invalid=clinicalSelectionError(file);if(invalid){setError(invalid);return false;}
  if(!items.some(a=>a.id===appointment&&a.can_upload)){setError('Actualiza tus citas. Solo puedes adjuntar documentos a una solicitud vigente registrada.');return false;}
  return mutate(signal=>uploadClinicalDocument(appointment,file,keys.current(appointment,file),token,signal),(rows,doc)=>rows.map(a=>a.id===appointment?{...a,documents:[...(a.documents||[]).filter(d=>d.id!==doc.id),doc]}:a),'Documento recibido. Puedes abrirlo aquí; el médico revisará su legibilidad antes de la consulta.');
 }
 async function withdraw(doc){return mutate(signal=>request('/api/clinical-documents/files/'+encodeURIComponent(doc.id)+'/withdraw',{token,body:{},signal,timeoutMs:30000}),rows=>rows.map(a=>({...a,documents:a.documents.filter(d=>d.id!==doc.id)})),'Documento retirado. Puedes adjuntar el archivo correcto.');}
 async function review(doc,status){return mutate(signal=>request('/api/clinical-documents/files/'+encodeURIComponent(doc.id)+'/review',{token,body:{status,version:doc.version},signal,timeoutMs:30000}),rows=>rows.map(a=>({...a,documents:a.documents.map(d=>d.id===doc.id?{...d,status,version:d.version+1}:d)})),'Revisión registrada.');}
 return {opened,items,busy,loading,error,notice,role,readOnly,canOpen,open,close:()=>{if(!busy)setOpened(false);},refresh:()=>refresh(),upload,withdraw,review};
}
