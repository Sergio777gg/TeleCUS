import {useEffect,useState} from 'react';
import {MessageText} from './MessageText';
import {ChatActionButton} from './ChatActionButton';

/** Presentation only. An action goes to the hook and authenticated API for validation. */
export function ChatMessage({message,activeProposal,busy,onAction,onSupport,onUiAction,supportPhone,onChoose}){
  const [now,setNow]=useState(Date.now());
  const proposal=message.proposal,expired=proposal&&new Date(proposal.expires_at).getTime()<=now,canReview=proposal&&activeProposal?.id===proposal.id;
  useEffect(()=>{if(!canReview)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[canReview]);
  return <article className={'message '+(message.author==='user'?'user':'')}>
    <p className="message-author">{message.author==='user'?'Tú':'Asistente TeleCUS'}</p>
    <div className="message-text"><MessageText text={message.text}/></div>
    {message.choices&&<div className="proposal-actions chat-choices" role="group" aria-label="Opciones para continuar">{message.choices.map(choice=><ChatActionButton disabled={busy||!onChoose} key={choice.value} onClick={()=>onChoose?.(choice.value,choice.label)}>{choice.label}</ChatActionButton>)}</div>}
    {canReview&&<div className="proposal-actions">
      {!message.text.includes(proposal.summary)&&<details className="pending-details"><summary>Revisar los datos pendientes</summary><p>{proposal.summary}</p></details>}
      <button className="confirm-button" disabled={busy||expired} onClick={()=>onAction('confirm',proposal.id)}>Confirmar</button>
      <button className="dismiss-button" disabled={busy} onClick={()=>onAction('dismiss',proposal.id)}>Descartar</button>
      <span>{expired?'Esta revisión venció. Solicita la operación otra vez para revisar los datos actuales.':'Confirma esta operación antes de las '+new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',hour:'numeric',minute:'2-digit',hour12:true}).format(new Date(proposal.expires_at))+' Esta confirmación vence para que revises datos actualizados.'}</span>
    </div>}
    {message.ui_action==='payments'&&<div className="proposal-actions chat-choices"><ChatActionButton disabled={busy||!onUiAction} onClick={()=>onUiAction?.('payments')}>Abrir pagos del panel</ChatActionButton></div>}
    {message.handoff&&onSupport&&<div className="handoff-card">{message.handoff.reason!=='requested'&&<p>Si tienes dificultades con el chat, el equipo de TeleCUS puede resolver tus dudas y ayudarte a agendar la cita.</p>}{supportPhone&&<p>WhatsApp: +{supportPhone}</p>}<ChatActionButton disabled={busy} onClick={()=>onSupport?.(message.handoff.reason)}>Contactar por WhatsApp</ChatActionButton></div>}
  </article>;
}
