/** Consistent visual treatment for contextual chat actions; permissions stay in the backend. */
export function ChatActionButton({children,disabled,onClick}){
 return <button type="button" className="choice-button" disabled={disabled} onClick={onClick}><span>{children}</span><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 5 7 7-7 7"/></svg></button>;
}
