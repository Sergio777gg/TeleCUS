export type Role = 'PATIENT' | 'ADMIN' | 'DOCTOR';
export type Profile = { id: string; role: Role; full_name: string; email: string; active: boolean; token?: string };
export type Intent = {
  intent: 'greeting' | 'menu' | 'change_options' | 'list_appointments' | 'select_appointment' | 'availability' | 'reserve' | 'reschedule' | 'cancel' | 'payment_status' | 'pending_payments' | 'pending_requests' | 'request_status' | 'select_request' | 'verify_payment' | 'assign_doctor' | 'approve_change' | 'reject_change' | 'complete' | 'knowledge' | 'confirm' | 'deny' | 'support' | 'unknown';
  appointment_code: string | null; doctor_name: string | null; date: string | null; time: string | null; reason: string | null; request_id: string | null;
  date_expression?:string|null; navigation?:'current'|'main_menu'|null; option_number?:number|null; reference_index?:number|null;
  appointment_type?:string|null;
  inquiry?:'capability'|'availability'|'payment'|'attendance';appointment_view?:'current'|'history'|'all';reset_slot?:'time'|'date'|'doctor';
  dialogue_act?:'answer'|'correct'|'new_task'|'clarify'|'refuse'|'social'|'ask'|null;
  reference_time?:string|null;
  dialogue_target?:'doctor'|'date'|'time'|'reason'|'appointment'|'request'|'option'|'task'|null;
  request_view?:'pending'|'reviewed'|'all'|null; request_type?:'CANCEL'|'RESCHEDULE'|null; request_state?:'PENDING'|'APPROVED'|'REJECTED'|null;
};
export type Proposal = { id: string; kind: string; summary: string; expires_at: string; payload: Record<string, any> };
export type Reply = { reply: string; proposal?: Omit<Proposal, 'payload'>; model?: string; mode: string; handoff?:{reason:'requested'|'unresolved'|'technical'};ui_action?:'payments';choices?:{label:string;value:string}[] };
export type ChatInput = { chatInput: string; sessionId: string; requestId: string; action: 'sendMessage' | 'roleOverview' | 'confirm' | 'dismiss'; proposalId?: string };
export const intents = ['greeting','menu','change_options','list_appointments','select_appointment','availability','reserve','reschedule','cancel','payment_status','pending_payments','pending_requests','request_status','select_request','verify_payment','assign_doctor','approve_change','reject_change','complete','knowledge','confirm','deny','support','unknown'];
