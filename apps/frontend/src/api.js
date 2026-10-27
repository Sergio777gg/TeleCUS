export async function request(path,{token,body,signal,timeoutMs}={}){
  const deadline=timeoutMs?AbortSignal.timeout(timeoutMs):null;
  const fetchSignal=deadline?(signal?AbortSignal.any([signal,deadline]):deadline):signal;
  const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:fetchSignal});
  const result=await response.json().catch(()=>{fetchSignal?.throwIfAborted();return {};});
  fetchSignal?.throwIfAborted();
  if(!response.ok)throw Error(typeof result.message==='string'?result.message:'No se pudo completar la solicitud.');
  return result;
}
export async function runJob(input,token,signal,onStatus){
  const job=await request('/api/chat/jobs',{token,body:input,signal});const started=Date.now();
  while(Date.now()-started<180000){
    const state=await request('/api/chat/jobs/'+job.id,{token,signal});
    if(state.status==='done')return state.result;
    if(state.status==='failed'){const error=Error(state.error||'La solicitud no pudo completarse.');error.completed=true;throw error;}
    onStatus(state.status==='queued'?'Tu solicitud está en espera…':'El asistente está procesando tu solicitud…');
    await new Promise((resolve,reject)=>{if(signal.aborted)return reject(new DOMException('Abortado','AbortError'));const timer=setTimeout(done,900);function done(){signal.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new DOMException('Abortado','AbortError'));}signal.addEventListener('abort',abort,{once:true});});
  }
  throw Error('La solicitud sigue pendiente. Usa Reintentar para recuperar su resultado.');
}

/** Multipart keeps the browser boundary; credentials never enter a download URL. */
export async function uploadPaymentReceipt(appointmentId,file,idempotencyKey,token,signal){
  const body=new FormData();body.append('file',file);
  const response=await fetch('/api/payments/'+encodeURIComponent(appointmentId)+'/receipt',{
    method:'POST',headers:{Authorization:'Bearer '+token,'Idempotency-Key':idempotencyKey},body,
    signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(typeof result.message==='string'?result.message:'No pudimos recibir el comprobante. Vuelve a intentarlo.');
  return result;
}

export async function downloadPaymentReceipt(receiptId,token,signal){
  const response=await fetch('/api/payments/receipts/'+encodeURIComponent(receiptId),{
    headers:{Authorization:'Bearer '+token},signal:AbortSignal.any([signal,AbortSignal.timeout(45000)])
  });
  if(!response.ok){const result=await response.json().catch(()=>({}));throw Error(typeof result.message==='string'?result.message:'No pudimos descargar el comprobante. Vuelve a intentarlo.');}
  return response.blob();
}
export async function downloadClinicalDocument(id,token,signal){
  const response=await fetch('/api/clinical-documents/files/'+encodeURIComponent(id),{headers:{Authorization:'Bearer '+token},signal:AbortSignal.any([signal,AbortSignal.timeout(45000)])});
  if(!response.ok)throw Error('No pudimos abrir el documento privado. Revisa tu acceso o actualiza la lista.');
  return response.blob();
}
export async function uploadClinicalDocument(appointmentId,file,key,token,signal){
 const body=new FormData();body.append('file',file);
 let response;try{response=await fetch('/api/clinical-documents/'+encodeURIComponent(appointmentId)+'/attachments',{method:'POST',headers:{Authorization:'Bearer '+token,'Idempotency-Key':key},body,signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});}catch(e){if(signal.aborted)throw e;throw Error('Se interrumpió la conexión y no pudimos comprobar la recepción. Reintenta con la misma selección; si el archivo ya llegó, se recuperará sin duplicarlo.');}
 const result=await response.json().catch(()=>null);
 if(!response.ok)throw Error(typeof result?.message==='string'?result.message:'No pudimos adjuntar el documento. Intenta de nuevo con el mismo archivo; el envío no se duplicará.');
 if(!result?.id)throw Error('No pudimos comprobar la recepción. Actualiza los documentos antes de volver a enviarlo.');
 return result;
}
