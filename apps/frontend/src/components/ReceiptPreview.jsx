import {useEffect,useRef} from 'react';
export function ReceiptPreview({preview,onDownload}){
  const dialog=useRef(null);
  useEffect(()=>{if(preview.view&&!dialog.current.open)dialog.current.showModal();if(!preview.view&&dialog.current.open)dialog.current.close();},[preview.view]);
  return <dialog className="receipt-preview" ref={dialog} onClose={preview.close} aria-labelledby={preview.kind==='clinical'?'clinical-preview-title':'receipt-preview-title'}>
    <header className="payment-header"><div><p className="section-number">{preview.kind==='clinical'?'VISTA DEL DOCUMENTO PRIVADO':'VISTA DEL COMPROBANTE'}</p><h2 id={preview.kind==='clinical'?'clinical-preview-title':'receipt-preview-title'}>{preview.view?.receipt.file_name||'Comprobante'}</h2></div><button type="button" className="payment-close" onClick={preview.close} aria-label="Cerrar previsualización" autoFocus>×</button></header>
    <div className="receipt-preview-content">
      {preview.error&&<p role="alert" className="payment-error">{preview.error}</p>}
      {preview.busy&&<p role="status">Preparando la vista…</p>}
      {!preview.view?.loading&&<div className="receipt-pagination"><button type="button" disabled={preview.busy||preview.zoom===1} onClick={preview.reduce}>Reducir</button><span>{({1:'100%',2:'150%',3:'200%'})[preview.zoom]}</span><button type="button" disabled={preview.busy||preview.zoom===3} onClick={preview.enlarge}>Ampliar</button></div>}
      {preview.zoom>1&&<p className="payment-hint">Desplázate dentro de la vista para leer la página ampliada.</p>}
      {preview.view?.url&&<img src={preview.view.url} alt={preview.kind==='clinical'?'Documento adjunto':'Comprobante adjunto'} className={"receipt-image receipt-zoom-"+preview.zoom}/>}
      {preview.view?.pages&&<><nav className="receipt-pagination" aria-label="Páginas del comprobante"><button type="button" disabled={preview.busy||preview.page===1} onClick={preview.previous}>Anterior</button><span>Página {preview.page} de {preview.view.pages}</span><button type="button" disabled={preview.busy||preview.page===preview.view.pages} onClick={preview.next}>Siguiente</button></nav><canvas className={'receipt-zoom-'+preview.zoom} ref={preview.canvas} role="img" aria-label={'Página '+preview.page+' del comprobante. Para una lectura accesible puedes descargar el original.'}/></>}
      {preview.view?.receipt.id&&<button type="button" className="payment-secondary" onClick={()=>onDownload(preview.view.receipt)}>Descargar original</button>}
      {preview.view?.receipt.context!=='payment-history'&&<p className="payment-hint">{preview.kind==='clinical'?'La revisión de legibilidad no equivale a una interpretación clínica ni confirma la cita.':'Ver el archivo no verifica el pago. Confirma siempre el recaudo por el medio institucional.'}</p>}
    </div>
  </dialog>;
}
