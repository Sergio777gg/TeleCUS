-- Additive migration. Existing public tables, views, policies and data are preserved.
-- Run the whole file in one transaction. Only the trusted backend role can call it.
CREATE SCHEMA IF NOT EXISTS telecus_integration;
REVOKE ALL ON SCHEMA telecus_integration FROM PUBLIC, anon, authenticated, service_role;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='telecus_backend') THEN
    CREATE ROLE telecus_backend NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS telecus_integration.operations (
  id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES public.profiles(id),
  kind text NOT NULL, payload jsonb NOT NULL, result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telecus_integration.deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), operation_id uuid NOT NULL UNIQUE REFERENCES telecus_integration.operations(id),
  actor_id uuid NOT NULL REFERENCES public.profiles(id), actor_role text NOT NULL,
  appointment_id uuid NOT NULL REFERENCES public.appointments(id), request_id uuid REFERENCES public.appointment_change_requests(id),
  operation text NOT NULL CHECK(operation IN ('confirm','reschedule','cancel','complete','assign_doctor')),
  expected_updated_at timestamptz NOT NULL, appointment jsonb NOT NULL,
  stage text NOT NULL CHECK(stage IN ('calendar','mail')),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','sending','review','done')),
  lease_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(), last_error text, message_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_delivery_per_appointment ON telecus_integration.deliveries(appointment_id) WHERE status<>'done';
CREATE INDEX IF NOT EXISTS delivery_queue ON telecus_integration.deliveries(status,available_at,created_at);
REVOKE ALL ON ALL TABLES IN SCHEMA telecus_integration FROM PUBLIC, anon, authenticated, service_role, telecus_backend;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA telecus_integration FROM PUBLIC, anon, authenticated, service_role, telecus_backend;

CREATE OR REPLACE FUNCTION telecus_integration.version() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 1 $$;

CREATE OR REPLACE FUNCTION telecus_integration.actor(p_actor uuid) RETURNS public.profiles
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles;
BEGIN
 SELECT * INTO actor FROM public.profiles WHERE id=p_actor AND active;
 IF actor.id IS NULL THEN RAISE EXCEPTION 'Inactive actor' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.doctors(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM telecus_integration.actor(p_actor);
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'full_name',COALESCE(full_name,'Médico TeleCUS')) ORDER BY full_name)
 FROM public.profiles WHERE role='DOCTOR' AND active),'[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.interval(p_date text,p_time text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE start_at timestamptz;
BEGIN
 IF p_date IS NULL OR p_time IS NULL OR p_date !~ '^\d{4}-\d{2}-\d{2}$' OR p_time NOT IN ('14:00','14:30','15:00','15:30')
 THEN RAISE EXCEPTION 'Invalid schedule' USING ERRCODE='22023'; END IF;
 BEGIN start_at := (p_date || ' ' || p_time)::timestamp AT TIME ZONE 'America/Bogota';
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid date' USING ERRCODE='22023'; END;
 IF to_char(start_at AT TIME ZONE 'America/Bogota','YYYY-MM-DD')<>p_date
 OR extract(isodow FROM start_at AT TIME ZONE 'America/Bogota')<>1 OR start_at<=now()
 THEN RAISE EXCEPTION 'Invalid schedule' USING ERRCODE='22023'; END IF;
 RETURN start_at;
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.slot_free(p_doctor uuid,p_start timestamptz,p_end timestamptz,p_exclude uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_doctor AND role='DOCTOR' AND active)
 AND NOT EXISTS(SELECT 1 FROM public.appointments WHERE doctor_id=p_doctor AND id IS DISTINCT FROM p_exclude
 AND status IN ('PRE_RESERVED','CONFIRMED','RESCHEDULED') AND start_time<p_end AND end_time>p_start)
 AND NOT EXISTS(SELECT 1 FROM telecus_integration.deliveries WHERE stage='calendar' AND status<>'done'
 AND appointment_id IS DISTINCT FROM p_exclude AND (appointment->>'doctor_id')::uuid=p_doctor
 AND (appointment->>'start_time')::timestamptz<p_end AND (appointment->>'end_time')::timestamptz>p_start)
