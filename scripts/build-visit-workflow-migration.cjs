// Generates NEW migration 010 from versioned SQL. Never edits installed migrations.
const fs=require('node:fs'),path=require('node:path');process.chdir(path.resolve(__dirname,'..'));
const read=n=>fs.readFileSync('scripts/sql/'+n,'utf8');
const source={base:read('001-agenda-integration.sql'),notifications:read('002-notifications.sql'),admin:read('005-administration.sql'),schedule:read('006-service-schedule.sql'),workspace:read('007-staff-workspace.sql'),inbox:read('009-payment-inbox.sql')};
function fn(sql,name){const m=new RegExp('CREATE(?: OR REPLACE)? FUNCTION telecus_integration\\.'+name+'\\(').exec(sql);if(!m)throw Error('Function missing: '+name);const open=sql.indexOf('$$',m.index),end=sql.indexOf('$$;',open+2);if(end<0)throw Error('Body missing');return sql.slice(m.index,end+3).replace(/^CREATE FUNCTION/,'CREATE OR REPLACE FUNCTION');}
function change(s,from,to){if(!s.includes(from))throw Error('Migration source differs: '+from.slice(0,80));return s.replace(from,to);}
const free=id=>`telecus_integration.is_free_visit(${id})`,clear=id=>`telecus_integration.visit_cleared(${id})`;
let settings=fn(source.admin,'administration_write');
settings=change(settings,"before_data:=to_jsonb(cfg);target_key:='portal';","IF p_payload?'payments_enabled' AND jsonb_typeof(p_payload->'payments_enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid payment policy' USING ERRCODE='22023';END IF;\n  before_data:=to_jsonb(cfg);target_key:='portal';");
settings=change(settings,"support_phone=p_payload->>'support_phone' WHERE singleton;","support_phone=p_payload->>'support_phone',payments_enabled=COALESCE((p_payload->>'payments_enabled')::boolean,payments_enabled) WHERE singleton;");
let core=fn(source.base,'execute').replace('telecus_integration.execute(','telecus_integration.execute_free010(');
core=core.replaceAll("a.payment_status='VERIFIED'",clear('a.id')).replaceAll("a.payment_status<>'VERIFIED'",'NOT '+clear('a.id'));
core=change(core,"('reschedule','assign_doctor','verify_payment')","('reschedule','assign_doctor','verify_payment','confirm_free')");
core=change(core,"ELSIF p_kind='verify_payment' THEN",`ELSIF p_kind='confirm_free' THEN
     IF actor.role<>'ADMIN' OR NOT ${free('a.id')} OR a.status<>'PRE_RESERVED' THEN RAISE EXCEPTION 'Invalid free admission' USING ERRCODE='22023';END IF;
     operation:='confirm';pending_google:=true;
   ELSIF p_kind='verify_payment' THEN`);
