import type {Profile} from '../types.js';
export type StaffFilter={view:'current'|'history'|'all';q:string;offset:number};
export type StaffReview={id:string;actor_id:string;role:string;expires_at:string;kind:string;payload:Record<string,any>;snapshot:unknown;details:Record<string,any>};
export interface ReviewSigner {seal(value:StaffReview):string;open(token:string):StaffReview;}
export interface WorkspaceStore {
  initialize():Promise<void>;
  page(actor:Profile,filter:StaffFilter):Promise<any>;
  requests(actor:Profile,filter:StaffFilter):Promise<any>;
  snapshot(actor:Profile,kind:string,payload:Record<string,any>):Promise<{snapshot:unknown;details:Record<string,any>}>;
  commit(actor:Profile,review:StaffReview):Promise<string>;
}
export interface UsageMetrics {record(route:string,role:string,elapsed:number,success:boolean):Promise<void>;read():Promise<unknown>;}
