-- 010: typed visits and immutable per-appointment billing. Existing public schema/RLS retained.
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
CREATE OR REPLACE FUNCTION telecus_integration.administration_write(p_actor uuid,p_request uuid,p_resource text,p_expected text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles;previous telecus_integration.admin_commands;target public.profiles;cfg telecus_integration.portal_configuration;
 reg telecus_integration.registrations;doc telecus_integration.knowledge_documents;revision uuid;fingerprint text;result jsonb:='{"status":"saved"}';target_key text;before_data jsonb;
BEGIN
 actor:=telecus_integration.admin_actor(p_actor);
 IF p_request IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid command' USING ERRCODE='22023';END IF;
 fingerprint:=md5(jsonb_build_array(p_resource,p_expected,p_payload)::text);
 PERFORM pg_advisory_xact_lock(hashtextextended('admin-command:'||p_request,0));
 SELECT * INTO previous FROM telecus_integration.admin_commands WHERE id=p_request;
 IF previous.id IS NOT NULL THEN
  IF previous.actor_id<>p_actor OR previous.fingerprint<>fingerprint THEN RAISE EXCEPTION 'Command mismatch' USING ERRCODE='23505';END IF;
  RETURN previous.result;
 END IF;
 IF p_resource='settings' THEN
  SELECT * INTO cfg FROM telecus_integration.portal_configuration WHERE singleton FOR UPDATE;
  IF cfg.version::text IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Settings changed' USING ERRCODE='P0002';END IF;
  IF COALESCE(p_payload->>'payment_url','') !~ '^https://[a-zA-Z0-9.-]+[.][a-zA-Z]{2,}(/[^[:space:]]*)?$' OR length(p_payload->>'payment_url')>1000
   OR p_payload->>'payment_url' ~ '[@#]' OR COALESCE(p_payload->>'support_phone','') !~ '^[1-9][0-9]{10,14}$'
   THEN RAISE EXCEPTION 'Invalid portal settings' USING ERRCODE='22023';END IF;
  IF p_payload?'payments_enabled' AND jsonb_typeof(p_payload->'payments_enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid payment policy' USING ERRCODE='22023';END IF;
  before_data:=to_jsonb(cfg);target_key:='portal';
  UPDATE telecus_integration.portal_configuration SET version=version+1,payment_url=p_payload->>'payment_url',support_phone=p_payload->>'support_phone',payments_enabled=COALESCE((p_payload->>'payments_enabled')::boolean,payments_enabled) WHERE singleton;
 ELSIF p_resource IN ('profile','registration') THEN
  IF COALESCE(p_payload->>'role','') NOT IN ('PATIENT','DOCTOR') OR length(trim(COALESCE(p_payload->>'full_name',''))) NOT BETWEEN 1 AND 120 OR p_payload->>'full_name' ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'Invalid profile' USING ERRCODE='22023';END IF;
  IF p_resource='profile' THEN
   SELECT * INTO target FROM public.profiles WHERE id=(p_payload->>'id')::uuid FOR UPDATE;
   IF target.id IS NULL OR target.role='ADMIN' THEN RAISE EXCEPTION 'Profile not manageable' USING ERRCODE='42501';END IF;
   IF telecus_integration.profile_version(target) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Profile changed' USING ERRCODE='P0002';END IF;
   IF jsonb_typeof(p_payload->'active') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid profile state' USING ERRCODE='22023';END IF;
   IF (NOT (p_payload->>'active')::boolean OR target.role<>p_payload->>'role') AND EXISTS(SELECT 1 FROM public.appointments WHERE (patient_id=target.id OR doctor_id=target.id) AND status NOT IN ('CANCELLED','COMPLETED') AND end_time>now())
    THEN RAISE EXCEPTION 'Resolve active appointments first' USING ERRCODE='P0002';END IF;
   before_data:=jsonb_build_object('name',target.full_name,'role',target.role,'active',target.active);target_key:=target.id::text;
   UPDATE public.profiles SET full_name=trim(p_payload->>'full_name'),role=p_payload->>'role',active=(p_payload->>'active')::boolean WHERE id=target.id;
  ELSE
   IF COALESCE(p_payload->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' OR length(p_payload->>'email')>254 THEN RAISE EXCEPTION 'Invalid email' USING ERRCODE='22023';END IF;
   PERFORM pg_advisory_xact_lock(hashtextextended('registration:'||lower(p_payload->>'email'),0));
   IF EXISTS(SELECT 1 FROM public.profiles WHERE lower(email)=lower(p_payload->>'email')) OR EXISTS(SELECT 1 FROM auth.users WHERE lower(email)=lower(p_payload->>'email')) THEN RAISE EXCEPTION 'Identity already exists' USING ERRCODE='23505';END IF;
   INSERT INTO telecus_integration.registrations(email,full_name,role,created_by) VALUES(lower(p_payload->>'email'),trim(p_payload->>'full_name'),p_payload->>'role',p_actor) RETURNING id INTO revision;
   target_key:=revision::text;result:=jsonb_build_object('status','registered','id',revision);
  END IF;
 ELSIF p_resource='registration_cancel' THEN
  SELECT * INTO reg FROM telecus_integration.registrations WHERE id=(p_payload->>'id')::uuid FOR UPDATE;
  IF reg.id IS NULL OR reg.status<>'PENDING' OR reg.version::text IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Registration changed' USING ERRCODE='P0002';END IF;
  target_key:=reg.id::text;before_data:=jsonb_build_object('status',reg.status);
  UPDATE telecus_integration.registrations SET status='CANCELLED',version=version+1 WHERE id=reg.id;
 ELSIF p_resource IN ('knowledge_save','knowledge_publish') THEN
  SELECT * INTO doc FROM telecus_integration.knowledge_documents WHERE file=p_payload->>'file' FOR UPDATE;
  IF doc.file IS NULL OR doc.version::text IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Document changed' USING ERRCODE='P0002';END IF;
  target_key:=doc.file;before_data:=jsonb_build_object('version',doc.version,'published_id',doc.published_id);
  IF p_resource='knowledge_save' THEN
   IF length(trim(COALESCE(p_payload->>'body',''))) NOT BETWEEN 10 AND 20000 OR left(trim(p_payload->>'body'),3)='---'
    OR EXISTS(SELECT 1 FROM regexp_split_to_table(p_payload->>'body',E'\\n(?=# )') section WHERE length(section)>4500)
    THEN RAISE EXCEPTION 'Invalid document body' USING ERRCODE='22023';END IF;
   INSERT INTO telecus_integration.knowledge_revisions(file,body,created_by) VALUES(doc.file,p_payload->>'body',p_actor) RETURNING id INTO revision;
  ELSE
   revision:=(p_payload->>'revision_id')::uuid;
   IF NOT EXISTS(SELECT 1 FROM telecus_integration.knowledge_revisions WHERE id=revision AND file=doc.file) THEN RAISE EXCEPTION 'Unknown revision' USING ERRCODE='P0002';END IF;
   UPDATE telecus_integration.knowledge_documents SET published_id=revision WHERE file=doc.file;
  END IF;
  UPDATE telecus_integration.knowledge_documents SET version=version+1 WHERE file=doc.file;
 ELSE RAISE EXCEPTION 'Unknown administrative command' USING ERRCODE='22023';
 END IF;
 INSERT INTO telecus_integration.admin_audit(actor_id,action,target,details) VALUES(p_actor,p_resource,target_key,jsonb_build_object('previous',before_data,'new',p_payload,'request',p_request));
 INSERT INTO telecus_integration.admin_commands(id,actor_id,fingerprint,result) VALUES(p_request,p_actor,fingerprint,result);
 RETURN result;
END $$;
CREATE FUNCTION telecus_integration.capture_visit_context() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO telecus_integration.visit_context(appointment_id,payment_required,policy_version) SELECT NEW.id,payments_enabled,version FROM telecus_integration.portal_configuration WHERE singleton;
 RETURN NEW;
END $$;
-- PostgreSQL runs same-event triggers in name order: capture billing before publishing a notice.
CREATE TRIGGER telecus_appointment_billing AFTER INSERT ON public.appointments FOR EACH ROW EXECUTE FUNCTION telecus_integration.capture_visit_context();
CREATE OR REPLACE FUNCTION telecus_integration.execute_free010(p_actor uuid,p_id uuid,p_kind text,p_payload jsonb) RETURNS text
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
   IF p_kind IN ('reschedule','assign_doctor','verify_payment','confirm_free') OR (p_kind='approve_change' AND change.request_type='RESCHEDULE') THEN
     IF start_at<=now() OR NOT telecus_integration.slot_free(doctor,start_at,end_at,a.id) THEN RAISE EXCEPTION 'Slot taken' USING ERRCODE='23P01'; END IF;
   END IF;
   IF actor.role='PATIENT' AND telecus_integration.visit_cleared(a.id) THEN
     INSERT INTO public.appointment_change_requests(appointment_id,patient_id,request_type,requested_start_time,requested_end_time,reason)
     VALUES(a.id,p_actor,CASE WHEN p_kind='cancel' THEN 'CANCEL' ELSE 'RESCHEDULE' END,
       CASE WHEN p_kind='reschedule' THEN start_at END,CASE WHEN p_kind='reschedule' THEN end_at END,left(COALESCE(p_payload->>'reason','Solicitud del paciente'),300));
     result:='Solicitud pendiente de revisión administrativa. La cita original permanece igual.';
   ELSIF p_kind='reject_change' THEN
     UPDATE public.appointment_change_requests SET status='REJECTED',reviewed_by=p_actor,reviewed_at=now(),decision_note=left(COALESCE(p_payload->>'reason','Solicitud rechazada'),300) WHERE id=change.id;
     result:='Solicitud rechazada. La cita original permanece igual.';
   ELSIF p_kind='complete' THEN
     IF actor.role<>'DOCTOR' OR NOT telecus_integration.visit_cleared(a.id) OR a.status NOT IN ('CONFIRMED','RESCHEDULED') OR a.end_time>now()
     THEN RAISE EXCEPTION 'Cannot complete' USING ERRCODE='22023'; END IF;
     UPDATE public.appointments SET status='COMPLETED',completed_at=now(),completed_by=p_actor WHERE id=a.id RETURNING * INTO a;
     operation:='complete'; result:='Cita '||a.code||' finalizada. Su notificación queda en la cola de correo.';
   ELSIF p_kind='confirm_free' THEN
     IF actor.role<>'ADMIN' OR NOT telecus_integration.is_free_visit(a.id) OR a.status<>'PRE_RESERVED' THEN RAISE EXCEPTION 'Invalid free admission' USING ERRCODE='22023';END IF;
     operation:='confirm';pending_google:=true;
   ELSIF p_kind='verify_payment' THEN
     IF actor.role<>'ADMIN' OR a.payment_status<>'PENDING' OR a.status<>'PRE_RESERVED' OR telecus_integration.is_free_visit(a.id) THEN RAISE EXCEPTION 'Invalid payment state' USING ERRCODE='22023'; END IF;
     operation:='confirm'; pending_google:=true;
   ELSIF p_kind IN ('cancel','reschedule','assign_doctor','approve_change') THEN
     operation:=CASE WHEN p_kind='approve_change' THEN CASE WHEN change.request_type='CANCEL' THEN 'cancel' ELSE 'reschedule' END ELSE p_kind END;
     IF p_kind='assign_doctor' AND actor.role<>'ADMIN' THEN RAISE EXCEPTION 'Admin required' USING ERRCODE='42501'; END IF;
     IF p_kind='approve_change' AND (NOT telecus_integration.visit_cleared(a.id) OR change.patient_id<>a.patient_id) THEN RAISE EXCEPTION 'Invalid request' USING ERRCODE='22023'; END IF;
     pending_google:=telecus_integration.visit_cleared(a.id);
     IF NOT pending_google THEN
       UPDATE public.appointments SET doctor_id=doctor,start_time=start_at,end_time=end_at,
       status=CASE WHEN operation='cancel' THEN 'CANCELLED' WHEN operation='reschedule' THEN 'PRE_RESERVED' ELSE status END
       WHERE id=a.id RETURNING * INTO a;
       operation:=NULL; result:=CASE WHEN p_kind='cancel' THEN 'Pre-reserva '||a.code||' cancelada.' ELSE 'Solicitud gratuita '||a.code||' actualizada. No requiere pago.' END;
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
 payment_status=CASE WHEN d.operation='confirm' AND NOT telecus_integration.is_free_visit(a.id) THEN 'VERIFIED' ELSE payment_status END,
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
CREATE OR REPLACE FUNCTION telecus_integration.staff_snapshot(p_actor uuid,p_kind text,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE who public.profiles;target public.appointments;change public.appointment_change_requests;selected public.profiles;physician_name text;version text;
BEGIN
 who:=telecus_integration.actor(p_actor);
 IF who.role='DOCTOR' AND p_kind<>'complete' OR who.role='ADMIN' AND p_kind NOT IN ('cancel','reschedule','assign_doctor','approve_change','reject_change','confirm_free') OR who.role NOT IN ('ADMIN','DOCTOR') THEN RAISE EXCEPTION 'Forbidden action' USING ERRCODE='42501';END IF;
 IF p_kind IN ('approve_change','reject_change') THEN
  SELECT * INTO change FROM public.appointment_change_requests WHERE id=(p_payload->>'request_id')::uuid FOR UPDATE;
  IF change.id IS NULL OR change.status<>'PENDING' THEN RAISE EXCEPTION 'Request changed' USING ERRCODE='P0002';END IF;
  SELECT * INTO target FROM public.appointments WHERE id=change.appointment_id FOR UPDATE;
 ELSE SELECT * INTO target FROM public.appointments WHERE code=p_payload->>'appointment_code' FOR UPDATE;END IF;
 IF target.id IS NULL OR (who.role='DOCTOR' AND (target.doctor_id<>p_actor OR NOT telecus_integration.visit_cleared(target.id))) THEN RAISE EXCEPTION 'Forbidden appointment' USING ERRCODE='42501';END IF;
 IF target.status IN ('CANCELLED','COMPLETED') THEN RAISE EXCEPTION 'Appointment changed or delivery pending' USING ERRCODE='P0002';END IF;
 IF EXISTS(SELECT 1 FROM telecus_integration.deliveries WHERE appointment_id=target.id AND status<>'done') THEN RAISE EXCEPTION 'Appointment changed or delivery pending' USING ERRCODE='P0002';END IF;
 IF p_kind='complete' AND (target.status NOT IN ('CONFIRMED','RESCHEDULED') OR NOT telecus_integration.visit_cleared(target.id) OR target.end_time>now()) THEN RAISE EXCEPTION 'Cannot complete' USING ERRCODE='22023';END IF;
 IF p_kind='confirm_free' AND (NOT telecus_integration.is_free_visit(target.id) OR target.status<>'PRE_RESERVED' OR target.start_time<=now()) THEN RAISE EXCEPTION 'Invalid free admission' USING ERRCODE='P0002';END IF;
 IF p_kind='assign_doctor' THEN SELECT * INTO selected FROM public.profiles WHERE id=(p_payload->>'doctor_id')::uuid AND active AND role='DOCTOR';IF selected.id IS NULL THEN RAISE EXCEPTION 'Invalid doctor' USING ERRCODE='22023';END IF;END IF;
 IF p_kind='reschedule' THEN PERFORM telecus_integration.interval(p_payload->>'date',p_payload->>'time');END IF;
 SELECT full_name INTO physician_name FROM public.profiles WHERE id=target.doctor_id;
 IF p_kind IN ('reschedule','approve_change') THEN SELECT max(s.version)::text INTO version FROM telecus_integration.service_schedules s;END IF;
 RETURN jsonb_build_object('snapshot',jsonb_build_array(target.id,target.doctor_id,target.start_time,target.end_time,target.status,target.payment_status,change.id,change.status,change.requested_start_time,change.requested_end_time,selected.id,version),
 'details',jsonb_build_object('appointment_code',target.code,'doctor_name',physician_name,'current_start_time',target.start_time,'current_end_time',target.end_time,'requested_start_time',change.requested_start_time,'request_type',change.request_type,'target_doctor_name',selected.full_name,'date',p_payload->>'date','time',p_payload->>'time'));
END $$;
CREATE OR REPLACE FUNCTION telecus_integration.workspace_appointments(p_actor uuid,p_filter jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE who public.profiles;view_name text:=COALESCE(p_filter->>'view','current');offset_n integer:=COALESCE((p_filter->>'offset')::integer,0);result jsonb;
BEGIN
 who:=telecus_integration.actor(p_actor);IF who.role NOT IN ('ADMIN','DOCTOR') THEN RAISE EXCEPTION 'Staff required' USING ERRCODE='42501';END IF;
 IF view_name NOT IN ('current','history','all') OR offset_n NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'Invalid filter' USING ERRCODE='22023';END IF;
 WITH scoped AS (
 SELECT a.id,a.code,a.doctor_id,a.start_time,a.end_time,a.status,CASE WHEN telecus_integration.is_free_visit(a.id) THEN 'NOT_REQUIRED' ELSE a.payment_status::text END AS payment_status,a.meet_url,c.appointment_type,d.full_name AS doctor_name
 FROM public.appointments a JOIN public.profiles d ON d.id=a.doctor_id LEFT JOIN telecus_integration.visit_context c ON c.appointment_id=a.id
 WHERE who.role='ADMIN' OR (a.doctor_id=p_actor AND telecus_integration.visit_cleared(a.id) AND a.status<>'PRE_RESERVED')
 ),filtered AS (
 SELECT * FROM scoped WHERE (view_name='all' OR (view_name='current' AND status NOT IN ('CANCELLED','COMPLETED')) OR (view_name='history' AND status IN ('CANCELLED','COMPLETED')))
 AND position(lower(left(COALESCE(p_filter->>'q',''),80)) IN lower(code||' '||COALESCE(doctor_name,'')))>0
 ),page AS (
 SELECT * FROM filtered ORDER BY CASE WHEN view_name='history' THEN start_time END DESC,start_time,id LIMIT 26 OFFSET offset_n
 ) SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(item ORDER BY n) FROM (
 SELECT jsonb_build_object('id',id,'code',code,'doctor_id',doctor_id,'doctor_name',doctor_name,'start_time',start_time,'end_time',end_time,'status',status,'payment_status',payment_status,'appointment_type',appointment_type)
 ||CASE WHEN who.role='DOCTOR' AND status IN ('CONFIRMED','RESCHEDULED') AND meet_url ~ '^https://meet[.]google[.]com/[a-z0-9-]+$' THEN jsonb_build_object('meet_url',meet_url) ELSE '{}'::jsonb END AS item,n
 FROM (SELECT *,row_number() OVER(ORDER BY CASE WHEN view_name='history' THEN start_time END DESC,start_time,id) AS n FROM page) numbered WHERE n<=25) rows),'[]'),
 'next_offset',CASE WHEN (SELECT count(*) FROM page)>25 THEN offset_n+25 ELSE NULL END,
 'counts',jsonb_build_object('active',(SELECT count(*) FROM scoped WHERE status NOT IN ('CANCELLED','COMPLETED')),'pending_admissions',(SELECT count(*) FROM scoped WHERE status='PRE_RESERVED' AND payment_status='NOT_REQUIRED' AND start_time>now()),'pending_payments',CASE WHEN who.role='ADMIN' THEN (SELECT count(*) FROM scoped WHERE status='PRE_RESERVED' AND payment_status='PENDING' AND start_time>now() AND EXISTS(SELECT 1 FROM telecus_integration.payment_receipts r WHERE r.appointment_id=scoped.id AND r.withdrawn_at IS NULL) AND NOT EXISTS(SELECT 1 FROM telecus_integration.deliveries v WHERE v.appointment_id=scoped.id AND v.status<>'done')) ELSE 0 END,'awaiting_receipt',CASE WHEN who.role='ADMIN' THEN (SELECT count(*) FROM scoped WHERE status='PRE_RESERVED' AND payment_status='PENDING' AND start_time>now() AND NOT EXISTS(SELECT 1 FROM telecus_integration.payment_receipts r WHERE r.appointment_id=scoped.id AND r.withdrawn_at IS NULL) AND NOT EXISTS(SELECT 1 FROM telecus_integration.deliveries v WHERE v.appointment_id=scoped.id AND v.status<>'done')) ELSE 0 END,'pending_requests',CASE WHEN who.role='ADMIN' THEN (SELECT count(*) FROM public.appointment_change_requests WHERE status='PENDING') ELSE 0 END,'to_complete',(SELECT count(*) FROM scoped WHERE status IN ('CONFIRMED','RESCHEDULED') AND payment_status IN ('VERIFIED','NOT_REQUIRED') AND end_time<=now()))) INTO result;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION telecus_integration.administration_read(p_actor uuid,p_resource text,p_filter jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE view_name text:=COALESCE(p_filter->>'view','received');offset_n integer:=COALESCE((p_filter->>'offset')::integer,0);result jsonb;
BEGIN
 PERFORM telecus_integration.admin_actor(p_actor);
 IF p_resource<>'payments' THEN RETURN telecus_integration.admin_read_before006(p_actor,p_resource,p_filter);END IF;
 IF view_name NOT IN ('received','awaiting','processing') OR offset_n NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'Invalid payment view' USING ERRCODE='22023';END IF;
 WITH scoped AS (
 SELECT a.id,a.code,a.start_time,p.full_name AS patient_name,d.full_name AS doctor_name,r.id AS receipt_id,r.file_name,r.content_type,r.size,r.created_at,
 EXISTS(SELECT 1 FROM telecus_integration.deliveries v WHERE v.appointment_id=a.id AND v.status<>'done') AS processing
 FROM public.appointments a JOIN public.profiles p ON p.id=a.patient_id JOIN public.profiles d ON d.id=a.doctor_id
 LEFT JOIN telecus_integration.payment_receipts r ON r.appointment_id=a.id AND r.withdrawn_at IS NULL
 WHERE a.status='PRE_RESERVED' AND a.payment_status='PENDING' AND NOT telecus_integration.is_free_visit(a.id) AND a.start_time>now()
 ),filtered AS (
 SELECT * FROM scoped WHERE (view_name='processing' AND processing) OR (NOT processing AND ((view_name='received' AND receipt_id IS NOT NULL) OR (view_name='awaiting' AND receipt_id IS NULL)))
 ),page AS (SELECT *,row_number() OVER(ORDER BY start_time,id) AS n FROM filtered ORDER BY start_time,id LIMIT 26 OFFSET offset_n)
 SELECT jsonb_build_object('view',view_name,'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('appointment_id',id,'code',code,'patient_name',patient_name,'doctor_name',doctor_name,'start_time',start_time,'processing',processing,
 'receipt',CASE WHEN receipt_id IS NULL THEN NULL ELSE jsonb_build_object('id',receipt_id,'file_name',file_name,'content_type',content_type,'size',size,'created_at',created_at) END)||COALESCE(telecus_integration.hold_info(id),'{}') ORDER BY start_time,id) FROM page WHERE n<=offset_n+25),'[]'),
 'next_offset',CASE WHEN (SELECT count(*) FROM page)>25 THEN offset_n+25 ELSE NULL END) INTO result;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION telecus_integration.payment_review_snapshot(p_appointment uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public.appointments;r telecus_integration.payment_receipts;patient_name text;doctor_name text;
BEGIN
 SELECT * INTO a FROM public.appointments WHERE id=p_appointment FOR UPDATE;
 IF a.id IS NULL OR telecus_integration.is_free_visit(a.id) OR a.status<>'PRE_RESERVED' OR a.payment_status<>'PENDING' OR a.start_time<=now()
 OR EXISTS(SELECT 1 FROM telecus_integration.deliveries WHERE appointment_id=a.id AND status<>'done')
 THEN RAISE EXCEPTION 'Payment no longer reviewable' USING ERRCODE='P0002';END IF;
 SELECT * INTO r FROM telecus_integration.payment_receipts WHERE appointment_id=a.id AND withdrawn_at IS NULL;
 SELECT full_name INTO patient_name FROM public.profiles WHERE id=a.patient_id;
 SELECT full_name INTO doctor_name FROM public.profiles WHERE id=a.doctor_id;
 RETURN jsonb_build_object('appointment',jsonb_build_object('id',a.id,'code',a.code,'patient_name',patient_name,'doctor_name',doctor_name,'start_time',a.start_time),
  'receipt',CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('id',r.id,'file_name',r.file_name,'content_type',r.content_type,'size',r.size,'created_at',r.created_at) END,
  'snapshot',jsonb_build_array(a.doctor_id,a.start_time,a.end_time,r.id));
END $$;
CREATE OR REPLACE FUNCTION telecus_integration.list_receipts_before006(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles; items jsonb;
BEGIN
 actor:=telecus_integration.actor(p_actor);
 IF actor.role NOT IN ('PATIENT','ADMIN') THEN RAISE EXCEPTION 'Forbidden receipt access' USING ERRCODE='42501'; END IF;
 SELECT COALESCE(jsonb_agg(x.item ORDER BY x.start_time),'[]'::jsonb) INTO items FROM (
  SELECT a.start_time,jsonb_build_object('appointment_id',a.id,'code',a.code,'doctor_name',COALESCE(p.full_name,'Médico TeleCUS'),
   'start_time',a.start_time,'status',a.status,'payment_status',a.payment_status,'processing',d.processing,
   'can_pay',actor.role='PATIENT' AND NOT d.processing AND r.id IS NULL,
   'can_upload',actor.role='PATIENT' AND NOT d.processing AND r.id IS NULL,
   'can_withdraw',actor.role='PATIENT' AND NOT d.processing AND r.id IS NOT NULL,
   'receipt',CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('id',r.id,'file_name',r.file_name,'content_type',r.content_type,'size',r.size,'created_at',r.created_at) END) AS item
  FROM public.appointments a JOIN public.profiles p ON p.id=a.doctor_id
  LEFT JOIN telecus_integration.payment_receipts r ON r.appointment_id=a.id AND r.withdrawn_at IS NULL
  CROSS JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM telecus_integration.deliveries v WHERE v.appointment_id=a.id AND v.status<>'done' AND v.operation='confirm') AS processing) d
  WHERE a.status='PRE_RESERVED' AND a.payment_status='PENDING' AND NOT telecus_integration.is_free_visit(a.id) AND a.start_time>now() AND ((actor.role='ADMIN' AND r.id IS NOT NULL) OR (actor.role='PATIENT' AND a.patient_id=p_actor))
  ORDER BY a.start_time LIMIT 100
 ) x;
 RETURN jsonb_build_object('items',items,'receiptsAvailable',true);
