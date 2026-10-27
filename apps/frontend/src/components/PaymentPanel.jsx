import {useEffect,useRef,useState} from 'react';

const formatDate=value=>{const parsed=new Date(value);return Number.isNaN(parsed.valueOf())?'Consulta el horario en tu cita':new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',dateStyle:'long',timeStyle:'short',hour12:true}).format(parsed);};
const formatSize=value=>value<1024*1024?Math.max(1,Math.round(value/1024))+' KB':(value/(1024*1024)).toFixed(1)+' MB';

/** Presentation only: backend eligibility controls every payment and receipt action. */
export function PaymentPanel({mode,portal,role,payments,onReview,reviewDisabled,onPreview,showTrigger=true,openSignal=0}){
  const dialog=useRef(null),trigger=useRef(null),lastAutoOpen=useRef(0),[now,setNow]=useState(Date.now()),[opened,setOpened]=useState(false),[withdrawal,setWithdrawal]=useState(null);
  useEffect(()=>{if(!opened)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[opened]);
  useEffect(()=>{if(openSignal)setOpened(true);},[openSignal]);
  const eligible=item=>!item.expires_at||Boolean(item.receipt)||new Date(item.expires_at).getTime()>now;
  const administrative=role==='ADMIN',items=administrative?payments.items.filter(item=>item.receipt):payments.items;
  const visible=administrative||(payments.loaded&&items.length>0);
  const paymentFinished=payments.loaded&&!items.length&&!payments.error;
  useEffect(()=>{
    if(payments.autoOpenKey>lastAutoOpen.current&&!administrative&&payments.items.length)setOpened(true);
    lastAutoOpen.current=payments.autoOpenKey;
  },[payments.autoOpenKey,administrative,payments.items]);
  useEffect(()=>{
    if(opened&&!dialog.current?.open)dialog.current?.showModal();
    if(!opened&&dialog.current?.open)dialog.current.close();
  },[opened,visible]);
  useEffect(()=>()=>{dialog.current?.close();},[]);
  function close(){setOpened(false);setWithdrawal(null);}
  function open(){setOpened(true);void payments.refresh();}
  if(!visible&&!opened)return null;
  return <>
    {visible&&showTrigger&&<button type="button" className="payment-trigger" ref={trigger} onClick={open} aria-haspopup="dialog">
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h3"/></svg>
      <span>{administrative?'Comprobantes':`${items[0].processing?'Pago en revisión':items[0].receipt?'Comprobante enviado':'Pago pendiente'} · ${items[0].code}`}</span>{administrative&&items.length>0&&<span className="payment-count">{items.length}</span>}
    </button>}
    <dialog className="payment-dialog" ref={dialog} aria-labelledby="payment-title" aria-describedby="payment-description" onClose={()=>{setOpened(false);trigger.current?.focus();}}>
      <header className="payment-header"><div><p className="section-number">{administrative?'REVISIÓN ADMINISTRATIVA':'SIGUIENTE PASO DE TU CITA'}</p><h2 id="payment-title">{administrative?'Comprobantes de pago':paymentFinished?'Estado de tu pago':'Completa tu pre-reserva'}</h2></div><button type="button" className="payment-close" onClick={close} aria-label="Cerrar pagos" autoFocus>×</button></header>
      <div className="payment-content">
      <p id="payment-description">{administrative?'Revisa el comprobante y contrasta el pago antes de verificarlo. Recibir un archivo no confirma el pago ni la cita.':paymentFinished?'Esta gestión ya no tiene un pago pendiente. Consulta el estado actual de tu cita en el chat.':!payments.loaded||payments.error?'Estamos consultando el estado del pago. Las acciones estarán disponibles cuando podamos verificarlo.':items.some(item=>item.receipt||item.processing)?'Aquí puedes seguir la revisión del pago de tu pre-reserva. Te avisaremos cuando la cita quede confirmada.':'Tu pre-reserva ya está registrada. Realiza el pago y adjunta aquí su comprobante para que el Administrador pueda revisarlo.'}</p>
      {!administrative&&items.length>0&&<ol className="payment-steps" aria-label="Pasos para confirmar tu cita"><li>Pre-reserva</li><li>Pago en SIREC</li><li>Comprobante</li><li>Revisión</li></ol>}
      {mode==='demo'&&<p className="payment-environment">Versión de prueba: usa solo archivos ficticios, sin datos personales ni financieros. El pago real está deshabilitado.</p>}
      {payments.error&&<p className="payment-error" role="alert">{payments.error}</p>}
      {administrative&&payments.loaded&&!payments.receiptsAvailable&&<p className="payment-environment">La recepción de comprobantes aún no está habilitada en este entorno. Puedes seguir revisando los pagos en el chat.</p>}
      {administrative&&items.length===100&&<p className="payment-hint">Se muestran hasta 100 comprobantes pendientes, ordenados por horario. Al completar revisiones se cargarán los siguientes.</p>}
      {payments.notice&&items.length>0&&<p className={items.some(item=>item.receipt)?'sr-only':'payment-notice'} role="status">{payments.notice}</p>}
      {!payments.loaded?<p className="payment-hint" role="status">Consultando los pagos…</p>:!items.length?<p className="payment-empty">{administrative?'Por ahora no hay comprobantes pendientes de revisión.':'No hay una pre-reserva con pago pendiente. Consulta el estado actual de tu cita en el chat.'}</p>:<div className="payment-items">{items.map(item=><article className="payment-appointment" key={item.appointment_id} aria-label={'Pago de '+item.code}>
        <header className="payment-appointment-heading"><h3>{item.code}</h3><span>{item.processing?'En proceso':item.receipt?'Comprobante recibido':'Pago pendiente'}</span></header>
        <p className="payment-doctor">{item.doctor_name}</p><p className="payment-date">{formatDate(item.start_time)}</p>
        {!item.processing&&(item.receipt?<p className="payment-hint">El cupo permanece reservado durante la revisión del comprobante. No vuelvas a pagar.</p>:item.expires_at?<p className={eligible(item)?'payment-hint':'payment-error'} role="status">{eligible(item)?'Paga y adjunta tu comprobante antes del '+formatDate(item.expires_at)+'. Sin comprobante, se liberará el cupo.':'El plazo venció. Actualiza y consulta disponibilidad antes de pagar. Si ya pagaste, contacta al equipo de TeleCUS.'}</p>:<p className="payment-hint">Esta pre-reserva anterior no tiene vencimiento automático. Consulta al Administrador si necesitas cambiarla.</p>)}
        {item.processing?<p className="payment-state">Estamos procesando la confirmación. No vuelvas a pagar ni envíes otro comprobante. Te avisaremos cuando termine.</p>:item.receipt?<>
          <p className="payment-state">{administrative?'Comprobante pendiente de revisión.':'Recibimos tu comprobante. Está pendiente de revisión administrativa; no necesitas pagar otra vez.'}</p>
          <div className="payment-receipt"><div><strong>{item.receipt.file_name}</strong><span>{formatSize(item.receipt.size)} · Recibido {formatDate(item.receipt.created_at)}</span></div><div className="payment-receipt-actions"><button type="button" className="payment-secondary" disabled={payments.busy} onClick={()=>onPreview?.(item.receipt)}>Ver comprobante</button><button type="button" className="payment-secondary" disabled={payments.busy} onClick={()=>payments.download(item.receipt)}>{payments.working===item.receipt.id?'Descargando…':'Descargar'}</button></div></div>
          {!administrative&&item.can_withdraw&&<><button type="button" className="payment-secondary" disabled={payments.busy} onClick={()=>setWithdrawal(item.receipt.id)}>Corregir comprobante</button>{withdrawal===item.receipt.id&&<div className="payment-withdrawal"><p>Retiraremos este archivo de la revisión. El pago conserva su estado. Adjunta el correcto antes del plazo mostrado; si este ya venció, tendrás hasta 15 minutos sin superar el inicio de la cita; el registro anterior se conserva para trazabilidad.</p><div className="admin-actions"><button type="button" className="payment-secondary" disabled={payments.busy} onClick={async()=>{await payments.withdraw(item.receipt);setWithdrawal(null);}}>Confirmar retiro</button><button type="button" className="payment-secondary" disabled={payments.busy} onClick={()=>setWithdrawal(null)}>Conservar archivo</button></div></div>}</>}
          {administrative&&onReview&&<button type="button" className="payment-link" disabled={payments.busy||reviewDisabled} onClick={()=>{close();onReview(item);}}>Revisar y verificar pago</button>}
        </>:!administrative?<>
          <div className="payment-provider"><strong>1. Paga en SIREC</strong><span>Portal de la Universidad del Cauca</span></div>
          {mode==='supabase-live'&&item.can_pay&&eligible(item)&&portal?.url?<><a className="payment-link" href={portal.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Abrir portal de pago <span aria-hidden="true">↗</span><span className="sr-only"> (se abre en otra pestaña)</span></a><p className="payment-hint">Tu conversación permanece aquí. Si ya pagaste, continúa con el comprobante.</p></>:<><button type="button" className="payment-link" disabled>Pago externo no habilitado</button><p className="payment-hint">{mode==='demo'?'Puedes practicar el envío del comprobante sin hacer un pago real.':'El pago externo no está disponible en este entorno. Consulta al Administrador.'}</p></>}
          <section className="payment-upload" aria-label={'Comprobante de '+item.code}><h4>2. Adjunta el comprobante</h4>{!payments.receiptsAvailable?<p className="payment-hint">El envío de comprobantes aún no está activado. Consulta al Administrador para entregar tu recibo.</p>:!item.can_upload||!eligible(item)?<p className="payment-hint">En este momento no puedes enviar un comprobante para esta cita. Actualiza para revisar su estado.</p>:<>
            <label className="payment-file-label" htmlFor={'receipt-'+item.appointment_id}>Elegir PDF, JPG o PNG · máximo 5 MB</label>
            <input key={payments.selection?.appointmentId===item.appointment_id?payments.selection.idempotencyKey:'empty'} className="payment-file" id={'receipt-'+item.appointment_id} type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" disabled={payments.busy} onChange={event=>payments.chooseFile(item.appointment_id,event.target.files?.[0]||null)}/>
            {payments.selection?.appointmentId===item.appointment_id&&<><div className="payment-selection"><div><strong>{payments.selection.file.name}</strong><span>{formatSize(payments.selection.file.size)} · Aún no se ha enviado</span></div><button type="button" className="payment-secondary" disabled={payments.busy} onClick={payments.clearFile}>Quitar</button></div><button type="button" className="payment-secondary" onClick={()=>onPreview?.({file_name:payments.selection.file.name,content_type:payments.selection.file.type||({pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png'})[payments.selection.file.name.split('.').pop().toLowerCase()]},payments.selection.file)}>Ver antes de enviar</button><button type="button" className="payment-link" disabled={payments.busy} onClick={payments.upload}>{payments.working==='upload'?'Enviando comprobante…':'Enviar comprobante'}</button></>}
          </>}</section>
        </>:null}
      </article>)}</div>}
      {payments.error&&<button type="button" className="payment-secondary payment-refresh" disabled={payments.busy} onClick={payments.refresh}>Reintentar consulta</button>}
      <p className="payment-review">{administrative?'Solo el Administrador verifica el pago. La agenda y las notificaciones informarán cuando la cita quede confirmada.':'Abrir SIREC o adjuntar un archivo no confirma la cita. El Administrador verifica el pago y recibirás la confirmación cuando se complete la agenda.'}</p>
      </div>
    </dialog>
  </>;
}
