import {useEffect,useRef,useState} from 'react';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {downloadPaymentReceipt,downloadClinicalDocument} from './api';

/** Only this hook reads bytes. Rendering never exposes a token or an executable document URL. */
export function useReceiptPreview({token,identity,kind='payment'}){
  const current=useRef(identity),active=useRef(null),sequence=useRef(0),pdf=useRef(null),canvas=useRef(null),downloadActive=useRef(null),loadingTask=useRef(null);
  const [view,setView]=useState(null),[page,setPage]=useState(1),[zoom,setZoom]=useState(1),[busy,setBusy]=useState(false),[error,setError]=useState('');
  current.current=identity;
  function releasePdf(){const task=loadingTask.current;loadingTask.current=null;pdf.current=null;if(task)void task.destroy().catch(()=>{});}
  function close(){downloadActive.current?.abort();downloadActive.current=null;sequence.current++;active.current?.abort();active.current=null;setView(null);setError('');setBusy(false);releasePdf();}
  useEffect(()=>{close();return()=>{sequence.current++;active.current?.abort();releasePdf();};},[identity]);
  useEffect(()=>()=>{if(view?.url)URL.revokeObjectURL(view.url);},[view?.url]);
  async function open(receipt,localFile){
    close();const generation=sequence.current,owner=identity,controller=new AbortController();active.current=controller;
    setView({receipt,loading:true});setBusy(true);setPage(1);setZoom(1);
    try{
      const blob=localFile||await (kind==='clinical'?downloadClinicalDocument:downloadPaymentReceipt)(receipt.id,token,controller.signal);
      if(current.current!==owner||sequence.current!==generation||controller.signal.aborted)return;
      if(blob.size>5*1024*1024)throw Error('El archivo supera el límite de previsualización.');
      if(receipt.content_type==='application/pdf'){
        const lib=await import('pdfjs-dist');lib.GlobalWorkerOptions.workerSrc=workerUrl;
        const data=new Uint8Array(await blob.arrayBuffer());if(current.current!==owner||sequence.current!==generation||controller.signal.aborted)return;
        const task=lib.getDocument({data,isEvalSupported:false,enableXfa:false,useWorkerFetch:false,disableAutoFetch:true,maxImageSize:16000000,stopAtErrors:true,useWasm:false});
        loadingTask.current=task;active.current={abort:()=>{controller.abort();void task.destroy().catch(()=>{});}};
        const deadline=setTimeout(()=>void task.destroy(),20000);
        const document=await task.promise.finally(()=>clearTimeout(deadline));
        if(current.current!==owner||sequence.current!==generation){await task.destroy();return;}
        if(document.numPages>500){await task.destroy();throw Error('Este PDF tiene demasiadas páginas para previsualizarlo. Puedes descargarlo.');}
        pdf.current=document;setView({receipt,pages:document.numPages,loading:false});
      }else{
        const url=URL.createObjectURL(new Blob([blob],{type:receipt.content_type}));
        if(sequence.current!==generation){URL.revokeObjectURL(url);return;}
        setView({receipt,url,loading:false});
      }
    }catch(e){if(sequence.current===generation&&!controller.signal.aborted)setError('No pudimos previsualizar este archivo. Puedes descargarlo para revisarlo.');}
    finally{if(sequence.current===generation)setBusy(false);}
  }
  useEffect(()=>{
    if(!view?.pages||!pdf.current||!canvas.current)return;
    let disposed=false,render;
    setBusy(true);
    void pdf.current.getPage(page).then(async source=>{
      if(disposed)return;
      const natural=source.getViewport({scale:1}),scale=Math.min(1.6*zoom,1800/natural.width,Math.sqrt(3000000/(natural.width*natural.height)));
      const viewport=source.getViewport({scale}),element=canvas.current;if(!element)return;
      element.width=Math.ceil(viewport.width);element.height=Math.ceil(viewport.height);
      render=source.render({canvas:element,canvasContext:element.getContext('2d'),viewport});
      await render.promise;
    }).catch(()=>{if(!disposed)setError('No pudimos mostrar esta página. Prueba otra o descarga el archivo.');}).finally(()=>{if(!disposed)setBusy(false);});
    return()=>{disposed=true;render?.cancel();};
  },[view,page,zoom]);
  async function download(receipt=view?.receipt){
    if(!receipt||downloadActive.current)return;const controller=new AbortController(),owner=identity,generation=sequence.current;downloadActive.current=controller;setError('');
    try{const blob=await (kind==='clinical'?downloadClinicalDocument:downloadPaymentReceipt)(receipt.id,token,controller.signal);if(controller.signal.aborted||current.current!==owner||sequence.current!==generation)return;const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=receipt.file_name||'comprobante';anchor.rel='noopener';document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    catch(e){if(!controller.signal.aborted&&current.current===owner&&sequence.current===generation)setError('No pudimos descargar el comprobante. Vuelve a intentarlo.');}
    finally{if(downloadActive.current===controller)downloadActive.current=null;}
  }
  return {kind,view,page,zoom,enlarge:()=>setZoom(n=>Math.min(3,n+1)),reduce:()=>setZoom(n=>Math.max(1,n-1)),busy,error,canvas,open,close,download,previous:()=>setPage(n=>Math.max(1,n-1)),next:()=>setPage(n=>Math.min(view?.pages||1,n+1))};
}
