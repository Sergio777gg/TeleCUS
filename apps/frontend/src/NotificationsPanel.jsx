import {useEffect,useRef} from 'react';
import {useNotifications} from './useNotifications';
const date=value=>new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',dateStyle:'short',timeStyle:'short',hour12:true}).format(new Date(value));
export function NotificationsPanel({token,profile,refreshKey,onView}){
  const inbox=useNotifications(token,profile.id+'|'+profile.role,refreshKey),dialog=useRef(null),button=useRef(null);
  useEffect(()=>()=>{dialog.current?.close();},[]);
  function open(){dialog.current?.showModal();inbox.refresh();}
  function close(){dialog.current?.close();button.current?.focus();}
  const visibleUnread=inbox.items.filter(n=>!n.read_at).slice(0,50).map(n=>n.id);
  return <><button className="notification-bell" ref={button} onClick={open} aria-label={`Notificaciones: ${inbox.unread} sin leer`}>
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M9 21h6"/></svg><span>Notificaciones</span>{inbox.unread>0&&<span className="notification-count">{inbox.unread>99?'99+':inbox.unread}</span>}
  </button><dialog className="notifications-dialog" ref={dialog} aria-labelledby="notifications-title" onClick={e=>{if(e.target===dialog.current){const b=dialog.current.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)close();}}}>
    <header className="notifications-header"><div><p className="section-number">TU AGENDA</p><h2 id="notifications-title">Notificaciones</h2></div><button className="notification-close" onClick={close} aria-label="Cerrar notificaciones">×</button></header>
    <p className="notifications-intro">Aquí verás solicitudes, pagos y cambios importantes de tu agenda. <strong>{inbox.unread} sin leer.</strong></p>
    <div className="notifications-tools"><button onClick={inbox.refresh} disabled={inbox.busy}>Actualizar</button><button onClick={()=>inbox.markRead(visibleUnread)} disabled={inbox.busy||!visibleUnread.length}>Marcar las visibles como leídas</button><button onClick={()=>inbox.remove([],true)} disabled={inbox.busy||!inbox.read_count}>Eliminar leídas</button></div>
    {(inbox.notice||inbox.canUndo)&&<div className="notifications-cleanup" role="status">{inbox.notice&&<p>{inbox.notice}</p>}{inbox.canUndo&&<button type="button" disabled={inbox.busy} onClick={inbox.restore}>Deshacer eliminación</button>}</div>}
    {inbox.error&&<p className="notifications-error" role="status">{inbox.error}</p>}
    {!inbox.items.length?<p className="notifications-empty">{inbox.busy?'Consultando las notificaciones…':'No hay notificaciones en tu bandeja. Las próximas novedades de tu agenda aparecerán aquí.'}</p>:<ol className="notification-list">{inbox.items.map(n=><li key={n.id} className={n.read_at?'':'notification-unread'}><div className="notification-item-title"><h3>{n.title}</h3>{!n.read_at&&<span className="unread-dot" aria-label="Sin leer"/>}</div><p>{n.body}</p><div className="notification-item-footer">{n.target&&onView&&<button type="button" disabled={inbox.busy} onClick={()=>{close();if(!n.read_at)void inbox.markRead([n.id]);onView(n.target);}}>Ver cita</button>}<time dateTime={n.created_at}>{date(n.created_at)}</time>{!n.read_at&&<button onClick={()=>inbox.markRead([n.id])} disabled={inbox.busy}>Marcar como leída</button>}<button type="button" disabled={inbox.busy} aria-label={'Eliminar notificación: '+n.title} onClick={()=>inbox.remove([n.id])}>Eliminar</button></div></li>)}</ol>}
    {inbox.next_cursor&&<button className="notification-more" onClick={inbox.more} disabled={inbox.busy}>Ver anteriores</button>}<p className="notifications-footnote">Se actualizan automáticamente mientras tienes TeleCUS abierto. La agenda contiene el estado actual de cada cita. Eliminar limpia tu bandeja y conserva las gestiones registradas. Puedes deshacer la última eliminación antes de recargar la página o cerrar sesión.</p>
  </dialog></>;
}
