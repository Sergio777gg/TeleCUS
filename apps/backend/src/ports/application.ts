import type {ScheduleBook} from '../application/service-schedule.js';
import type {VisitPolicy} from '../application/visit-policy.js';
import type { ChatInput, Intent, Profile, Reply, Role } from '../types.js';
import type { Grounding } from '../conversation.js';
import type { Connection } from './storage.js';
export type Doctor = {id:string;full_name:string};
export type Appointment = {id:string;code:string;patient_id:string;doctor_id:string;start_time:string;end_time:string;status:string;payment_status:string;meet_url?:string|null;appointment_type?:string|null};
export type Change = {id:string;appointment_id:string;patient_id:string;request_type:string;status:string;requested_start_time?:string|null;requested_end_time?:string|null;created_at?:string};
export type ChangeDetails = Change & {appointment_code?:string;current_start_time?:string;appointment_status?:string;doctor_name?:string;public_reason?:string;rejection_category?:string};
export type PendingDelivery={code:string;operation:string;stage:string;status:string;payment_required?:boolean};
export interface SchedulingRepository {
  readonly mode:string;
  schedules?(connection?:Connection):Promise<ScheduleBook>;
  visitPolicy?(connection?:Connection):Promise<VisitPolicy>;
  doctors(user:Profile,connection?:Connection):Promise<Doctor[]>;
  appointments(user:Profile,connection?:Connection,ids?:string[]):Promise<Appointment[]>;
  portalAppointments?(user:Profile,code?:string,connection?:Connection):Promise<any[]>;
  changeDetails(user:Profile,connection?:Connection,all?:boolean):Promise<ChangeDetails[]>;
  availability(user:Profile,doctor:string,date:string,connection?:Connection):Promise<string[]>;
  serviceAvailability?(user:Profile,date:string,connection?:Connection):Promise<string[]>;
  allocateDoctor?(user:Profile,date:string,time:string,connection?:Connection):Promise<Doctor|null>;
  pendingDeliveries(user:Profile):Promise<PendingDelivery[]>;
  execute(user:Profile,kind:string,payload:Record<string,any>,connection:Connection,operationId?:string):Promise<string>;
}
export interface SessionRepository {
  load(user:Profile,id:string,connection?:Connection):Promise<any>;
  save(user:Profile,id:string,state:any,connection:Connection):Promise<unknown>;
  lock(user:Profile,id:string,connection:Connection):Promise<void>;
}
export type PreparedKnowledge=string|{text:string;resolved:boolean};
export interface KnowledgePort {answer(question:string,role:Role):Promise<string>;answerResult?(question:string,role:Role):Promise<{text:string;resolved:boolean}>;}
export interface InterpretationPort {interpret(message:string,context:Grounding):Promise<unknown>;}
export interface IdentityPort {authenticate(authorization:unknown):Promise<Profile>;demoLogin(role:Role):Promise<unknown>;}
export interface ConversationUseCases {
  grounding(user:Profile,input:ChatInput):Promise<Grounding>;
  prepareKnowledge(user:Profile,input:ChatInput,intent:Intent|null):Promise<PreparedKnowledge|undefined>;
  process(user:Profile,input:ChatInput,intent:Intent|null,connection?:Connection,preparedKnowledge?:PreparedKnowledge):Promise<Reply>;
  invalidateRejectedConfirmation(user:Profile,input:ChatInput,connection:Connection):Promise<void>;
}
export type NotificationEvent = {id:string;created_at:string;read_at:string|null;event_type:string;payload:Record<string,unknown>};
export type NotificationPage = {items:NotificationEvent[];unread:number;next_cursor:string|null;read_count?:number};
export interface NotificationInbox {
  list(user:Profile,before:string|undefined,limit:number):Promise<NotificationPage>;
  read(user:Profile,ids:string[]):Promise<number>;
  remove?(user:Profile,ids:string[],read:boolean,batch:string):Promise<number>;
  restore?(user:Profile,batch:string):Promise<number>;
}
