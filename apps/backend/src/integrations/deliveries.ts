import type { GooglePort,GoogleTask,DeliveryStore } from '../ports/integrations.js';
export type { GooglePort,DeliveryStore } from '../ports/integrations.js';

/** Calendar retries recover stable IDs. Ambiguous mail sends always require review. */
export class DeliveryWorker {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  private consecutiveFailures = 0;
  private static readonly BASE_INTERVAL_MS = 1000;
  private static readonly MAX_INTERVAL_MS = 60 * 1000;
  constructor(private store: DeliveryStore, private google: GooglePort) {}
  async workOnce() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const job = await this.store.call('claim_delivery');
      if (!job) {
        this.consecutiveFailures = 0;
        return;
      }
      const task: GoogleTask = {operation:job.operation,appointment:job.appointment,delivery_id:job.id};
      try {
        if (job.stage === 'calendar') {
          const result = await this.google.calendar(task);
          await this.store.call('finish_calendar',[job.id,job.lease_token,JSON.stringify(result)]);
          this.consecutiveFailures = 0;
        } else {
          // Persist 'sending' before transmitting anything. A lost response is not retried.
          await this.store.call('arm_mail',[job.id,job.lease_token]);
          const result = await this.google.sendNotification(task);
          await this.store.call('finish_mail',[job.id,job.lease_token,String(result.id || '')]);
          this.consecutiveFailures = 0;
        }
      } catch {
        await this.store.call('fail_delivery',[job.id,job.lease_token,job.stage==='calendar'?'calendar_failed':'mail_delivery_uncertain']);
        this.consecutiveFailures++;
      }
    } finally { this.busy = false; }
  }
  private intervalForFailures(failures: number): number {
    return Math.min(DeliveryWorker.BASE_INTERVAL_MS * Math.pow(2, failures), DeliveryWorker.MAX_INTERVAL_MS);
  }
  private scheduleNext() {
    if (this.stopped) return;
    const delay = this.intervalForFailures(this.consecutiveFailures);
    this.timer = setTimeout(() => {
      void this.workOnce().catch(()=>console.error('La entrega a Google necesita revisión.'));
      this.scheduleNext();
    }, delay);
    this.timer.unref();
  }
  start() { this.scheduleNext(); }
  async stop() { this.stopped=true; if(this.timer)clearTimeout(this.timer); while(this.busy)await new Promise(r=>setTimeout(r,100)); }
}
