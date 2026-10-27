import {ConflictException} from '@nestjs/common';
import type {Connection,UnitOfWork} from '../ports/storage.js';
import type {ServiceSchedule} from '../application/service-schedule.js';
import {publishDemoNotification} from './notification-inbox.js';
/** Isolated demo persistence; production uses the database functions from migration 006. */
export class DemoReservationHolds {
  private ready=false;
  constructor(private db:UnitOfWork){}
  async initialize(){await this.db.query('CREATE TABLE IF NOT EXISTS telecus_demo_holds(appointment_id TEXT PRIMARY KEY,expires_at TEXT NOT NULL,expired_at TEXT,schedule_version TEXT NOT NULL)');this.ready=true;}
  async info(id:string,cx:Connection=this.db){if(!this.ready)return {};const [h]=await cx.query('SELECT expires_at,expired_at FROM telecus_demo_holds WHERE appointment_id=$1',[id]);return h?{expires_at:h.expires_at,hold_expired:Boolean(h.expired_at)}:{};}
  async eligible(id:string,cx:Connection){const h=await this.info(id,cx);if(h.expires_at&&new Date(h.expires_at).getTime()<=Date.now()){const [receipt]=await cx.query('SELECT id FROM telecus_demo_payment_receipts WHERE appointment_id=$1 AND withdrawn_at IS NULL',[id]);if(!receipt)throw new ConflictException('El plazo de la pre-reserva venció. Consulta la disponibilidad antes de pagar o adjuntar un comprobante.');}}
  async create(a:any,policy:ServiceSchedule,cx:Connection){if(!this.ready)return;await cx.query('INSERT INTO telecus_demo_holds(appointment_id,expires_at,schedule_version) VALUES($1,$2,$3) ON CONFLICT(appointment_id) DO NOTHING',[a.id,new Date(Math.min(new Date(a.start_time).getTime(),Date.now()+policy.hold_hours*3600000)).toISOString(),policy.version]);}
  async cap(id:string,cx:Connection){if(!this.ready)return;const [a]=await cx.query('SELECT start_time FROM telecus_demo_appointments WHERE id=$1',[id]),h=await this.info(id,cx);if(a&&h.expires_at&&h.expires_at>a.start_time)await cx.query('UPDATE telecus_demo_holds SET expires_at=$1 WHERE appointment_id=$2',[a.start_time,id]);}
  async corrected(id:string,cx:Connection){if(!this.ready)return;const [a]=await cx.query('SELECT start_time FROM telecus_demo_appointments WHERE id=$1',[id]),h=await this.info(id,cx);if(a&&h.expires_at)await cx.query('UPDATE telecus_demo_holds SET expires_at=$1 WHERE appointment_id=$2',[new Date(Math.min(new Date(a.start_time).getTime(),Math.max(new Date(h.expires_at).getTime(),Date.now()+900000))).toISOString(),id]);}
  async expire(connection?:Connection):Promise<number>{
    if(!this.ready)return 0;
    const run=async(cx:Connection)=>{const rows=await cx.query("SELECT a.* FROM telecus_demo_appointments a JOIN telecus_demo_holds h ON h.appointment_id=a.id WHERE h.expired_at IS NULL AND h.expires_at<=$1 AND a.status='PRE_RESERVED' AND a.payment_status='PENDING' AND NOT EXISTS(SELECT 1 FROM telecus_demo_payment_receipts r WHERE r.appointment_id=a.id AND r.withdrawn_at IS NULL) LIMIT 100",[new Date().toISOString()]);
      for(const a of rows){await cx.query('UPDATE telecus_demo_holds SET expired_at=$1 WHERE appointment_id=$2',[new Date().toISOString(),a.id]);await cx.query("UPDATE telecus_demo_appointments SET status='CANCELLED' WHERE id=$1",[a.id]);await publishDemoNotification(cx,'hold-expired:'+a.id,'appointment_cancelled',{...a,hold_expired:true});}
      return rows.length;
    };return connection?run(connection):this.db.transaction(run);
  }
}

/** Bounded, restart-safe sweep. The database serializes a receipt with its appointment. */
export class ReservationHoldWorker {
  private timer?:ReturnType<typeof setInterval>;private active?:Promise<unknown>;
  constructor(private expire:()=>Promise<unknown>){}
  start(){const tick=()=>{if(!this.active)this.active=this.expire().catch(()=>{console.error('No se pudo comprobar el vencimiento de pre-reservas; se reintentará.');}).finally(()=>{this.active=undefined;});};tick();this.timer=setInterval(tick,20000);this.timer.unref();}
  async stop(){clearInterval(this.timer);await this.active;}
}