END $$;
CREATE OR REPLACE FUNCTION telecus_integration.expire_holds() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE entry public.appointments;n integer:=0;
BEGIN
 FOR entry IN SELECT a.* FROM public.appointments a JOIN telecus_integration.reservation_holds h ON h.appointment_id=a.id
 WHERE h.expired_at IS NULL AND h.expires_at<=now() AND a.status='PRE_RESERVED' AND a.payment_status='PENDING' AND NOT telecus_integration.is_free_visit(a.id)
 AND NOT EXISTS(SELECT 1 FROM telecus_integration.payment_receipts r WHERE r.appointment_id=a.id AND r.withdrawn_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM telecus_integration.deliveries d WHERE d.appointment_id=a.id AND d.status<>'done')
 ORDER BY h.expires_at,a.id LIMIT 100 FOR UPDATE OF a SKIP LOCKED LOOP
  UPDATE telecus_integration.reservation_holds SET expired_at=now() WHERE appointment_id=entry.id;
  UPDATE public.appointments SET status='CANCELLED' WHERE id=entry.id;
  INSERT INTO public.appointment_logs(appointment_id,action,details) VALUES(entry.id,'PRE_RESERVATION_EXPIRED',jsonb_build_object('source','telecus','reason','no_receipt_before_deadline'));
  n:=n+1;
 END LOOP;
 RETURN n;
