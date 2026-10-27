import type { ChatInput, Profile } from '../types.js';
import type { IdentityPort } from '../ports/application.js';
import type { AdministrationService } from '../application/administration.js';
import type {WorkspaceService} from '../application/workspace.js';
import type { PaymentService } from '../application/payments.js';
import type {ClinicalDocumentService} from '../application/clinical-documents.js';
import type {PatientWorkspaceService} from '../application/patient-workspace.js';

export const IDENTITY=Symbol('telecus.identity');
export const CHAT=Symbol('telecus.chat');
export const NOTIFICATIONS=Symbol('telecus.notifications');
export const DELIVERY_QUERIES=Symbol('telecus.delivery-queries');
export const SYSTEM_QUERIES=Symbol('telecus.system-queries');
export const PAYMENTS=Symbol('telecus.payments');
export interface ChatRequests {
  enqueue(user:Profile,input:ChatInput,authorization:string):Promise<unknown>;
  get(user:Profile,id:string):Promise<unknown>;
}
export interface NotificationRequests {
  list(user:Profile,before?:string,limit?:number):Promise<unknown>;
  read(user:Profile,ids:unknown):Promise<unknown>;
  remove?(user:Profile,input:unknown):Promise<unknown>;
  restore?(user:Profile,input:unknown):Promise<unknown>;
}
export interface DeliveryQueries {list(user:Profile):Promise<unknown>;}
export interface SystemQueries {configuration():Record<string,unknown>|Promise<Record<string,unknown>>;health():Promise<Record<string,unknown>>;}
export type PaymentRequests=Pick<PaymentService,'list'|'upload'|'download'> & Partial<Pick<PaymentService,'withdraw'>>;
export type HttpBindings={identity:IdentityPort;chat:ChatRequests;notifications:NotificationRequests;deliveries:DeliveryQueries;system:SystemQueries;payments?:PaymentRequests;administration?:AdministrationService;workspace?:WorkspaceService;clinicalDocuments?:ClinicalDocumentService;patientWorkspace?:PatientWorkspaceService};
