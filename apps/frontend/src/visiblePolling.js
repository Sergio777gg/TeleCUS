/** Read-only polling: one cycle at a time, no hidden-tab timers, bounded backoff. */
export function startVisiblePolling({task,intervalMs,maxDelayMs=120000,immediate=true,canRun=()=>true},platform=globalThis){
  const page=platform.document,events=platform.window||platform;
  let disposed=false,running=false,timer=null,failures=0,lastStarted=-Infinity;
  const visible=()=>page.visibilityState==='visible';
  const clear=()=>{if(timer!==null)platform.clearTimeout(timer);timer=null;};
  function schedule(){
    clear();if(disposed||!visible())return;
    const delay=Math.min(maxDelayMs,intervalMs*2**Math.min(failures,3));
    timer=platform.setTimeout(tick,Math.min(maxDelayMs,delay*(1+platform.Math.random()*.1)));
  }
  async function tick(){
    clear();if(disposed||!visible()||running)return;
    if(!canRun()){schedule();return;}
    running=true;lastStarted=platform.Date.now();
    try{failures=await task()===false?failures+1:0;}catch{failures++;}
    finally{running=false;schedule();}
  }
  function resume(){
    if(!visible()){clear();return;}
    if(disposed||running)return;
    // Focus and visibilitychange often describe the same return to this tab.
    if(platform.Date.now()-lastStarted<1000){if(timer===null)schedule();return;}
    void tick();
  }
  page.addEventListener('visibilitychange',resume);events.addEventListener('focus',resume);
  if(immediate)void tick();else schedule();
  return ()=>{disposed=true;clear();page.removeEventListener('visibilitychange',resume);events.removeEventListener('focus',resume);};
}

/** Fetch only the read models consumed by the active staff section. */
export function workspaceReads(role,section){
  return {appointments:['summary','appointments'].includes(section),requests:role==='ADMIN'&&section==='requests',doctors:role==='ADMIN'&&['appointments','availability'].includes(section)};
}
