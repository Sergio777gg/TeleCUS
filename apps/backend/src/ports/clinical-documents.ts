import type {Profile} from '../types.js';
import type {ValidatedPaymentFile,PaymentBlobStore} from './payments.js';
export type ClinicalAction='list'|'prepare'|'commit'|'download'|'withdraw'|'review';
export interface ClinicalMetadata {
 initialize():Promise<void>;available():boolean;
 dispatch(actor:Profile,action:ClinicalAction,input:Record<string,unknown>):Promise<any>;
}
export type ClinicalFile=ValidatedPaymentFile;
export type ClinicalBlobs=PaymentBlobStore;
