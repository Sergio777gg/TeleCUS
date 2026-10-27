import type {ScheduleBook} from '../application/service-schedule.js';
import type {Profile,Role} from '../types.js';
export type PortalSettings={version:string;payment_url:string;support_phone:string;payments_enabled?:boolean;visit_workflow_available?:boolean};
export type KnowledgeDocument={file:string;title:string;roles:string[];body:string;version?:string};
export interface KnowledgeCatalog {
  documents():KnowledgeDocument[];
  validate(file:string,body:string):void;
  preview(file:string,body:string,query:string,role:Role):unknown;
}
export interface AdministrationStore {
  schedules():Promise<ScheduleBook>;
  readonly demo?:boolean;
  initialize(catalog:KnowledgeDocument[],writeSeeds:boolean):Promise<void>;
  available():boolean;
  settings():Promise<PortalSettings>;
  published():Promise<KnowledgeDocument[]>;
  read(user:Profile,resource:string,filter:Record<string,unknown>):Promise<any>;
  write(user:Profile,requestId:string,resource:string,expected:string,payload:Record<string,unknown>):Promise<any>;
  claimRegistration(id:string):Promise<void>;
  prepareReview(user:Profile,appointmentId:string,requestId:string):Promise<any>;
  confirmReview(user:Profile,id:string):Promise<any>;
}
