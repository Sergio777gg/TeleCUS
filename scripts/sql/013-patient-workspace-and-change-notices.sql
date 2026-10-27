-- 013: scoped patient agenda and one administrative notice when a cancellation applies a pending request.
-- Public schema and RLS retained; no retrospective cleanup of appointments or notices.
CREATE OR REPLACE FUNCTION telecus_integration.clinical_documents(p_actor uuid,p_action text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE who public.profiles;a public.appointments;d telecus_integration.clinical_documents;old telecus_integration.clinical_documents;result jsonb;event_id bigint;
BEGIN
 who:=telecus_integration.actor(p_actor);
 IF who.role NOT IN ('PATIENT','DOCTOR') THEN RAISE EXCEPTION 'Private clinical files' USING ERRCODE='42501';END IF;
 IF p_action='list' THEN
  SELECT jsonb_build_object('items',COALESCE(jsonb_agg(item ORDER BY start_time DESC,id),'[]')) INTO result FROM (
   SELECT appointment_row.start_time,appointment_row.id,jsonb_build_object('id',appointment_row.id,'code',appointment_row.code,'start_time',appointment_row.start_time,'doctor_name',p.full_name,'status',appointment_row.status,'appointment_type',c.appointment_type,
    'can_upload',who.role='PATIENT' AND appointment_row.status NOT IN ('CANCELLED','COMPLETED') AND appointment_row.start_time>now(),
    'documents',(SELECT COALESCE(jsonb_agg(telecus_integration.clinical_file_public(f) ORDER BY f.created_at),'[]') FROM telecus_integration.clinical_documents f WHERE f.appointment_id=appointment_row.id AND f.status<>'WITHDRAWN')) AS item
   FROM public.appointments appointment_row JOIN public.profiles p ON p.id=appointment_row.doctor_id LEFT JOIN telecus_integration.visit_context c ON c.appointment_id=appointment_row.id
   WHERE (who.role='PATIENT' AND appointment_row.patient_id=p_actor OR who.role='DOCTOR' AND appointment_row.doctor_id=p_actor) AND (p_input->>'appointment_id' IS NULL OR appointment_row.id=(p_input->>'appointment_id')::uuid) ORDER BY appointment_row.start_time DESC,appointment_row.id LIMIT 100) page;
  RETURN result;
 END IF;
 IF p_action NOT IN ('prepare','commit','download','withdraw','review') THEN RAISE EXCEPTION 'Invalid document action' USING ERRCODE='22023';END IF;
 IF p_input?'id' THEN SELECT * INTO d FROM telecus_integration.clinical_documents WHERE id=(p_input->>'id')::uuid;END IF;
 SELECT * INTO a FROM public.appointments WHERE id=COALESCE(d.appointment_id,(p_input->>'appointment_id')::uuid) FOR UPDATE;
 IF a.id IS NULL OR p_input?'id' AND d.id IS NULL OR NOT (who.role='PATIENT' AND a.patient_id=p_actor OR who.role='DOCTOR' AND a.doctor_id=p_actor) THEN RAISE EXCEPTION 'Forbidden clinical file' USING ERRCODE='42501';END IF;
 IF p_input?'id' THEN SELECT * INTO d FROM telecus_integration.clinical_documents WHERE id=d.id FOR UPDATE;END IF;
 IF p_action='download' THEN
  IF d.id IS NULL OR d.status='WITHDRAWN' THEN RAISE EXCEPTION 'Document withdrawn' USING ERRCODE='P0002';END IF;
  INSERT INTO telecus_integration.clinical_document_audit(document_id,actor_id,action,version) VALUES(d.id,p_actor,'download',d.version);
  RETURN jsonb_build_object('content_type',d.content_type,'sha256',d.sha256,'storage_key',d.storage_key);
 END IF;
 IF a.status IN ('CANCELLED','COMPLETED') OR a.start_time<=now() THEN RAISE EXCEPTION 'Appointment no longer editable' USING ERRCODE='P0002';END IF;
 IF p_action IN ('prepare','commit','withdraw') AND who.role<>'PATIENT' OR p_action='review' AND who.role<>'DOCTOR' THEN RAISE EXCEPTION 'Forbidden clinical action' USING ERRCODE='42501';END IF;
 IF p_action='prepare' THEN
  SELECT * INTO old FROM telecus_integration.clinical_documents WHERE request_id=(p_input->>'request_id')::uuid;
  IF old.id IS NOT NULL AND (old.patient_id<>p_actor OR old.appointment_id<>a.id OR old.sha256 IS DISTINCT FROM p_input->>'sha256' OR old.file_name IS DISTINCT FROM p_input->>'file_name' OR old.status='WITHDRAWN') THEN RAISE EXCEPTION 'Document upload changed' USING ERRCODE='23505';END IF;
  IF old.id IS NULL AND ((SELECT count(*) FROM telecus_integration.clinical_documents WHERE appointment_id=a.id)>=100 OR (SELECT count(*) FROM telecus_integration.clinical_documents WHERE appointment_id=a.id AND status<>'WITHDRAWN')>=10) THEN RAISE EXCEPTION 'Document limit' USING ERRCODE='P0002';END IF;
  RETURN jsonb_build_object('allowed',true);
 END IF;
 IF p_action='commit' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('clinical-upload:'||(p_input->>'request_id'),0));
  SELECT * INTO old FROM telecus_integration.clinical_documents WHERE request_id=(p_input->>'request_id')::uuid;
  IF old.id IS NOT NULL THEN
   IF old.patient_id<>p_actor OR old.appointment_id<>a.id OR old.sha256 IS DISTINCT FROM p_input->>'sha256' OR old.storage_key IS DISTINCT FROM p_input->>'storage_key' OR old.file_name IS DISTINCT FROM p_input->>'file_name' OR old.status='WITHDRAWN' THEN RAISE EXCEPTION 'Document upload changed' USING ERRCODE='23505';END IF;
   RETURN telecus_integration.clinical_file_public(old);
  END IF;
  IF (SELECT count(*) FROM telecus_integration.clinical_documents WHERE appointment_id=a.id)>=100 OR (SELECT count(*) FROM telecus_integration.clinical_documents WHERE appointment_id=a.id AND status<>'WITHDRAWN')>=10 THEN RAISE EXCEPTION 'Document limit' USING ERRCODE='P0002';END IF;
  INSERT INTO telecus_integration.clinical_documents(appointment_id,patient_id,request_id,file_name,content_type,size,sha256,storage_key)
  VALUES(a.id,p_actor,(p_input->>'request_id')::uuid,p_input->>'file_name',p_input->>'content_type',(p_input->>'size')::integer,p_input->>'sha256',p_input->>'storage_key') RETURNING * INTO d;
 ELSIF p_action='withdraw' THEN
  IF d.status='WITHDRAWN' THEN RETURN jsonb_build_object('withdrawn',true);END IF;
  UPDATE telecus_integration.clinical_documents SET status='WITHDRAWN',withdrawn_at=now(),version=version+1 WHERE id=d.id RETURNING * INTO d;
 ELSIF p_action='review' THEN
  IF d.status='WITHDRAWN' OR d.version IS DISTINCT FROM (p_input->>'version')::integer THEN RAISE EXCEPTION 'Document changed' USING ERRCODE='P0002';END IF;
  IF p_input->>'status' NOT IN ('LEGIBLE','CORRECTION_REQUESTED') OR p_input->>'status' IS NULL THEN RAISE EXCEPTION 'Invalid review' USING ERRCODE='22023';END IF;
  UPDATE telecus_integration.clinical_documents SET status=p_input->>'status',reviewed_by=p_actor,reviewed_at=now(),version=version+1 WHERE id=d.id RETURNING * INTO d;
 END IF;
 IF d.id IS NULL THEN RAISE EXCEPTION 'Document required' USING ERRCODE='22023';END IF;
 INSERT INTO telecus_integration.clinical_document_audit(document_id,actor_id,action,version) VALUES(d.id,p_actor,p_action,d.version);
 -- Deliberately generic: no result, filename, type of exam or reason in an inbox.
 INSERT INTO telecus_integration.notification_events(event_key,event_type,payload) VALUES('clinical:'||d.id||':'||d.version,'clinical_documents_updated',jsonb_build_object('code',a.code)) RETURNING id INTO event_id;
 INSERT INTO telecus_integration.notifications(event_id,recipient_id,recipient_role) SELECT event_id,p.id,p.role FROM public.profiles p WHERE p.active AND (p.role='PATIENT' AND p.id=a.patient_id OR p.role='DOCTOR' AND p.id=a.doctor_id);
 RETURN CASE WHEN p_action='withdraw' THEN jsonb_build_object('withdrawn',true) ELSE telecus_integration.clinical_file_public(d) END;
