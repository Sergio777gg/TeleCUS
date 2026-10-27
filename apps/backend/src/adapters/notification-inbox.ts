import type { Connection,UnitOfWork } from '../ports/storage.js';
import {ConflictException,ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import type { NotificationInbox,NotificationPage } from '../ports/application.js';
import type { Profile } from '../types.js';

type NotificationFunctions={call(name:string,args:unknown[]):Promise<any>};
export class PostgresNotificationInbox implements NotificationInbox {
  constructor(private agenda?:NotificationFunctions){}
  async list(user:Profile,before:string|undefined,limit:number):Promise<NotificationPage>{
    return this.agenda?this.agenda.call('list_notifications',[user.id,before||null,limit]):{items:[],unread:0,next_cursor:null};
  }
  async read(user:Profile,ids:string[]):Promise<number>{
    return this.agenda?this.agenda.call('read_notifications',[user.id,JSON.stringify(ids)]):0;
  }
  async remove(user:Profile,ids:string[],read:boolean,batch:string){if(!this.agenda)throw new ServiceUnavailableException();return this.agenda.call('dismiss_notifications',[user.id,JSON.stringify(ids),read,batch]);}
  async restore(user:Profile,batch:string){if(!this.agenda)throw new ServiceUnavailableException();return this.agenda.call('restore_notifications',[user.id,batch]);}
}

/** Isolated demo inbox, with the same access and pagination contract as PostgreSQL. */
export class DatabaseNotificationInbox implements NotificationInbox {
  constructor(private db:UnitOfWork){}
  async list(user:Profile,before:string|undefined,limit:number):Promise<NotificationPage>{
    const params:unknown[]=[user.id,user.role];if(before)params.push(before);params.push(limit+1);
    const rows=await this.db.query(`SELECT CAST(id AS TEXT) AS id,event_type,payload_json,created_at,read_at FROM telecus_notifications WHERE recipient_id=$1 AND recipient_role=$2 AND NOT EXISTS(SELECT 1 FROM telecus_notification_dismissals d WHERE d.notification_id=telecus_notifications.id)${before?' AND id<$3':''} ORDER BY telecus_notifications.id DESC LIMIT $${params.length}`,params);
    const more=rows.length>limit,items=rows.slice(0,limit).map(r=>({...r,payload:JSON.parse(r.payload_json)}));
    const [count]=await this.db.query('SELECT COUNT(CASE WHEN read_at IS NULL THEN 1 END) AS total,COUNT(read_at) AS read_count FROM telecus_notifications WHERE recipient_id=$1 AND recipient_role=$2 AND NOT EXISTS(SELECT 1 FROM telecus_notification_dismissals d WHERE d.notification_id=telecus_notifications.id)',[user.id,user.role]);
    return {items,unread:Number(count.total),read_count:Number(count.read_count),next_cursor:more?items.at(-1)?.id:null};
  }
  async read(user:Profile,ids:string[]):Promise<number>{
    const params=[new Date().toISOString(),user.id,user.role,...ids];
    const rows=await this.db.query(`UPDATE telecus_notifications SET read_at=COALESCE(read_at,$1) WHERE recipient_id=$2 AND recipient_role=$3 AND id IN (${ids.map((_,i)=>'$'+(i+4)).join(',')}) RETURNING id`,params);
    return rows.length;
  }
  private async actor(user:Profile,cx:Connection){const [p]=await cx.query('SELECT role,active FROM telecus_demo_profiles WHERE id=$1',[user.id]);if(!p?.active||p.role!==user.role)throw new ForbiddenException();}
  async remove(user:Profile,ids:string[],read:boolean,batch:string){return this.db.transaction(async cx=>{
    await this.actor(user,cx);const payload=JSON.stringify({ids:[...ids].sort(),read}),[old]=await cx.query('SELECT * FROM telecus_notification_cleanup WHERE id=$1',[batch]);
    if(old){if(old.actor_id!==user.id||old.role!==user.role||old.payload!==payload)throw new ConflictException('La referencia ya corresponde a otra limpieza.');return Number(old.total);}
    const params:any[]=[user.id,user.role,batch,...ids],rows=await cx.query(`INSERT INTO telecus_notification_dismissals(notification_id,actor_id,role,batch) SELECT id,$1,$2,$3 FROM telecus_notifications n WHERE recipient_id=$1 AND recipient_role=$2 AND ${read?'read_at IS NOT NULL':ids.length?'id IN ('+ids.map((_,i)=>'$'+(i+4)).join(',')+')':'1=0'} AND NOT EXISTS(SELECT 1 FROM telecus_notification_dismissals d WHERE d.notification_id=n.id) ON CONFLICT(notification_id) DO NOTHING RETURNING notification_id`,params);
    await cx.query('INSERT INTO telecus_notification_cleanup VALUES($1,$2,$3,$4,$5)',[batch,user.id,user.role,payload,rows.length]);return rows.length;
  });}
  async restore(user:Profile,batch:string){return this.db.transaction(async cx=>{await this.actor(user,cx);const [old]=await cx.query('SELECT * FROM telecus_notification_cleanup WHERE id=$1',[batch]);if(!old||old.actor_id!==user.id||old.role!==user.role)throw new ForbiddenException();const rows=await cx.query('DELETE FROM telecus_notification_dismissals WHERE actor_id=$1 AND role=$2 AND batch=$3 RETURNING notification_id',[user.id,user.role,batch]);return rows.length;});}
}

/** Demo uses the same event vocabulary, persisted inside its agenda transaction. */
export async function publishDemoNotification(cx:Connection,key:string,type:string,a:any,request?:any,onlyDoctor?:string,excludeAdmin=false){
  const doctors=['appointment_confirmed','appointment_rescheduled','appointment_cancelled','appointment_completed','doctor_assigned'].includes(type)&&['VERIFIED','NOT_REQUIRED'].includes(a.payment_status);
  const profiles=await cx.query('SELECT id,role FROM telecus_demo_profiles WHERE active=1');
  const recipients=profiles.filter(p=>onlyDoctor?p.id===onlyDoctor&&p.role==='DOCTOR':p.role==='ADMIN'&&!excludeAdmin||(p.role==='PATIENT'&&p.id===a.patient_id)||(doctors&&p.role==='DOCTOR'&&p.id===a.doctor_id));
  const [decision]=type==='change_rejected'&&request?await cx.query('SELECT message FROM telecus_public_rejections WHERE request_id=$1',[request.id]):[];
  const payload=JSON.stringify({code:a.code,start_time:a.start_time,request_type:request?.request_type,public_reason:decision?.message,payment_required:a.payment_status!=='NOT_REQUIRED',reason:a.hold_expired?'reservation_expired':undefined});
  for(const p of recipients)await cx.query('INSERT INTO telecus_notifications(event_key,event_type,payload_json,recipient_id,recipient_role,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key,recipient_id,recipient_role) DO NOTHING',[key,type,payload,p.id,p.role,new Date().toISOString()]);
}