core=change(core,"a.payment_status<>'PENDING' OR a.status<>'PRE_RESERVED'",`a.payment_status<>'PENDING' OR a.status<>'PRE_RESERVED' OR ${free('a.id')}`);
core=change(core,"'Pre-reserva '||a.code||' actualizada. El pago sigue pendiente.'","'Solicitud gratuita '||a.code||' actualizada. No requiere pago.'");
let finish=fn(source.base,'finish_calendar');finish=change(finish,"payment_status=CASE WHEN d.operation='confirm' THEN 'VERIFIED'",`payment_status=CASE WHEN d.operation='confirm' AND NOT ${free('a.id')} THEN 'VERIFIED'`);
let snapshot=fn(source.workspace,'staff_snapshot');snapshot=snapshot.replaceAll("target.payment_status<>'VERIFIED'",'NOT '+clear('target.id'));
snapshot=change(snapshot,"('cancel','reschedule','assign_doctor','approve_change','reject_change')","('cancel','reschedule','assign_doctor','approve_change','reject_change','confirm_free')");
snapshot=change(snapshot,"IF p_kind='assign_doctor' THEN",`IF p_kind='confirm_free' AND (NOT ${free('target.id')} OR target.status<>'PRE_RESERVED' OR target.start_time<=now()) THEN RAISE EXCEPTION 'Invalid free admission' USING ERRCODE='P0002';END IF;\n IF p_kind='assign_doctor' THEN`);
let workspace=fn(source.inbox,'workspace_appointments');workspace=workspace.replaceAll("a.payment_status='VERIFIED'",clear('a.id'));
workspace=change(workspace,'a.status,a.payment_status,a.meet_url',`a.status,CASE WHEN ${free('a.id')} THEN 'NOT_REQUIRED' ELSE a.payment_status::text END AS payment_status,a.meet_url,c.appointment_type`);
workspace=change(workspace,'FROM public.appointments a JOIN public.profiles d ON d.id=a.doctor_id','FROM public.appointments a JOIN public.profiles d ON d.id=a.doctor_id LEFT JOIN telecus_integration.visit_context c ON c.appointment_id=a.id');
workspace=change(workspace,"'payment_status',payment_status)","'payment_status',payment_status,'appointment_type',appointment_type)");
workspace=workspace.replaceAll("payment_status='VERIFIED'","payment_status IN ('VERIFIED','NOT_REQUIRED')");
workspace=change(workspace,"'pending_payments',CASE", "'pending_admissions',(SELECT count(*) FROM scoped WHERE status='PRE_RESERVED' AND payment_status='NOT_REQUIRED' AND start_time>now()),'pending_payments',CASE");
let inbox=fn(source.inbox,'administration_read');inbox=change(inbox,"a.payment_status='PENDING' AND a.start_time>now()",`a.payment_status='PENDING' AND NOT ${free('a.id')} AND a.start_time>now()`);
let paymentSnapshot=fn(source.admin,'payment_review_snapshot');paymentSnapshot=change(paymentSnapshot,"IF a.id IS NULL OR a.status",`IF a.id IS NULL OR ${free('a.id')} OR a.status`);
let receiptList=fn(source.admin,'list_payment_receipts').replace('telecus_integration.list_payment_receipts(','telecus_integration.list_receipts_before006(');receiptList=change(receiptList,"a.payment_status='PENDING'",`a.payment_status='PENDING' AND NOT ${free('a.id')}`);
let expire=fn(source.schedule,'expire_holds');expire=change(expire,"a.payment_status='PENDING'",`a.payment_status='PENDING' AND NOT ${free('a.id')}`);
let publish=fn(source.schedule,'publish_notification');publish=change(publish,"'request_type',r.request_type,","'request_type',r.request_type,'payment_required',NOT telecus_integration.is_free_visit(a.id),");
let trigger=fn(source.notifications,'appointment_notification_trigger');trigger=trigger.replaceAll("NEW.payment_status='VERIFIED'",`(NEW.payment_status='VERIFIED' OR ${free('NEW.id')})`).replaceAll("OLD.payment_status='VERIFIED'",`(OLD.payment_status='VERIFIED' OR ${free('OLD.id')})`);
trigger=change(trigger,`IF (NEW.payment_status='VERIFIED' OR ${free('NEW.id')}) THEN physician`, `IF NEW.payment_status='VERIFIED' OR (${free('NEW.id')} AND NEW.status IN ('CONFIRMED','RESCHEDULED','COMPLETED')) THEN physician`);
const sql=`-- 010: typed visits and immutable per-appointment billing. Existing public schema/RLS retained.
ALTER TABLE telecus_integration.portal_configuration ADD COLUMN payments_enabled boolean NOT NULL DEFAULT true;
CREATE TABLE telecus_integration.visit_context (
 appointment_id uuid PRIMARY KEY REFERENCES public.appointments(id),
 appointment_type text CHECK(appointment_type IN ('FOLLOW_UP','RESULTS_REVIEW','NON_URGENT_GUIDANCE','CHRONIC_FOLLOW_UP','GENERAL_CERTIFICATE')),
 payment_required boolean NOT NULL,policy_version bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON telecus_integration.visit_context FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
CREATE FUNCTION telecus_integration.visit_workflow_version() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 1 $$;
CREATE FUNCTION telecus_integration.is_free_visit(p_id uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM telecus_integration.visit_context WHERE appointment_id=p_id AND NOT payment_required)
$$;
CREATE FUNCTION telecus_integration.visit_cleared(p_id uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.appointments a WHERE a.id=p_id AND (a.payment_status='VERIFIED' OR (telecus_integration.is_free_visit(a.id) AND a.status IN ('CONFIRMED','RESCHEDULED','COMPLETED'))))
$$;
CREATE OR REPLACE FUNCTION telecus_integration.portal_settings() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version',version::text,'payment_url',payment_url,'support_phone',support_phone,'payments_enabled',payments_enabled,'visit_workflow_available',true) FROM telecus_integration.portal_configuration WHERE singleton
$$;
${settings}
CREATE FUNCTION telecus_integration.capture_visit_context() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO telecus_integration.visit_context(appointment_id,payment_required,policy_version) SELECT NEW.id,payments_enabled,version FROM telecus_integration.portal_configuration WHERE singleton;
 RETURN NEW;
END $$;
-- PostgreSQL runs same-event triggers in name order: capture billing before publishing a notice.
CREATE TRIGGER telecus_appointment_billing AFTER INSERT ON public.appointments FOR EACH ROW EXECUTE FUNCTION telecus_integration.capture_visit_context();
${core}
ALTER FUNCTION telecus_integration.execute(uuid,uuid,text,jsonb) RENAME TO execute_before010;
CREATE FUNCTION telecus_integration.execute(p_actor uuid,p_id uuid,p_kind text,p_payload jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cfg telecus_integration.portal_configuration;a public.appointments;old telecus_integration.operations;answer text;fresh jsonb;original_payload jsonb:=p_payload;selected_doctor uuid;start_at timestamptz;
BEGIN
 PERFORM telecus_integration.actor(p_actor);PERFORM pg_advisory_xact_lock(hashtextextended('telecus-operation:'||p_id,0));
 SELECT * INTO old FROM telecus_integration.operations WHERE id=p_id;
 IF old.id IS NOT NULL THEN
  IF old.actor_id<>p_actor OR old.kind<>p_kind OR old.payload<>p_payload THEN RAISE EXCEPTION 'Operation mismatch' USING ERRCODE='42501';END IF;
  RETURN old.result;
 END IF;
 IF p_kind='reserve' THEN
  SELECT * INTO cfg FROM telecus_integration.portal_configuration WHERE singleton FOR SHARE;
  IF p_payload->>'visit_policy_version' IS DISTINCT FROM cfg.version::text OR COALESCE(p_payload->>'appointment_type','') NOT IN ('FOLLOW_UP','RESULTS_REVIEW','NON_URGENT_GUIDANCE','CHRONIC_FOLLOW_UP','GENERAL_CERTIFICATE') THEN RAISE EXCEPTION 'Visit policy changed' USING ERRCODE='P0002';END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('telecus-service-schedule',0));
  start_at:=telecus_integration.interval(p_payload->>'date',p_payload->>'time');
  PERFORM pg_advisory_xact_lock(hashtextextended('telecus-allocation:'||(p_payload->>'date'),0));
  PERFORM telecus_integration.expire_holds();
  SELECT d.id INTO selected_doctor FROM public.profiles d WHERE d.role='DOCTOR' AND d.active AND telecus_integration.slot_free(d.id,start_at,start_at+interval '30 minutes')
  ORDER BY (SELECT count(*) FROM public.appointments x WHERE x.doctor_id=d.id AND x.status NOT IN ('CANCELLED','COMPLETED') AND x.start_time>=((p_payload->>'date')::date::timestamp AT TIME ZONE 'America/Bogota') AND x.start_time<(((p_payload->>'date')::date+1)::timestamp AT TIME ZONE 'America/Bogota')),d.id LIMIT 1;
  IF selected_doctor IS NULL THEN RAISE EXCEPTION 'Slot taken' USING ERRCODE='23P01';END IF;
  p_payload:=p_payload||jsonb_build_object('doctor_id',selected_doctor);
  answer:=telecus_integration.execute_before010(p_actor,p_id,p_kind,p_payload);
  SELECT * INTO a FROM public.appointments WHERE patient_id=p_actor AND doctor_id=(p_payload->>'doctor_id')::uuid AND start_time=((p_payload->>'date')||' '||(p_payload->>'time'))::timestamp AT TIME ZONE 'America/Bogota' AND status='PRE_RESERVED';
  UPDATE telecus_integration.visit_context SET appointment_type=p_payload->>'appointment_type' WHERE appointment_id=a.id;
  UPDATE telecus_integration.operations SET payload=original_payload WHERE id=p_id;
  IF NOT cfg.payments_enabled THEN
   DELETE FROM telecus_integration.reservation_holds WHERE appointment_id=a.id;
   UPDATE public.appointments SET payment_link=NULL WHERE id=a.id;
   answer:='Solicitud gratuita '||a.code||' registrada. Queda pendiente de revisión administrativa. No debes pagar ni enviar comprobantes.';
   UPDATE telecus_integration.operations SET result=answer WHERE id=p_id;
  END IF;
  RETURN answer;
 END IF;
 SELECT * INTO a FROM public.appointments WHERE code=p_payload->>'appointment_code';
 IF p_kind IN ('approve_change','reject_change') THEN SELECT x.* INTO a FROM public.appointments x JOIN public.appointment_change_requests r ON r.appointment_id=x.id WHERE r.id=(p_payload->>'request_id')::uuid;END IF;
 IF p_kind='confirm_free' OR telecus_integration.is_free_visit(a.id) THEN
  IF NOT (p_payload?'expected_snapshot') AND p_kind='confirm_free' THEN RAISE EXCEPTION 'Review required' USING ERRCODE='22023';END IF;
  IF p_payload?'expected_snapshot' THEN
   PERFORM pg_advisory_xact_lock_shared(hashtextextended('telecus-service-schedule',0));fresh:=telecus_integration.staff_snapshot(p_actor,p_kind,p_payload);
   IF fresh->'snapshot' IS DISTINCT FROM p_payload->'expected_snapshot' THEN RAISE EXCEPTION 'Appointment changed' USING ERRCODE='P0002';END IF;
  END IF;
  IF p_kind='reschedule' AND p_payload->>'schedule_version' IS NOT NULL AND p_payload->>'schedule_version' IS DISTINCT FROM (SELECT max(version)::text FROM telecus_integration.service_schedules) THEN RAISE EXCEPTION 'Schedule changed' USING ERRCODE='P0002';END IF;
  RETURN telecus_integration.execute_free010(p_actor,p_id,p_kind,p_payload);
 END IF;
 RETURN telecus_integration.execute_before010(p_actor,p_id,p_kind,p_payload);
END $$;
${finish}
${snapshot}
${workspace}
${inbox}
${paymentSnapshot}
${receiptList}
${expire}
${publish}
${trigger}
ALTER FUNCTION telecus_integration.upload_payment_receipt(uuid,uuid,uuid,jsonb) RENAME TO upload_receipt_before010;
CREATE FUNCTION telecus_integration.upload_payment_receipt(p_actor uuid,p_appointment uuid,p_request uuid,p_file jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM telecus_integration.actor(p_actor);
 IF telecus_integration.is_free_visit(p_appointment) THEN RAISE EXCEPTION 'No payment required' USING ERRCODE='P0002';END IF;
 RETURN telecus_integration.upload_receipt_before010(p_actor,p_appointment,p_request,p_file);
END $$;
CREATE FUNCTION telecus_integration.scoped_visit_appointments(p_actor uuid,p_ids jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE who public.profiles;result jsonb;
BEGIN
 who:=telecus_integration.actor(p_actor);
 IF p_ids IS NOT NULL AND (jsonb_typeof(p_ids)<>'array' OR jsonb_array_length(p_ids)>100) THEN RAISE EXCEPTION 'Invalid ids' USING ERRCODE='22023';END IF;
 SELECT COALESCE(jsonb_agg(x ORDER BY start_time,id),'[]') INTO result FROM (
 SELECT a.id,a.code,a.patient_id,a.doctor_id,a.start_time,a.end_time,a.status,
 CASE WHEN telecus_integration.is_free_visit(a.id) THEN 'NOT_REQUIRED' ELSE a.payment_status::text END AS payment_status,c.appointment_type,
 CASE WHEN a.status IN ('CONFIRMED','RESCHEDULED') THEN a.meet_url END AS meet_url
 FROM public.appointments a LEFT JOIN telecus_integration.visit_context c ON c.appointment_id=a.id
 WHERE (who.role='ADMIN' OR who.role='PATIENT' AND a.patient_id=p_actor OR who.role='DOCTOR' AND a.doctor_id=p_actor AND telecus_integration.visit_cleared(a.id) AND a.status NOT IN ('PRE_RESERVED','CANCELLED','COMPLETED'))
 AND (p_ids IS NULL OR p_ids ? a.id::text) ORDER BY a.start_time,a.id LIMIT 100) x;
 RETURN result;
END $$;
CREATE FUNCTION telecus_integration.service_availability(p_actor uuid,p_date text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
 PERFORM telecus_integration.actor(p_actor);
 SELECT COALESCE(jsonb_agg(slot ORDER BY slot),'[]') INTO result FROM (SELECT DISTINCT v.value AS slot FROM public.profiles d CROSS JOIN LATERAL jsonb_array_elements_text(telecus_integration.availability(p_actor,d.id,p_date)) v WHERE d.role='DOCTOR' AND d.active) s;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION telecus_integration.service_availability(uuid,text) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
GRANT EXECUTE ON FUNCTION telecus_integration.service_availability(uuid,text) TO telecus_backend;
REVOKE ALL ON FUNCTION telecus_integration.visit_workflow_version(),telecus_integration.is_free_visit(uuid),telecus_integration.visit_cleared(uuid),telecus_integration.capture_visit_context(),telecus_integration.execute_free010(uuid,uuid,text,jsonb),telecus_integration.execute_before010(uuid,uuid,text,jsonb),telecus_integration.upload_receipt_before010(uuid,uuid,uuid,jsonb),telecus_integration.scoped_visit_appointments(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
REVOKE ALL ON FUNCTION telecus_integration.execute(uuid,uuid,text,jsonb),telecus_integration.upload_payment_receipt(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
GRANT EXECUTE ON FUNCTION telecus_integration.visit_workflow_version(),telecus_integration.scoped_visit_appointments(uuid,jsonb),telecus_integration.execute(uuid,uuid,text,jsonb),telecus_integration.upload_payment_receipt(uuid,uuid,uuid,jsonb) TO telecus_backend;
-- Replaced functions preserve their established EXECUTE grants; renamed delegates remain private.
`;
// Use an unambiguous PL/pgSQL variable for the operation result update.
fs.writeFileSync('scripts/sql/010-visit-workflow.sql',sql);
console.log('Migration 010 generated; existing migrations unchanged.');
