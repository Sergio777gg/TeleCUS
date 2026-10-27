-- Metadata in Supabase; encrypted file bodies stay in the private application volume.
CREATE TABLE telecus_integration.clinical_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),appointment_id uuid NOT NULL REFERENCES public.appointments(id),
 patient_id uuid NOT NULL REFERENCES public.profiles(id),request_id uuid NOT NULL UNIQUE,
 file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 120),content_type text NOT NULL CHECK(content_type IN ('application/pdf','image/png','image/jpeg')),
 size integer NOT NULL CHECK(size BETWEEN 1 AND 5242880),sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),storage_key text NOT NULL CHECK(storage_key ~ '^[0-9a-f]{64}$'),
 status text NOT NULL DEFAULT 'RECEIVED' CHECK(status IN ('RECEIVED','LEGIBLE','CORRECTION_REQUESTED','WITHDRAWN')),version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),reviewed_by uuid REFERENCES public.profiles(id),reviewed_at timestamptz,withdrawn_at timestamptz
);
CREATE INDEX ON telecus_integration.clinical_documents(appointment_id,created_at) WHERE status<>'WITHDRAWN';
CREATE TABLE telecus_integration.clinical_document_audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,document_id uuid NOT NULL REFERENCES telecus_integration.clinical_documents(id),actor_id uuid NOT NULL REFERENCES public.profiles(id),action text NOT NULL,version integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON telecus_integration.clinical_documents,telecus_integration.clinical_document_audit FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
REVOKE ALL ON SEQUENCE telecus_integration.clinical_document_audit_id_seq FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
ALTER TABLE telecus_integration.notification_events DROP CONSTRAINT notification_events_event_type_check;
ALTER TABLE telecus_integration.notification_events ADD CONSTRAINT notification_events_event_type_check CHECK(event_type IN ('appointment_requested','appointment_confirmed','appointment_rescheduled','appointment_cancelled','appointment_completed','doctor_assigned','appointment_unassigned','change_requested','change_approved','change_rejected','integration_attention','payment_receipt_received','payment_receipt_withdrawn','clinical_documents_updated'));
CREATE FUNCTION telecus_integration.clinical_documents_version() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 1 $$;
CREATE FUNCTION telecus_integration.clinical_file_public(d telecus_integration.clinical_documents) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('id',d.id,'file_name',d.file_name,'content_type',d.content_type,'size',d.size,'status',d.status,'version',d.version,'created_at',d.created_at) $$;
CREATE FUNCTION telecus_integration.clinical_documents(p_actor uuid,p_action text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE who public.profiles;a public.appointments;d telecus_integration.clinical_documents;old telecus_integration.clinical_documents;result jsonb;event_id bigint;
BEGIN
 who:=telecus_integration.actor(p_actor);
 IF who.role NOT IN ('PATIENT','DOCTOR') THEN RAISE EXCEPTION 'Private clinical files' USING ERRCODE='42501';END IF;
 IF p_action='list' THEN
  SELECT jsonb_build_object('items',COALESCE(jsonb_agg(item ORDER BY start_time DESC,id),'[]')) INTO result FROM (
   SELECT a.start_time,a.id,jsonb_build_object('id',a.id,'code',a.code,'start_time',a.start_time,'doctor_name',p.full_name,'status',a.status,'appointment_type',c.appointment_type,
    'can_upload',who.role='PATIENT' AND a.status NOT IN ('CANCELLED','COMPLETED') AND a.start_time>now(),
    'documents',(SELECT COALESCE(jsonb_agg(telecus_integration.clinical_file_public(f) ORDER BY f.created_at),'[]') FROM telecus_integration.clinical_documents f WHERE f.appointment_id=a.id AND f.status<>'WITHDRAWN')) AS item
   FROM public.appointments a JOIN public.profiles p ON p.id=a.doctor_id LEFT JOIN telecus_integration.visit_context c ON c.appointment_id=a.id
   WHERE (who.role='PATIENT' AND a.patient_id=p_actor OR who.role='DOCTOR' AND a.doctor_id=p_actor) ORDER BY a.start_time DESC,a.id LIMIT 100) page;
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
REVOKE ALL ON FUNCTION telecus_integration.clinical_documents_version(),telecus_integration.clinical_file_public(telecus_integration.clinical_documents),telecus_integration.clinical_documents(uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
GRANT EXECUTE ON FUNCTION telecus_integration.clinical_documents_version(),telecus_integration.clinical_documents(uuid,text,jsonb) TO telecus_backend;
