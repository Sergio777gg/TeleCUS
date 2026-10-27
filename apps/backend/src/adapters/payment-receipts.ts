import { ConflictException,ForbiddenException,NotFoundException,ServiceUnavailableException } from '@nestjs/common';
import { createHash,randomUUID } from 'node:crypto';
import type { Profile } from '../types.js';
import type { UnitOfWork } from '../ports/storage.js';
import type { PaymentBlobStore,PaymentDownload,PaymentPage,PaymentReceipt,PaymentReceiptStore,ValidatedPaymentFile } from '../ports/payments.js';
import { publishDemoNotification } from './notification-inbox.js';
import type {DemoReservationHolds} from './reservation-holds.js';
type AgendaFunctions={call(name:string,args?:unknown[]):Promise<any>};
function metadata(r:any):PaymentReceipt{return {id:String(r.id),file_name:r.file_name,content_type:r.content_type,size:Number(r.size),created_at:r.created_at};}
function same(r:any,appointment:string,file:ValidatedPaymentFile){return r.appointment_id===appointment&&r.sha256===file.sha256&&r.file_name===file.file_name&&r.content_type===file.content_type&&Number(r.size)===file.size;}
export class DatabasePaymentReceiptStore implements PaymentReceiptStore {
  private enabled=false;
  constructor(private db:UnitOfWork,private holds?:DemoReservationHolds){}
  available(){return this.enabled;}
  async initialize(){
    await this.db.query(`CREATE TABLE IF NOT EXISTS telecus_demo_payment_receipts (id TEXT PRIMARY KEY,appointment_id TEXT NOT NULL,patient_id TEXT NOT NULL,request_id TEXT NOT NULL,file_name TEXT NOT NULL,content_type TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,content_base64 TEXT NOT NULL,created_at TEXT NOT NULL,withdrawn_at TEXT,withdrawal_request TEXT,UNIQUE(patient_id,request_id))`);
    const columns=await this.db.query(this.db.driver==='sqlite'?'PRAGMA table_info(telecus_demo_payment_receipts)':"SELECT column_name AS name FROM information_schema.columns WHERE table_name='telecus_demo_payment_receipts'");
    if(!columns.some(c=>c.name==='withdrawn_at')){
      if(this.db.driver==='sqlite')await this.db.transaction(async cx=>{
        await cx.query("CREATE TABLE telecus_demo_receipts_upgrade (id TEXT PRIMARY KEY,appointment_id TEXT NOT NULL,patient_id TEXT NOT NULL,request_id TEXT NOT NULL,file_name TEXT NOT NULL,content_type TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,content_base64 TEXT NOT NULL,created_at TEXT NOT NULL,withdrawn_at TEXT,withdrawal_request TEXT,UNIQUE(patient_id,request_id))");
        await cx.query("INSERT INTO telecus_demo_receipts_upgrade SELECT *,NULL,NULL FROM telecus_demo_payment_receipts");
        const [before]=await cx.query('SELECT COUNT(*) AS n FROM telecus_demo_payment_receipts'),[after]=await cx.query('SELECT COUNT(*) AS n FROM telecus_demo_receipts_upgrade');
        if(Number(before.n)!==Number(after.n))throw new Error('No se pudo conservar la evidencia de prueba.');
        await cx.query('DROP TABLE telecus_demo_payment_receipts');
        await cx.query('ALTER TABLE telecus_demo_receipts_upgrade RENAME TO telecus_demo_payment_receipts');
      });
      else {await this.db.query('ALTER TABLE telecus_demo_payment_receipts ADD COLUMN withdrawn_at TEXT');await this.db.query('ALTER TABLE telecus_demo_payment_receipts ADD COLUMN withdrawal_request TEXT');await this.db.query('ALTER TABLE telecus_demo_payment_receipts DROP CONSTRAINT IF EXISTS telecus_demo_payment_receipts_appointment_id_key');}
    }
    await this.db.query('CREATE UNIQUE INDEX IF NOT EXISTS telecus_demo_receipt_active ON telecus_demo_payment_receipts(appointment_id) WHERE withdrawn_at IS NULL');
    await this.db.query('CREATE UNIQUE INDEX IF NOT EXISTS telecus_demo_receipt_withdrawal ON telecus_demo_payment_receipts(patient_id,withdrawal_request) WHERE withdrawal_request IS NOT NULL');
    this.enabled=true;
  }
  private async actor(user:Profile,cx:Pick<UnitOfWork,'query'>){const [actor]=await cx.query('SELECT id,role,active FROM telecus_demo_profiles WHERE id=$1',[user.id]);if(!actor||!actor.active||actor.role!==user.role||!['PATIENT','ADMIN'].includes(actor.role))throw new ForbiddenException('Tu perfil no permite consultar comprobantes de pago.');return actor;}
  async list(user:Profile):Promise<PaymentPage>{
    await this.actor(user,this.db);
    const appointments=await this.db.query(`SELECT a.*,p.full_name AS doctor_name,r.id AS receipt_id,r.file_name,r.content_type,r.size,r.created_at AS receipt_created_at FROM telecus_demo_appointments a JOIN telecus_demo_profiles p ON p.id=a.doctor_id LEFT JOIN telecus_demo_payment_receipts r ON r.appointment_id=a.id AND r.withdrawn_at IS NULL WHERE a.status='PRE_RESERVED' AND a.payment_status='PENDING' AND a.start_time>$1${user.role==='PATIENT'?' AND a.patient_id=$2':' AND r.id IS NOT NULL'} ORDER BY a.start_time LIMIT 100`,user.role==='PATIENT'?[new Date().toISOString(),user.id]:[new Date().toISOString()]);
    return {items:await Promise.all(appointments.map(async a=>{const receipt=a.receipt_id?metadata({...a,id:a.receipt_id,created_at:a.receipt_created_at}):null;return {...await this.holds?.info(a.id),appointment_id:a.id,code:a.code,doctor_name:a.doctor_name,start_time:a.start_time,status:a.status,payment_status:a.payment_status,processing:false,can_pay:user.role==='PATIENT'&&!receipt,can_upload:user.role==='PATIENT'&&!receipt,can_withdraw:user.role==='PATIENT'&&Boolean(receipt),receipt};})),receiptsAvailable:this.available()};
  }
  async upload(user:Profile,appointmentId:string,requestId:string,file:ValidatedPaymentFile):Promise<PaymentReceipt>{
    return this.db.transaction(async cx=>{
      const actor=await this.actor(user,cx);if(actor.role!=='PATIENT')throw new ForbiddenException('Solo el paciente puede adjuntar el comprobante.');
      const [retry]=await cx.query('SELECT * FROM telecus_demo_payment_receipts WHERE patient_id=$1 AND request_id=$2',[user.id,requestId]);
      if(retry){if(retry.withdrawn_at||!same(retry,appointmentId,file))throw new ConflictException('Ese envío ya se utilizó para otro comprobante.');return metadata(retry);}
      const [a]=await cx.query('SELECT * FROM telecus_demo_appointments WHERE id=$1',[appointmentId]);
      if(!a||a.patient_id!==user.id)throw new ForbiddenException('No se encontró esa pre-reserva dentro de tu acceso.');
      if(a.status!=='PRE_RESERVED'||a.payment_status!=='PENDING'||new Date(a.start_time).getTime()<=Date.now())throw new ConflictException('La cita ya no admite comprobantes. Consulta su estado actual.');
      await this.holds?.eligible(appointmentId,cx);
      if((await cx.query('SELECT id FROM telecus_demo_payment_receipts WHERE appointment_id=$1 AND withdrawn_at IS NULL',[appointmentId])).length)throw new ConflictException('Ya recibimos un comprobante para esta pre-reserva. Está pendiente de revisión administrativa.');
      const receipt={id:randomUUID(),file_name:file.file_name,content_type:file.content_type,size:file.size,created_at:new Date().toISOString()};
      await cx.query('INSERT INTO telecus_demo_payment_receipts(id,appointment_id,patient_id,request_id,file_name,content_type,size,sha256,content_base64,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[receipt.id,appointmentId,user.id,requestId,file.file_name,file.content_type,file.size,file.sha256,file.data.toString('base64'),receipt.created_at]);
      await publishDemoNotification(cx,'payment-receipt:'+receipt.id,'payment_receipt_received',a);
      return receipt;
    });
  }
  async download(user:Profile,id:string):Promise<PaymentDownload>{
    await this.actor(user,this.db);
    const [r]=await this.db.query(`SELECT * FROM telecus_demo_payment_receipts WHERE id=$1${user.role==='PATIENT'?' AND patient_id=$2':''}`,user.role==='PATIENT'?[id,user.id]:[id]);
    if(!r)throw new NotFoundException('No se encontró ese comprobante dentro de tu acceso.');
    return {...metadata(r),data:Buffer.from(r.content_base64,'base64')};
  }
  async withdraw(user:Profile,id:string,requestId:string):Promise<{id:string;withdrawn:true}>{
    return this.db.transaction(async cx=>{
      const actor=await this.actor(user,cx);if(actor.role!=='PATIENT')throw new ForbiddenException('Solo el paciente puede retirar su comprobante.');
      const [retry]=await cx.query('SELECT id FROM telecus_demo_payment_receipts WHERE patient_id=$1 AND withdrawal_request=$2',[user.id,requestId]);
      if(retry){if(retry.id!==id)throw new ConflictException('La referencia de retiro ya fue utilizada.');return {id,withdrawn:true};}
      const [r]=await cx.query('SELECT * FROM telecus_demo_payment_receipts WHERE id=$1 AND patient_id=$2',[id,user.id]);
      if(!r)throw new ForbiddenException('El comprobante no está dentro de tu acceso.');
      const [a]=await cx.query('SELECT * FROM telecus_demo_appointments WHERE id=$1',[r.appointment_id]);
      if(r.withdrawn_at||a?.status!=='PRE_RESERVED'||a.payment_status!=='PENDING'||new Date(a.start_time).getTime()<=Date.now())throw new ConflictException('El comprobante ya no se puede retirar. Consulta al Administrador.');
      await cx.query('UPDATE telecus_demo_payment_receipts SET withdrawn_at=$1,withdrawal_request=$2 WHERE id=$3',[new Date().toISOString(),requestId,id]);
      await cx.query('INSERT INTO telecus_audit(id,owner_id,operation,target_id,created_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),user.id,'receipt_withdrawn',r.appointment_id+':'+id,new Date().toISOString()]);
      await this.holds?.corrected(r.appointment_id,cx);
      await publishDemoNotification(cx,'receipt-withdraw:'+id,'payment_receipt_withdrawn',a);
      return {id,withdrawn:true};
    });
  }
}
export class PostgresPaymentReceiptStore implements PaymentReceiptStore {
  private enabled=false;
  private version=0;
  constructor(private agenda?:AgendaFunctions,private fallbackList?:(user:Profile)=>Promise<PaymentPage>,private blobs?:PaymentBlobStore){}
  available(){return this.enabled;}
  async initialize(){this.version=this.agenda?Number(await this.agenda.call('payment_receipts_version')):0;this.enabled=[1,2].includes(this.version);}
  async list(user:Profile):Promise<PaymentPage>{if(!this.enabled){const page=this.fallbackList?await this.fallbackList(user):{items:[]};return {...page,receiptsAvailable:false};}return this.agenda!.call('list_payment_receipts',[user.id]);}
  async withdraw(user:Profile,id:string,requestId:string):Promise<{id:string;withdrawn:true}>{this.ready();if(this.version<2)throw new ServiceUnavailableException('La corrección de comprobantes aún no está habilitada.');return this.agenda!.call('withdraw_payment_receipt',[user.id,id,requestId]);}
  private ready(){if(!this.enabled)throw new ServiceUnavailableException('Todavía no se habilitaron los comprobantes en este entorno.');}
  async upload(user:Profile,appointmentId:string,requestId:string,file:ValidatedPaymentFile):Promise<PaymentReceipt>{
    this.ready();if(!this.blobs)throw new ServiceUnavailableException('El almacenamiento privado de comprobantes no está disponible.');
    const page=await this.list(user),item=page.items.find(i=>i.appointment_id===appointmentId);
    if(!item)throw new ForbiddenException('No se encontró una pre-reserva pendiente dentro de tu acceso.');
    if(item.processing)throw new ConflictException('La confirmación de esta cita ya está en proceso. No envíes otro comprobante.');
    const storage_key=createHash('sha256').update(user.id.toLowerCase()+'\0'+appointmentId.toLowerCase()+'\0'+file.sha256).digest('hex');
    const payload=JSON.stringify({file_name:file.file_name,content_type:file.content_type,size:file.size,sha256:file.sha256,storage_key});
    // With an existing receipt, SQL first proves this is an exact retry before any write.
    const existing=item.receipt?await this.agenda!.call('upload_payment_receipt',[user.id,appointmentId,requestId,payload]):undefined;
    try{await this.blobs.put(storage_key,file.data,file.sha256);}catch{throw new ServiceUnavailableException('No pudimos guardar el archivo privado. Tu pago no ha cambiado; vuelve a intentarlo con el mismo comprobante.');}
    // A DB failure can leave a private orphan. Do not delete: the commit may have succeeded.
    return existing||await this.agenda!.call('upload_payment_receipt',[user.id,appointmentId,requestId,payload]);
  }
  async download(user:Profile,id:string):Promise<PaymentDownload>{
    this.ready();const r=await this.agenda!.call('download_payment_receipt',[user.id,id]);
    if(!this.blobs)throw new ServiceUnavailableException('El archivo privado no está disponible.');
    try{const data=await this.blobs.get(r.storage_key);if(data.length!==Number(r.size)||createHash('sha256').update(data).digest('hex')!==r.sha256)throw new Error('Integrity check failed');return {...metadata(r),data};}
    catch{throw new ServiceUnavailableException('No pudimos recuperar el comprobante. El Administrador debe revisar su almacenamiento; el estado del pago no cambió.');}
  }
}
