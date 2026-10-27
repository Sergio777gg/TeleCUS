const days=['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
const clock=value=>{const [h,m]=value.split(':');return `${Number(h)%12||12}:${m} ${Number(h)<12?'a':'p'}. m.`;};
const times=Array.from({length:48},(_,i)=>String(Math.floor(i/2)).padStart(2,'0')+':'+(i%2?'30':'00'));
export function ScheduleEditor({editor,onChange,items,disabled,onReview}){
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota'}).format(new Date());
  return <section><h3>Horarios y pre-reservas</h3><p>Configura los días de atención y una franja común para los médicos activos, en hora de Colombia. Cada cita dura 30 minutos. Las citas y comprobantes existentes se conservan.</p>
    <form className="admin-form" onSubmit={e=>{e.preventDefault();onReview({days:editor.days,start:editor.start,end:editor.end,effective_from:editor.effective_from,hold_hours:Number(editor.hold_hours)});}}>
      <fieldset><legend>Días de atención</legend><div className="admin-days">{[1,2,3,4,5,6,0].map(d=><label className="admin-checkbox" key={d}><input type="checkbox" checked={editor.days.includes(d)} onChange={e=>onChange({...editor,days:e.target.checked?[...editor.days,d].sort():editor.days.filter(v=>v!==d)})}/>{days[d]}</label>)}</div></fieldset>
      <div className="admin-filters">{[['start','Inicio de atención'],['end','Fin de atención']].map(([key,label])=><label key={key}>{label}<select value={editor[key]} onChange={e=>onChange({...editor,[key]:e.target.value})}>{times.map(t=><option key={t} value={t}>{clock(t)}</option>)}</select></label>)}</div>
      <label>Aplicar a las fechas de cita desde<input type="date" required min={today} value={editor.effective_from} onChange={e=>onChange({...editor,effective_from:e.target.value})}/></label>
      <label>Plazo de nuevas pre-reservas (horas)<input type="number" min={1} max={168} step={1} required value={editor.hold_hours} onChange={e=>onChange({...editor,hold_hours:e.target.value})}/></label>
      <p>El plazo se cuenta desde la creación de la pre-reserva y termina, como máximo, al comenzar la cita. Sin comprobante, el cupo se libera al vencer. Con comprobante, queda en revisión administrativa: recibir un archivo no demuestra el pago.</p>
      <p>Este ajuste no mueve citas existentes ni reinicia sus plazos. Un nuevo horario para una misma fecha de vigencia sustituye su configuración anterior para nuevas operaciones. Los cambios quedan versionados y auditados.</p>
      <button type="submit" className="payment-link" disabled={disabled||!editor.days.length||editor.end<=editor.start}>Revisar horario y plazo</button>
    </form>
    <h4>Historial de configuración</h4><div className="admin-list">{[...items].sort((a,b)=>Number(b.version)-Number(a.version)).slice(0,20).map(p=><article key={p.version}><strong>Desde {p.effective_from} · versión {p.version}</strong><p>{p.days.map(d=>days[d]).join(', ')} · {clock(p.start)} a {clock(p.end)}<br/>Pre-reserva: {p.hold_hours} horas como máximo</p></article>)}</div>
  </section>;
}
