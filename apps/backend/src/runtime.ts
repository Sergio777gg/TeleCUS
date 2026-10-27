import {REJECTION_REASONS} from './application/rejection-reasons.js';
import { config, PAYMENT_PORTAL_URL } from './config.js';
import { Database } from './database.js';
import { Repository } from './repository.js';
import { AuthService } from './auth.js';
import { DomainService } from './domain.js';
import { JobsService } from './jobs.js';
import { PostgresAgenda } from './integrations/agenda.js';
import { configuredGoogle } from './integrations/google-config.js';
import { DeliveryWorker } from './integrations/deliveries.js';
import { KnowledgeIndex, LocalKnowledge } from './knowledge.js';
import { NotificationsService } from './notifications.js';
import { SqlSessionRepository } from './adapters/sessions.js';
import { NodeRedInterpreter } from './adapters/interpretation.js';
import { DatabaseNotificationInbox,PostgresNotificationInbox } from './adapters/notification-inbox.js';
import type { HttpBindings } from './http/contracts.js';
import { PaymentService } from './application/payments.js';
import { DatabasePaymentReceiptStore,PostgresPaymentReceiptStore } from './adapters/payment-receipts.js';
import { LocalPaymentBlobStore } from './adapters/payment-files.js';
import { AdministrationService,DEFAULT_PORTAL } from './application/administration.js';
import { DemoAdministrationStore,PostgresAdministrationStore } from './adapters/administration.js';
import { FileKnowledgeCatalog,ManagedKnowledgeSearch } from './adapters/managed-knowledge.js';
import type {PortalSettings,AdministrationStore} from './ports/administration.js';
import {DEFAULT_SCHEDULE_BOOK,scheduleFor,dayNames} from './application/service-schedule.js';
import {DemoReservationHolds,ReservationHoldWorker} from './adapters/reservation-holds.js';
import {WorkspaceService} from './application/workspace.js';
import {DemoWorkspaceStore,PostgresWorkspaceStore,DatabaseUsageMetrics} from './adapters/workspace.js';
import {meteredTransport} from './adapters/usage-transport.js';
import {SignedStaffReview} from './adapters/review-signer.js';
import {VISIT_TYPES,LEGACY_VISIT_POLICY} from './application/visit-policy.js';
import {PatientWorkspaceService} from './application/patient-workspace.js';
import {ClinicalDocumentService} from './application/clinical-documents.js';
import {DemoClinicalMetadata,PostgresClinicalMetadata} from './adapters/clinical-documents.js';
export class Runtime {
  cfg=config();
  db=new Database(this.cfg.databaseUrl,this.cfg.databaseFile);
  agenda:PostgresAgenda|undefined=this.cfg.agendaUrl && this.cfg.mode!=='demo' ? new PostgresAgenda(this.cfg.agendaUrl,this.cfg.agendaCaFile,this.cfg.agendaAddress,async():Promise<string>=>((await this.adminStore.settings()).payment_url)) : undefined;
  demoHolds=new DemoReservationHolds(this.db);
  holdWorker=new ReservationHoldWorker(()=>this.cfg.mode==='demo'?this.demoHolds.expire():this.agenda!.call('expire_holds'));
  repository=new Repository(this.db,this.cfg,this.agenda,cx=>this.cfg.mode==='demo'?this.demoSchedules(cx):this.adminStore.schedules(),this.demoHolds,cx=>this.visitPolicy(cx));
  notifications=new NotificationsService(this.cfg.mode==='demo'?new DatabaseNotificationInbox(this.db):new PostgresNotificationInbox(this.agenda));
  catalog=new FileKnowledgeCatalog(process.env.KNOWLEDGE_DIRECTORY||'knowledge/telecus');
  adminStore:AdministrationStore=this.cfg.mode==='demo'?new DemoAdministrationStore(this.db,this.repository,this.demoHolds):new PostgresAdministrationStore(this.agenda);
  workspaceStore=this.cfg.mode==='demo'?new DemoWorkspaceStore(this.db,this.repository):new PostgresWorkspaceStore(this.agenda!);
  usageMetrics=new DatabaseUsageMetrics(this.db);
  workspace=new WorkspaceService(this.repository,this.workspaceStore,new SignedStaffReview(this.cfg.demoSecret),this.usageMetrics,this.adminStore);
  administration=new AdministrationService(this.adminStore,this.catalog,this.cfg.mode!=='supabase-readonly');
  publicSettings:PortalSettings=DEFAULT_PORTAL;
  publicSchedules=DEFAULT_SCHEDULE_BOOK;
  private async demoSchedules(cx?:import('./ports/storage.js').Connection){if(!cx)return this.adminStore.schedules();const [row]=await cx.query("SELECT data_json,version FROM telecus_demo_admin_state WHERE resource='schedule' AND object_key='service'");return row?{...JSON.parse(row.data_json),version:String(row.version)}:DEFAULT_SCHEDULE_BOOK;}
  private async visitPolicy(cx?:import('./ports/storage.js').Connection){
    if(this.cfg.mode==='demo'&&cx){const [row]=await cx.query("SELECT data_json,version FROM telecus_demo_admin_state WHERE resource='settings' AND object_key='portal'");return {available:true,version:String(row?.version||'1'),payments_enabled:row?JSON.parse(row.data_json).payments_enabled!==false:true};}
    const p=await this.adminStore.settings();return p.visit_workflow_available?{available:true,version:p.version,payments_enabled:p.payments_enabled!==false}:LEGACY_VISIT_POLICY;
  }
  auth=new AuthService(this.db,this.cfg,this.cfg.mode==='supabase-live'?id=>this.adminStore.claimRegistration(id):undefined);
  knowledge=new LocalKnowledge(new ManagedKnowledgeSearch(process.env.KNOWLEDGE_DIRECTORY||'knowledge/telecus',this.adminStore),this.cfg.inferenceUrl.replace(/\/interpret$/,'/answer'),this.cfg.internalToken,this.cfg.modelTimeoutMs,meteredTransport(fetch,this.usageMetrics,'knowledge'));
  sessions=new SqlSessionRepository(this.db);
  interpreter=new NodeRedInterpreter(this.cfg.inferenceUrl,this.cfg.internalToken,this.cfg.modelTimeoutMs,meteredTransport(fetch,this.usageMetrics,'interpretation'));
  domain=new DomainService(this.repository,this.sessions,this.db,this.knowledge,{directPayments:true});
  jobs=new JobsService(this.db,this.cfg,this.domain,this.auth,this.interpreter);
  paymentStore=this.cfg.mode==='demo'?new DatabasePaymentReceiptStore(this.db,this.demoHolds):new PostgresPaymentReceiptStore(this.agenda,async user=>{
    const [appointments,doctors,deliveries]=await Promise.all([this.repository.pendingPaymentAppointments(user),this.repository.doctors(user),this.repository.pendingDeliveries(user)]);
    return {receiptsAvailable:false,items:(user.role==='PATIENT'?appointments:[]).map(a=>{const processing=deliveries.some(d=>d.code===a.code&&d.operation==='confirm');return {appointment_id:a.id,code:a.code,doctor_name:doctors.find(d=>d.id===a.doctor_id)?.full_name||'Médico asignado',start_time:a.start_time,status:a.status,payment_status:a.payment_status,processing,can_pay:this.cfg.mode==='supabase-live'&&!processing,can_upload:false,receipt:null};})};
  },new LocalPaymentBlobStore(this.cfg.paymentFilesDirectory,this.cfg.paymentFilesKey));
  payments=new PaymentService(this.paymentStore,this.cfg.mode!=='supabase-readonly');
  clinicalMetadata=this.cfg.mode==='demo'?new DemoClinicalMetadata(this.db):new PostgresClinicalMetadata(this.agenda);
  patientWorkspace=new PatientWorkspaceService(this.repository);
  patientWorkspaceAvailable=false;
  clinicalDocuments=new ClinicalDocumentService(this.clinicalMetadata,new LocalPaymentBlobStore(this.cfg.clinicalFilesDirectory,this.cfg.paymentFilesKey,'telecus/clinical-documents/v1'),this.cfg.mode!=='supabase-readonly');
  deliveries?:DeliveryWorker;
  get httpBindings():HttpBindings{
    return {identity:this.auth,chat:this.jobs,notifications:this.notifications,payments:this.payments,administration:this.administration,workspace:this.workspace,clinicalDocuments:this.clinicalDocuments,patientWorkspace:this.patientWorkspace,
      deliveries:{list:async user=>this.agenda?this.agenda.call('delivery_status',[user.id]):[]},
      system:{configuration:async()=>{[this.publicSettings,this.publicSchedules]=await Promise.all([this.adminStore.settings(),this.adminStore.schedules()]);return this.configuration();},health:()=>this.health()}};
  }
  private configuration(){
    const c=this.cfg;
    return {rejectionReasons:REJECTION_REASONS,mode:c.mode,integrationAvailable:Boolean(this.agenda),patientWorkspaceAvailable:this.patientWorkspaceAvailable,clinicalDocumentsAvailable:this.clinicalMetadata?.available()||false,visits:{available:this.publicSettings?.visit_workflow_available===true,types:VISIT_TYPES,payments_enabled:this.publicSettings?.payments_enabled!==false},paymentPortal:{provider:'SIREC',enabled:this.publicSettings?.payments_enabled!==false,url:c.mode==='supabase-live'?(this.publicSettings?.payment_url||PAYMENT_PORTAL_URL):null},administrationAvailable:this.adminStore?.available()||false,support:{phone:this.publicSettings?.support_phone||DEFAULT_PORTAL.support_phone},supabaseUrl:c.mode!=='demo'?c.supabaseUrl:'',supabasePublishableKey:c.mode!=='demo'?c.supabaseKey:'',service:{...scheduleFor(this.publicSchedules||DEFAULT_SCHEDULE_BOOK),day:dayNames(scheduleFor(this.publicSchedules||DEFAULT_SCHEDULE_BOOK)),policies:(this.publicSchedules||DEFAULT_SCHEDULE_BOOK).items}};
  }
  private async health(){
    await this.db.query('SELECT 1 AS ok');let inference=false;
    try{const r=await fetch(this.cfg.inferenceUrl.replace(/\/interpret$/,'/health'),{headers:{'X-TeleCUS-Internal':this.cfg.internalToken},signal:AbortSignal.timeout(3000)});inference=r.ok;}catch{}
    return {status:'ok',mode:this.cfg.mode,database:this.db.driver,inference,worker:this.cfg.worker,deliveryWorker:Boolean(this.deliveries)};
  }
  async initialize() {
    if(this.cfg.mode==='supabase-live' && !this.agenda)throw new Error('Falta la conexión restringida de agenda.');
    if(this.agenda){await this.agenda.ready();this.patientWorkspaceAvailable=await this.agenda.call('patient_workspace_version')===1;}else this.patientWorkspaceAvailable=this.cfg.mode==='demo';
    await this.db.initialize();if(this.cfg.mode==='demo')await this.repository.seed();
    await this.paymentStore.initialize();
    await this.clinicalMetadata.initialize();
    if(this.cfg.mode==='demo')await this.demoHolds.initialize();
    if(this.agenda&&await this.agenda.call('schedule_version')!==1)throw new Error('Falta la migración 006 de horarios y pre-reservas.');
    await this.adminStore.initialize(this.catalog.documents(),this.cfg.mode!=='supabase-readonly');
    this.publicSettings=await this.adminStore.settings();
    this.publicSchedules=await this.adminStore.schedules();
    await this.workspaceStore.initialize();await this.usageMetrics.initialize();
    if(this.cfg.mode==='supabase-live' && this.cfg.deliveries){this.deliveries=new DeliveryWorker(this.agenda!,configuredGoogle(this.cfg.demoSecret));this.deliveries.start();}
    if(this.cfg.mode!=='supabase-readonly')this.holdWorker.start();
    this.jobs.start();
  }
  async close() {await this.holdWorker.stop();await this.jobs.stop();await this.deliveries?.stop();await this.agenda?.close();await this.db.close();}
}
