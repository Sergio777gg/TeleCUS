import type {UsageMetrics} from '../ports/workspace.js';
/** Counts actual HTTP requests to the AI service, without logging prompts, content or tokens. */
export function meteredTransport(transport:typeof fetch,metrics:UsageMetrics,route:string):typeof fetch {
  return async(input,options)=>{const start=Date.now();let success=false;try{const response=await transport(input,options);success=response.ok;return response;}finally{await metrics.record(route,'PATIENT',Date.now()-start,success).catch(()=>{});}};
}