$$;

CREATE OR REPLACE FUNCTION telecus_integration.availability(p_actor uuid,p_doctor uuid,p_date text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles; time_of_day text; start_at timestamptz; result jsonb='[]';
BEGIN
 actor:=telecus_integration.actor(p_actor);
 IF actor.role NOT IN ('PATIENT','ADMIN') THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 FOREACH time_of_day IN ARRAY ARRAY['14:00','14:30','15:00','15:30'] LOOP
   BEGIN start_at:=telecus_integration.interval(p_date,time_of_day);
   EXCEPTION WHEN SQLSTATE '22023' THEN CONTINUE; END;
   IF telecus_integration.slot_free(p_doctor,start_at,start_at+interval '30 minutes') THEN result:=result||to_jsonb(time_of_day); END IF;
 END LOOP;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.execute(p_actor uuid,p_id uuid,p_kind text,p_payload jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles; a public.appointments; change public.appointment_change_requests;
 previous telecus_integration.operations; start_at timestamptz; end_at timestamptz; doctor uuid;
 target jsonb; operation text; result text; change_id uuid; pending_google boolean=false; locked_doctor uuid;
BEGIN
 actor:=telecus_integration.actor(p_actor);
 PERFORM pg_advisory_xact_lock(hashtextextended('telecus-operation:'||p_id,0));
 SELECT * INTO previous FROM telecus_integration.operations WHERE id=p_id;
 IF previous.id IS NOT NULL THEN
   IF previous.actor_id<>p_actor OR previous.kind<>p_kind OR previous.payload<>p_payload THEN RAISE EXCEPTION 'Operation mismatch' USING ERRCODE='42501'; END IF;
   RETURN previous.result;
 END IF;
 IF p_kind='reserve' THEN
   IF actor.role<>'PATIENT' THEN RAISE EXCEPTION 'Patient required' USING ERRCODE='42501'; END IF;
   PERFORM pg_advisory_xact_lock(hashtextextended('telecus-patient:'||p_actor,0));
   IF EXISTS(SELECT 1 FROM public.appointments WHERE patient_id=p_actor AND status IN ('PRE_RESERVED','CONFIRMED','RESCHEDULED'))
   THEN RAISE EXCEPTION 'Active appointment exists' USING ERRCODE='23505'; END IF;
   doctor:=(p_payload->>'doctor_id')::uuid;
   start_at:=telecus_integration.interval(p_payload->>'date',p_payload->>'time'); end_at:=start_at+interval '30 minutes';
   PERFORM pg_advisory_xact_lock(hashtextextended('telecus-doctor:'||doctor,0));
   IF NOT telecus_integration.slot_free(doctor,start_at,end_at) THEN RAISE EXCEPTION 'Slot taken' USING ERRCODE='23P01'; END IF;
   IF p_payload->>'payment_link' IS NOT NULL AND p_payload->>'payment_link' !~ '^https://' THEN RAISE EXCEPTION 'Invalid payment URL' USING ERRCODE='22023'; END IF;
   INSERT INTO public.appointments(patient_id,doctor_id,start_time,end_time,reason,payment_link)
   VALUES(p_actor,doctor,start_at,end_at,left(COALESCE(p_payload->>'reason','Consulta general'),300),p_payload->>'payment_link') RETURNING * INTO a;
   result:='Pre-reserva '||a.code||' registrada. El pago queda pendiente de verificación administrativa. Aún no hay evento de Calendar.'
   ||CASE WHEN a.payment_link IS NOT NULL THEN E'\nEnlace de pago: '||a.payment_link ELSE E'\nEl enlace de pago aún no está configurado; solicítalo al administrativo.' END;
 ELSE
   IF p_kind IN ('approve_change','reject_change') THEN
     IF actor.role<>'ADMIN' THEN RAISE EXCEPTION 'Admin required' USING ERRCODE='42501'; END IF;
     SELECT * INTO change FROM public.appointment_change_requests WHERE id=(p_payload->>'request_id')::uuid FOR UPDATE;
     IF change.id IS NULL OR change.status<>'PENDING' THEN RAISE EXCEPTION 'Request changed' USING ERRCODE='P0002'; END IF;
     SELECT * INTO a FROM public.appointments WHERE id=change.appointment_id FOR UPDATE;
     change_id:=change.id;
   ELSE
     SELECT * INTO a FROM public.appointments WHERE code=p_payload->>'appointment_code' FOR UPDATE;
   END IF;
   IF a.id IS NULL OR (actor.role='PATIENT' AND a.patient_id<>p_actor) OR (actor.role='DOCTOR' AND a.doctor_id<>p_actor)
   THEN RAISE EXCEPTION 'Forbidden appointment' USING ERRCODE='42501'; END IF;
   IF a.status IN ('CANCELLED','COMPLETED') OR EXISTS(SELECT 1 FROM telecus_integration.deliveries WHERE appointment_id=a.id AND status<>'done')
   THEN RAISE EXCEPTION 'Appointment changed or delivery pending' USING ERRCODE='P0002'; END IF;
   IF actor.role='DOCTOR' AND p_kind<>'complete' THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
   IF actor.role='PATIENT' AND p_kind NOT IN ('cancel','reschedule') THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
   doctor:=CASE WHEN p_kind='assign_doctor' THEN (p_payload->>'doctor_id')::uuid ELSE a.doctor_id END;
   FOR locked_doctor IN SELECT DISTINCT v FROM unnest(ARRAY[a.doctor_id,doctor]) v WHERE v IS NOT NULL ORDER BY v LOOP
     PERFORM pg_advisory_xact_lock(hashtextextended('telecus-doctor:'||locked_doctor,0));
   END LOOP;
   start_at:=a.start_time; end_at:=a.end_time;
   IF p_kind='reschedule' THEN
     start_at:=telecus_integration.interval(p_payload->>'date',p_payload->>'time'); end_at:=start_at+interval '30 minutes';
   ELSIF p_kind='approve_change' AND change.request_type='RESCHEDULE' THEN
     start_at:=telecus_integration.interval(to_char(change.requested_start_time AT TIME ZONE 'America/Bogota','YYYY-MM-DD'),to_char(change.requested_start_time AT TIME ZONE 'America/Bogota','HH24:MI'));
     end_at:=start_at+interval '30 minutes';
     IF end_at IS DISTINCT FROM change.requested_end_time THEN RAISE EXCEPTION 'Invalid interval' USING ERRCODE='22023'; END IF;
   END IF;
   IF p_kind IN ('reschedule','assign_doctor','verify_payment') OR (p_kind='approve_change' AND change.request_type='RESCHEDULE') THEN
     IF start_at<=now() OR NOT telecus_integration.slot_free(doctor,start_at,end_at,a.id) THEN RAISE EXCEPTION 'Slot taken' USING ERRCODE='23P01'; END IF;
   END IF;
   IF actor.role='PATIENT' AND a.payment_status='VERIFIED' THEN
     INSERT INTO public.appointment_change_requests(appointment_id,patient_id,request_type,requested_start_time,requested_end_time,reason)
     VALUES(a.id,p_actor,CASE WHEN p_kind='cancel' THEN 'CANCEL' ELSE 'RESCHEDULE' END,
       CASE WHEN p_kind='reschedule' THEN start_at END,CASE WHEN p_kind='reschedule' THEN end_at END,left(COALESCE(p_payload->>'reason','Solicitud del paciente'),300));
     result:='Solicitud pendiente de revisión administrativa. La cita original permanece igual.';
   ELSIF p_kind='reject_change' THEN
     UPDATE public.appointment_change_requests SET status='REJECTED',reviewed_by=p_actor,reviewed_at=now(),decision_note=left(COALESCE(p_payload->>'reason','Solicitud rechazada'),300) WHERE id=change.id;
     result:='Solicitud rechazada. La cita original permanece igual.';
   ELSIF p_kind='complete' THEN
     IF actor.role<>'DOCTOR' OR a.payment_status<>'VERIFIED' OR a.status NOT IN ('CONFIRMED','RESCHEDULED') OR a.end_time>now()
     THEN RAISE EXCEPTION 'Cannot complete' USING ERRCODE='22023'; END IF;
     UPDATE public.appointments SET status='COMPLETED',completed_at=now(),completed_by=p_actor WHERE id=a.id RETURNING * INTO a;
     operation:='complete'; result:='Cita '||a.code||' finalizada. Su notificación queda en la cola de correo.';
   ELSIF p_kind='verify_payment' THEN
     IF actor.role<>'ADMIN' OR a.payment_status<>'PENDING' OR a.status<>'PRE_RESERVED' THEN RAISE EXCEPTION 'Invalid payment state' USING ERRCODE='22023'; END IF;
     operation:='confirm'; pending_google:=true;
   ELSIF p_kind IN ('cancel','reschedule','assign_doctor','approve_change') THEN
     operation:=CASE WHEN p_kind='approve_change' THEN CASE WHEN change.request_type='CANCEL' THEN 'cancel' ELSE 'reschedule' END ELSE p_kind END;
     IF p_kind='assign_doctor' AND actor.role<>'ADMIN' THEN RAISE EXCEPTION 'Admin required' USING ERRCODE='42501'; END IF;
     IF p_kind='approve_change' AND (a.payment_status<>'VERIFIED' OR change.patient_id<>a.patient_id) THEN RAISE EXCEPTION 'Invalid request' USING ERRCODE='22023'; END IF;
     pending_google:=a.payment_status='VERIFIED';
     IF NOT pending_google THEN
       UPDATE public.appointments SET doctor_id=doctor,start_time=start_at,end_time=end_at,
       status=CASE WHEN operation='cancel' THEN 'CANCELLED' WHEN operation='reschedule' THEN 'PRE_RESERVED' ELSE status END
       WHERE id=a.id RETURNING * INTO a;
       operation:=NULL; result:=CASE WHEN p_kind='cancel' THEN 'Pre-reserva '||a.code||' cancelada.' ELSE 'Pre-reserva '||a.code||' actualizada. El pago sigue pendiente.' END;
     END IF;
   ELSE RAISE EXCEPTION 'Unknown operation' USING ERRCODE='22023'; END IF;
 END IF;
 IF pending_google THEN
   IF doctor IS NULL OR (operation<>'confirm' AND (a.calendar_event_id IS NULL OR a.calendar_event_id='')) THEN RAISE EXCEPTION 'Missing doctor or event' USING ERRCODE='22023'; END IF;
   result:='Operación de '||a.code||' registrada para sincronizar con Google. La cita cambiará cuando Calendar confirme el resultado; el correo se enviará después.';
 END IF;
 INSERT INTO telecus_integration.operations(id,actor_id,kind,payload,result) VALUES(p_id,p_actor,p_kind,p_payload,result);
 IF operation IS NOT NULL THEN
   SELECT jsonb_build_object('id',a.id,'code',a.code,'doctor_id',doctor,'start_time',start_at,'end_time',end_at,
    'patient_email',p.email,'doctor_email',d.email,'calendar_event_id',a.calendar_event_id,'meet_url',a.meet_url,
    'previous_doctor_email',old_d.email) INTO target
   FROM public.profiles p LEFT JOIN public.profiles d ON d.id=doctor LEFT JOIN public.profiles old_d ON old_d.id=a.doctor_id WHERE p.id=a.patient_id;
   IF target IS NULL OR target->>'patient_email' IS NULL OR (operation<>'complete' AND target->>'doctor_email' IS NULL) THEN RAISE EXCEPTION 'Missing recipients' USING ERRCODE='22023'; END IF;
   INSERT INTO telecus_integration.deliveries(operation_id,actor_id,actor_role,appointment_id,request_id,operation,expected_updated_at,appointment,stage)
   VALUES(p_id,p_actor,actor.role,a.id,change_id,operation,a.updated_at,target,CASE WHEN pending_google THEN 'calendar' ELSE 'mail' END);
 END IF;
 INSERT INTO public.appointment_logs(appointment_id,actor_user_id,action,details)
 VALUES(a.id,p_actor,p_kind||CASE WHEN pending_google THEN '_QUEUED' ELSE '' END,jsonb_build_object('operation_id',p_id,'source','telecus'));
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.claim_delivery() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d telecus_integration.deliveries;
BEGIN
 UPDATE telecus_integration.deliveries SET status='review',last_error='mail_delivery_uncertain',updated_at=now()
 WHERE status='sending' AND lease_until<now();
 UPDATE telecus_integration.deliveries SET status='review',last_error='calendar_retry_limit',updated_at=now()
 WHERE stage='calendar' AND status IN ('queued','running') AND attempts>=8 AND (lease_until IS NULL OR lease_until<now());
 SELECT * INTO d FROM telecus_integration.deliveries WHERE (status='queued' OR (status='running' AND lease_until<now()))
 AND available_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF d.id IS NULL THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=d.actor_id AND active AND role=d.actor_role)
 OR (d.stage='calendar' AND d.operation<>'cancel' AND NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=(d.appointment->>'doctor_id')::uuid AND active AND role='DOCTOR'))
 THEN UPDATE telecus_integration.deliveries SET status='review',last_error='actor_access_changed' WHERE id=d.id; RETURN NULL; END IF;
 UPDATE telecus_integration.deliveries SET status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',
 attempts=attempts+1,updated_at=now() WHERE id=d.id RETURNING * INTO d;
 RETURN jsonb_build_object('id',d.id,'stage',d.stage,'operation',d.operation,'appointment',d.appointment,'lease_token',d.lease_token);
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.finish_calendar(p_id uuid,p_token uuid,p_result jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d telecus_integration.deliveries; a public.appointments; actor public.profiles;
BEGIN
 SELECT * INTO d FROM telecus_integration.deliveries WHERE id=p_id FOR UPDATE;
 IF d.id IS NULL OR d.lease_token IS DISTINCT FROM p_token OR d.status<>'running' OR d.stage<>'calendar' OR d.lease_until<now()
 THEN RAISE EXCEPTION 'Lost lease' USING ERRCODE='40001'; END IF;
 actor:=telecus_integration.actor(d.actor_id);
 SELECT * INTO a FROM public.appointments WHERE id=d.appointment_id FOR UPDATE;
 IF actor.role<>d.actor_role OR a.updated_at IS DISTINCT FROM d.expected_updated_at THEN
   UPDATE telecus_integration.deliveries SET status='review',last_error='agenda_changed_after_calendar',updated_at=now() WHERE id=d.id;
   RETURN false;
 END IF;
 IF d.operation<>'cancel' AND (COALESCE(p_result->>'calendar_event_id','')='' OR COALESCE(p_result->>'meet_url','') !~ '^https://meet\.google\.com/')
 THEN RAISE EXCEPTION 'Missing Calendar/Meet result' USING ERRCODE='22023'; END IF;
 UPDATE public.appointments SET
 doctor_id=(d.appointment->>'doctor_id')::uuid,start_time=(d.appointment->>'start_time')::timestamptz,end_time=(d.appointment->>'end_time')::timestamptz,
 status=CASE WHEN d.operation='confirm' THEN 'CONFIRMED' WHEN d.operation='cancel' THEN 'CANCELLED' WHEN d.operation='reschedule' THEN 'RESCHEDULED' ELSE status END,
 payment_status=CASE WHEN d.operation='confirm' THEN 'VERIFIED' ELSE payment_status END,
 calendar_event_id=COALESCE(NULLIF(p_result->>'calendar_event_id',''),calendar_event_id),
 meet_url=CASE WHEN d.operation='cancel' THEN NULL ELSE COALESCE(NULLIF(p_result->>'meet_url',''),meet_url) END
 WHERE id=a.id RETURNING * INTO a;
 IF d.request_id IS NOT NULL THEN UPDATE public.appointment_change_requests SET status='APPROVED',reviewed_by=d.actor_id,reviewed_at=now() WHERE id=d.request_id AND status='PENDING'; END IF;
 IF d.operation='cancel' THEN UPDATE public.appointment_change_requests SET status='REJECTED',reviewed_by=d.actor_id,reviewed_at=now(),decision_note='Cita cancelada por el administrativo' WHERE appointment_id=a.id AND status='PENDING'; END IF;
 INSERT INTO public.appointment_logs(appointment_id,actor_user_id,action,details)
 VALUES(a.id,d.actor_id,d.operation||'_CALENDAR_CONFIRMED',jsonb_build_object('operation_id',d.operation_id,'source','telecus'));
 UPDATE telecus_integration.deliveries SET stage='mail',status='queued',attempts=0,lease_until=NULL,lease_token=NULL,last_error=NULL,
 appointment=appointment||jsonb_build_object('meet_url',a.meet_url,'calendar_event_id',a.calendar_event_id),updated_at=now() WHERE id=d.id;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.arm_mail(p_id uuid,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE telecus_integration.deliveries SET status='sending',updated_at=now()
 WHERE id=p_id AND lease_token=p_token AND status='running' AND stage='mail' AND lease_until>now();
 IF NOT FOUND THEN RAISE EXCEPTION 'Lost lease' USING ERRCODE='40001'; END IF;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.finish_mail(p_id uuid,p_token uuid,p_message text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF COALESCE(p_message,'')='' THEN RAISE EXCEPTION 'Missing mail receipt' USING ERRCODE='22023'; END IF;
 UPDATE telecus_integration.deliveries SET status='done',message_id=p_message,last_error=NULL,lease_until=NULL,lease_token=NULL,updated_at=now()
 WHERE id=p_id AND lease_token=p_token AND status='sending' AND stage='mail';
 IF NOT FOUND THEN RAISE EXCEPTION 'Lost lease' USING ERRCODE='40001'; END IF;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.fail_delivery(p_id uuid,p_token uuid,p_error text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE telecus_integration.deliveries SET status=CASE WHEN stage='mail' OR attempts>=8 THEN 'review' ELSE 'queued' END,
 last_error=CASE WHEN stage='mail' THEN 'mail_delivery_uncertain' ELSE 'calendar_failed' END,
 available_at=now()+make_interval(secs=>least(300,5*(2^least(attempts,6))::integer)),lease_until=NULL,lease_token=NULL,updated_at=now()
 WHERE id=p_id AND lease_token=p_token AND status IN ('running','sending');
 RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.delivery_status(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles;
BEGIN
 actor:=telecus_integration.actor(p_actor);
 RETURN COALESCE((SELECT jsonb_agg(x) FROM (SELECT d.id,a.code,d.operation,d.stage,d.status,d.last_error,d.updated_at
 FROM telecus_integration.deliveries d JOIN public.appointments a ON a.id=d.appointment_id
 WHERE actor.role='ADMIN' OR d.actor_id=p_actor ORDER BY d.created_at DESC LIMIT 50) x),'[]'::jsonb);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA telecus_integration FROM PUBLIC, anon, authenticated, service_role, telecus_backend;
GRANT USAGE ON SCHEMA telecus_integration TO telecus_backend;
GRANT EXECUTE ON FUNCTION telecus_integration.version(),telecus_integration.doctors(uuid),telecus_integration.availability(uuid,uuid,text),
 telecus_integration.execute(uuid,uuid,text,jsonb),telecus_integration.claim_delivery(),telecus_integration.finish_calendar(uuid,uuid,jsonb),
 telecus_integration.arm_mail(uuid,uuid),telecus_integration.finish_mail(uuid,uuid,text),telecus_integration.fail_delivery(uuid,uuid,text),
 telecus_integration.delivery_status(uuid) TO telecus_backend;
