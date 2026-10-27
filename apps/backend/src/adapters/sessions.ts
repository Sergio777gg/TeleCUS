import type { Profile } from '../types.js';
import type { Connection, UnitOfWork } from '../ports/storage.js';
import type { SessionRepository } from '../ports/application.js';
import { sessionKey } from '../application/session-key.js';

export class SqlSessionRepository implements SessionRepository {
  constructor(private db:UnitOfWork){}
  async load(user:Profile,id:string,connection:Connection=this.db){
    const [row]=await connection.query('SELECT state_json FROM telecus_sessions WHERE id=$1 AND owner_id=$2 AND role=$3',[sessionKey(user,id),user.id,user.role]);
    return row?JSON.parse(row.state_json):{};
  }
  save(user:Profile,id:string,state:any,connection:Connection){
    return connection.query('INSERT INTO telecus_sessions(id,owner_id,role,state_json,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at',[sessionKey(user,id),user.id,user.role,JSON.stringify(state),new Date().toISOString()]);
  }
  async lock(user:Profile,id:string,connection:Connection){
    if(this.db.driver==='postgresql')await connection.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',[`telecus-session:${sessionKey(user,id)}`]);
  }
}