END $$;
CREATE OR REPLACE FUNCTION telecus_integration.publish_notification(p_key text,p_type text,p_appointment uuid,p_request uuid DEFAULT NULL,p_doctor uuid DEFAULT NULL,p_only_doctor boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public.appointments; r public.appointment_change_requests; event_id bigint; data jsonb;
BEGIN
 SELECT * INTO a FROM public.appointments WHERE id=p_appointment;
 IF a.id IS NULL THEN RETURN; END IF;
 IF p_request IS NOT NULL THEN SELECT * INTO r FROM public.appointment_change_requests WHERE id=p_request; END IF;
 -- No reason, patient names, email addresses, Meet links or clinical data in the inbox.
 data:=jsonb_build_object('code',a.code,'start_time',a.start_time,'request_type',r.request_type,'payment_required',NOT telecus_integration.is_free_visit(a.id),'reason',CASE WHEN EXISTS(SELECT 1 FROM telecus_integration.reservation_holds h WHERE h.appointment_id=a.id AND h.expired_at IS NOT NULL) THEN 'reservation_expired' END);
 INSERT INTO telecus_integration.notification_events(event_key,event_type,payload) VALUES(p_key,p_type,data)
 ON CONFLICT(event_key) DO NOTHING RETURNING id INTO event_id;
 IF event_id IS NULL THEN RETURN; END IF;
 INSERT INTO telecus_integration.notifications(event_id,recipient_id,recipient_role)
 SELECT event_id,p.id,p.role FROM public.profiles p WHERE p.active AND
 ((NOT p_only_doctor AND (p.role='ADMIN' OR (p.role='PATIENT' AND p.id=a.patient_id)))
 OR (p.role='DOCTOR' AND p.id=p_doctor)) ON CONFLICT DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION telecus_integration.appointment_notification_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE kind text; physician uuid; key text:=pg_catalog.gen_random_uuid()::text;
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.payment_status='PENDING' AND NEW.status='PRE_RESERVED' THEN kind:='appointment_requested';
   ELSIF (NEW.payment_status='VERIFIED' OR telecus_integration.is_free_visit(NEW.id)) AND NEW.status IN ('CONFIRMED','RESCHEDULED') THEN kind:='appointment_confirmed'; END IF;
 ELSE
   IF NEW.status='CANCELLED' AND OLD.status IS DISTINCT FROM NEW.status THEN kind:='appointment_cancelled';
   ELSIF NEW.status='COMPLETED' AND OLD.status IS DISTINCT FROM NEW.status THEN kind:='appointment_completed';
   ELSIF (NEW.payment_status='VERIFIED' OR telecus_integration.is_free_visit(NEW.id)) AND NEW.status IN ('CONFIRMED','RESCHEDULED') THEN
     IF OLD.payment_status IS DISTINCT FROM NEW.payment_status OR (OLD.status IS DISTINCT FROM NEW.status AND NEW.status='CONFIRMED') THEN kind:='appointment_confirmed';
     ELSIF OLD.start_time IS DISTINCT FROM NEW.start_time OR OLD.end_time IS DISTINCT FROM NEW.end_time THEN kind:='appointment_rescheduled';
     ELSIF OLD.doctor_id IS DISTINCT FROM NEW.doctor_id THEN kind:='doctor_assigned'; END IF;
   END IF;
   IF OLD.doctor_id IS DISTINCT FROM NEW.doctor_id AND (OLD.payment_status='VERIFIED' OR telecus_integration.is_free_visit(OLD.id)) AND OLD.status IN ('CONFIRMED','RESCHEDULED') THEN
     PERFORM telecus_integration.publish_notification(key||':removed','appointment_unassigned',NEW.id,NULL,OLD.doctor_id,true);
   END IF;
 END IF;
 IF kind IS NOT NULL THEN
   IF NEW.payment_status='VERIFIED' OR (telecus_integration.is_free_visit(NEW.id) AND NEW.status IN ('CONFIRMED','RESCHEDULED','COMPLETED')) THEN physician:=NEW.doctor_id; END IF;
   PERFORM telecus_integration.publish_notification(key,kind,NEW.id,NULL,physician);
 END IF;
 RETURN NEW;
END $$;
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
