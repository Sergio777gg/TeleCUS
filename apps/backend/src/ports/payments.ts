import type { Profile } from '../types.js';

export type PaymentReceipt = {id:string;file_name:string;content_type:string;size:number;created_at:string};
export type PaymentItem = {
  appointment_id:string;code:string;doctor_name:string;start_time:string;status:string;payment_status:string;
  expires_at?:string;hold_expired?:boolean;processing:boolean;can_pay:boolean;can_upload:boolean;can_withdraw?:boolean;receipt:PaymentReceipt|null;
};
export type PaymentPage = {items:PaymentItem[];receiptsAvailable:boolean};
export type PaymentFileInput = {file_name:unknown;content_type:unknown;data:unknown};
/** Validated by the use case; adapters independently enforce access and persisted state. */
export type ValidatedPaymentFile = {file_name:string;content_type:string;size:number;sha256:string;data:Buffer};
export type PaymentDownload = PaymentReceipt & {data:Buffer};
export interface PaymentBlobStore {
  put(key:string,data:Buffer,sha256:string):Promise<void>;
  get(key:string):Promise<Buffer>;
}
export interface PaymentReceiptStore {
  initialize():Promise<void>;
  available():boolean;
  list(user:Profile):Promise<PaymentPage>;
  upload(user:Profile,appointmentId:string,requestId:string,file:ValidatedPaymentFile):Promise<PaymentReceipt>;
  download(user:Profile,id:string):Promise<PaymentDownload>;
  withdraw?(user:Profile,id:string,requestId:string):Promise<{id:string;withdrawn:true}>;
}