END $$;
CREATE FUNCTION telecus_integration.patient_workspace_version() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 1 $$;
CREATE FUNCTION telecus_integration.patient_workspace(p_actor uuid,p_code text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE who public.profiles;result jsonb;
BEGIN
 who:=telecus_integration.actor(p_actor);IF who.role<>'PATIENT' THEN RAISE EXCEPTION 'Patient required' USING ERRCODE='42501';END IF;
 IF p_code IS NOT NULL AND p_code !~ '^TCUS-[A-Z0-9-]{1,65}$' THEN RAISE EXCEPTION 'Invalid appointment reference' USING ERRCODE='22023';END IF;
 SELECT jsonb_build_object('items',COALESCE(jsonb_agg(item ORDER BY start_time,id),'[]')) INTO result FROM (
  SELECT ap.start_time,ap.id,jsonb_build_object('id',ap.id,'code',ap.code,'start_time',ap.start_time,'end_time',ap.end_time,'status',ap.status,
   'payment_status',CASE WHEN telecus_integration.is_free_visit(ap.id) THEN 'NOT_REQUIRED' ELSE ap.payment_status::text END,
   'payment_required',NOT telecus_integration.is_free_visit(ap.id),'doctor_name',d.full_name,'appointment_type',v.appointment_type,
   'can_documents',ap.status NOT IN ('CANCELLED','COMPLETED'),
   'meet_url',CASE WHEN ap.status IN ('CONFIRMED','RESCHEDULED') AND ap.meet_url ~ '^https://meet[.]google[.]com/[a-z0-9-]+$' THEN ap.meet_url END
  ) AS item FROM public.appointments ap JOIN public.profiles d ON d.id=ap.doctor_id LEFT JOIN telecus_integration.visit_context v ON v.appointment_id=ap.id
  WHERE ap.patient_id=p_actor AND (p_code IS NOT NULL AND ap.code=p_code OR p_code IS NULL AND ap.status NOT IN ('CANCELLED','COMPLETED'))
  ORDER BY ap.start_time,ap.id LIMIT 20
 ) page;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION telecus_integration.patient_workspace_version(),telecus_integration.patient_workspace(uuid,text) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
GRANT EXECUTE ON FUNCTION telecus_integration.patient_workspace_version(),telecus_integration.patient_workspace(uuid,text) TO telecus_backend;
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
 ((NOT p_only_doctor AND ((p.role='ADMIN' AND NOT (p_type='appointment_cancelled' AND EXISTS(SELECT 1 FROM public.appointment_change_requests pending WHERE pending.appointment_id=a.id AND pending.request_type='CANCEL' AND pending.status='PENDING'))) OR (p.role='PATIENT' AND p.id=a.patient_id)))
 OR (p.role='DOCTOR' AND p.id=p_doctor)) ON CONFLICT DO NOTHING;
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
 IF d.operation='cancel' THEN UPDATE public.appointment_change_requests SET status=CASE WHEN request_type='CANCEL' THEN 'APPROVED' ELSE 'REJECTED' END,reviewed_by=d.actor_id,reviewed_at=now(),decision_note=CASE WHEN request_type='CANCEL' THEN 'Cancelación aplicada por el administrativo' ELSE 'Cita cancelada por el administrativo' END WHERE appointment_id=a.id AND status='PENDING'; END IF;
 INSERT INTO public.appointment_logs(appointment_id,actor_user_id,action,details)
 VALUES(a.id,d.actor_id,d.operation||'_CALENDAR_CONFIRMED',jsonb_build_object('operation_id',d.operation_id,'source','telecus'));
 UPDATE telecus_integration.deliveries SET stage='mail',status='queued',attempts=0,lease_until=NULL,lease_token=NULL,last_error=NULL,
 appointment=appointment||jsonb_build_object('meet_url',a.meet_url,'calendar_event_id',a.calendar_event_id),updated_at=now() WHERE id=d.id;
 RETURN true;
END $$;
