import type { Profile } from '../types.js';
export interface AgendaPort {
  publicRejections?(actor:Profile,ids:string[]):Promise<any[]>;
  visitsAvailable?:boolean;
  appointments?(actor:Profile,ids?:string[]):Promise<any[]>;
  serviceAvailability?(actor:Profile,date:string):Promise<string[]>;
  patientAppointments?(actor:Profile,code?:string):Promise<any[]>;
  deliveryStatus(actor:Profile):Promise<{code:string;operation:string;stage:string;status:string}[]>;
  doctors(actor:Profile):Promise<{id:string;full_name:string}[]>;
  availability(actor:Profile,doctor:string,date:string):Promise<string[]>;
  execute(actor:Profile,id:string,kind:string,payload:Record<string,unknown>):Promise<string>;
}
export type GoogleAppointment={id:string;code:string;start_time:string;end_time:string;patient_email:string;doctor_email:string;previous_doctor_email?:string;calendar_event_id?:string;meet_url?:string};
export type GoogleTask={operation:'confirm'|'reschedule'|'cancel'|'complete'|'assign_doctor';appointment:GoogleAppointment;delivery_id:string};
export interface GooglePort {
  calendar(task:GoogleTask):Promise<{calendar_event_id?:string;meet_url?:string}>;
  sendNotification(task:GoogleTask):Promise<{id?:string}>;
}
export interface DeliveryStore {call(name:string,args?:unknown[]):Promise<any>;}
