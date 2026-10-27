const groups = [
  { label: 'Agenda', keys: ['summary', 'appointments', 'requests', 'availability', 'information'] },
  { label: 'Atención y personas', keys: ['payments', 'people', 'registrations'] },
  { label: 'Configuración', keys: ['schedule', 'knowledge', 'settings', 'usage'] }
];
const paths = {
  summary: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  appointments: 'M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4 M8 14h2 M14 14h2 M8 17h2',
  requests: 'M4 7h15 M15 3l4 4-4 4 M20 17H5 M9 13l-4 4 4 4',
  availability: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',
  payments: 'M3 6h18v14H3z M3 10h18 M6 15h4 M15 15h3',
  people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M18 7a3 3 0 0 1 0 6 M22 21v-2a4 4 0 0 0-3-4',
  registrations: 'M4 3h12v18H4z M7 7h6 M7 11h4 M16 15h6 M19 12v6',
  schedule: 'M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4 M8 14l2 2 5-3',
  knowledge: 'M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1z M12 5v15',
  settings: 'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
  usage: 'M4 3v18h17 M8 17v-5 M13 17V8 M18 17V4',
  information: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 10v7 M12 7v.5'
};

/** Presentation only: navigation state and permissions remain in the dashboard. */
export function WorkspaceNavigation({sections, current, disabled, onChoose}) {
  return <>
    <label className="staff-mobile-nav">Ir a la sección
      <select value={current} disabled={disabled} onChange={event => onChoose(event.target.value)}>
        {sections.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
    </label>
    <nav className="staff-navigation" aria-label="Navegación de trabajo">
      {groups.map(group => {
        const items = sections.filter(([key]) => group.keys.includes(key));
        if (!items.length) return null;
        return <div className="staff-nav-group" key={group.label}>
          <p className="staff-nav-group-label">{group.label}</p>
          {items.map(([key, label]) => <button key={key} type="button"
            className={'staff-nav ' + (current === key ? 'selected' : '')}
            disabled={disabled} aria-current={current === key ? 'page' : undefined}
            onClick={() => onChoose(key)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[key] || paths.summary}/></svg>
            <span>{label}</span>
          </button>)}
        </div>;
      })}
    </nav>
  </>;
}
