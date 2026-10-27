import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Pool, PoolClient } from 'pg';
import type { Connection,UnitOfWork } from './ports/storage.js';
export type { Connection } from './ports/storage.js';
export class Database implements UnitOfWork {
  private sqlite?: DatabaseSync;
  private pool?: Pool;
  private tail = Promise.resolve();
  constructor(url: string, file: string) {
    if (url) this.pool = new Pool({ connectionString: url, max: 6 });
    else { mkdirSync(dirname(file), { recursive: true }); this.sqlite = new DatabaseSync(file); this.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;'); }
  }
  get driver() { return this.pool ? 'postgresql' : 'sqlite'; }
  async query(sql: string, args: unknown[] = []): Promise<any[]> {
    if (this.pool) return (await this.pool.query(sql, args)).rows;
    const previous = this.tail; let release!: () => void;
    this.tail = new Promise<void>(r => { release = r; }); await previous;
    try { return this.sqliteQuery(sql, args); } finally { release(); }
  }
  private sqliteQuery(sql: string, args: unknown[] = []) {
    const ordered:unknown[]=[];
    const statement=sql.replace(/\$(\d+)/g,(_match,index)=>{ordered.push(args[Number(index)-1]??null);return '?';});
    return this.sqlite!.prepare(statement).all(...ordered as any[]);
  }
  async transaction<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    if (this.pool) {
      const client: PoolClient = await this.pool.connect();
      try { await client.query('BEGIN'); const value = await fn({ query: async (s, a = []) => (await client.query(s, a)).rows }); await client.query('COMMIT'); return value; }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const previous = this.tail; let release!: () => void;
    this.tail = new Promise<void>(r => { release = r; }); await previous;
    try { this.sqlite!.exec('BEGIN IMMEDIATE'); const value = await fn({ query: async (s, a = []) => this.sqliteQuery(s, a) }); this.sqlite!.exec('COMMIT'); return value; }
    catch (error) { this.sqlite!.exec('ROLLBACK'); throw error; } finally { release(); }
  }
  async initialize() {
    for (const sql of [
      `CREATE TABLE IF NOT EXISTS telecus_jobs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, owner_role TEXT NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL, body_hash TEXT NOT NULL, input_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error TEXT, created_at TEXT NOT NULL, lease_until TEXT, lease_token TEXT, attempts INTEGER NOT NULL DEFAULT 0, UNIQUE(owner_id,request_id))`,
      `CREATE INDEX IF NOT EXISTS telecus_jobs_queue ON telecus_jobs(status,created_at)`,
      `CREATE TABLE IF NOT EXISTS telecus_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, role TEXT NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS telecus_demo_profiles (id TEXT PRIMARY KEY, role TEXT NOT NULL, full_name TEXT NOT NULL, email TEXT NOT NULL, active INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS telecus_demo_appointments (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, patient_id TEXT NOT NULL, doctor_id TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, status TEXT NOT NULL, payment_status TEXT NOT NULL, reason TEXT NOT NULL, meet_url TEXT, appointment_type TEXT)`,
      `CREATE TABLE IF NOT EXISTS telecus_demo_changes (id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL, patient_id TEXT NOT NULL, request_type TEXT NOT NULL, requested_start_time TEXT, requested_end_time TEXT, status TEXT NOT NULL, reason TEXT NOT NULL, reviewed_by TEXT)`,
      `CREATE TABLE IF NOT EXISTS telecus_audit (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, operation TEXT NOT NULL, target_id TEXT NOT NULL, created_at TEXT NOT NULL)`
    ]) await this.query(sql);
    const columns=this.pool?(await this.query("SELECT column_name AS name FROM information_schema.columns WHERE table_name='telecus_demo_appointments' AND table_schema=current_schema()")):await this.query('PRAGMA table_info(telecus_demo_appointments)');
    if(!columns.some(c=>c.name==='appointment_type'))await this.query('ALTER TABLE telecus_demo_appointments ADD COLUMN appointment_type TEXT');
    await this.query(`CREATE TABLE IF NOT EXISTS telecus_notifications (id ${this.pool?'BIGSERIAL PRIMARY KEY':'INTEGER PRIMARY KEY AUTOINCREMENT'},event_key TEXT NOT NULL,event_type TEXT NOT NULL,payload_json TEXT NOT NULL,recipient_id TEXT NOT NULL,recipient_role TEXT NOT NULL,created_at TEXT NOT NULL,read_at TEXT,UNIQUE(event_key,recipient_id,recipient_role))`);
    await this.query('CREATE INDEX IF NOT EXISTS telecus_notifications_inbox ON telecus_notifications(recipient_id,recipient_role,id DESC)');
    await this.query('CREATE INDEX IF NOT EXISTS telecus_notifications_unread ON telecus_notifications(recipient_id,recipient_role,id DESC) WHERE read_at IS NULL');
    await this.query('CREATE TABLE IF NOT EXISTS telecus_public_rejections (request_id TEXT PRIMARY KEY,category TEXT NOT NULL,message TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL)');
    await this.query('CREATE TABLE IF NOT EXISTS telecus_notification_cleanup (id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,role TEXT NOT NULL,payload TEXT NOT NULL,total INTEGER NOT NULL)');
    await this.query('CREATE TABLE IF NOT EXISTS telecus_notification_dismissals (notification_id INTEGER PRIMARY KEY,actor_id TEXT NOT NULL,role TEXT NOT NULL,batch TEXT NOT NULL)');
    await this.query('CREATE INDEX IF NOT EXISTS telecus_notification_undo ON telecus_notification_dismissals(actor_id,role,batch)');
  }
  async close() { if (this.pool) await this.pool.end(); else this.sqlite?.close(); }
}
