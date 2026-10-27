-- Additive, private evidence metadata. Encrypted file bytes remain in backend private storage.
-- Original public tables, policies and data are preserved.
-- A receipt is evidence awaiting ADMIN review, never an automatic payment verification.
CREATE TABLE IF NOT EXISTS telecus_integration.payment_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),appointment_id uuid NOT NULL UNIQUE REFERENCES public.appointments(id),
 patient_id uuid NOT NULL REFERENCES public.profiles(id),request_id uuid NOT NULL,
 file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 120),
 content_type text NOT NULL CHECK(content_type IN ('application/pdf','image/jpeg','image/png')),
 size integer NOT NULL CHECK(size BETWEEN 1 AND 5242880),sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 storage_key text NOT NULL UNIQUE CHECK(storage_key ~ '^[0-9a-f]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(patient_id,request_id)
);
REVOKE ALL ON telecus_integration.payment_receipts FROM PUBLIC,anon,authenticated,service_role,telecus_backend;

ALTER TABLE telecus_integration.notification_events DROP CONSTRAINT IF EXISTS notification_events_event_type_check;
ALTER TABLE telecus_integration.notification_events ADD CONSTRAINT notification_events_event_type_check CHECK(event_type IN (
 'appointment_requested','appointment_confirmed','appointment_rescheduled','appointment_cancelled','appointment_completed',
 'doctor_assigned','appointment_unassigned','change_requested','change_approved','change_rejected','integration_attention','payment_receipt_received'));

CREATE OR REPLACE FUNCTION telecus_integration.payment_receipts_version() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 1 $$;

CREATE OR REPLACE FUNCTION telecus_integration.list_payment_receipts(p_actor uuid) RETURNS jsonb
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
   'receipt',CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('id',r.id,'file_name',r.file_name,'content_type',r.content_type,'size',r.size,'created_at',r.created_at) END) AS item
  FROM public.appointments a JOIN public.profiles p ON p.id=a.doctor_id
  LEFT JOIN telecus_integration.payment_receipts r ON r.appointment_id=a.id
  CROSS JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM telecus_integration.deliveries v WHERE v.appointment_id=a.id AND v.status<>'done' AND v.operation='confirm') AS processing) d
  WHERE a.status='PRE_RESERVED' AND a.payment_status='PENDING' AND a.start_time>now() AND ((actor.role='ADMIN' AND r.id IS NOT NULL) OR (actor.role='PATIENT' AND a.patient_id=p_actor))
  ORDER BY a.start_time LIMIT 100
 ) x;
 RETURN jsonb_build_object('items',items,'receiptsAvailable',true);
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.upload_payment_receipt(p_actor uuid,p_appointment uuid,p_request uuid,p_file jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles; a public.appointments; previous telecus_integration.payment_receipts; r telecus_integration.payment_receipts;
 file_size integer; mime text; name text; digest text; blob_key text; expected_key text;
BEGIN
 actor:=telecus_integration.actor(p_actor);
 IF actor.role<>'PATIENT' THEN RAISE EXCEPTION 'Patient required' USING ERRCODE='42501'; END IF;
 IF p_appointment IS NULL OR p_request IS NULL OR p_file IS NULL OR jsonb_typeof(p_file)<>'object'
 OR jsonb_typeof(p_file->'size') IS DISTINCT FROM 'number'
 OR COALESCE(p_file->>'size','') !~ '^[1-9][0-9]{0,6}$'
 OR COALESCE(p_file->>'sha256','') !~ '^[0-9a-f]{64}$'
 OR COALESCE(p_file->>'storage_key','') !~ '^[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'Invalid receipt' USING ERRCODE='22023'; END IF;
 file_size:=(p_file->>'size')::integer;mime:=p_file->>'content_type';name:=p_file->>'file_name';digest:=p_file->>'sha256';blob_key:=p_file->>'storage_key';
 IF file_size NOT BETWEEN 1 AND 5242880 OR mime NOT IN ('application/pdf','image/jpeg','image/png')
 OR name IS NULL OR length(name) NOT BETWEEN 1 AND 120 OR name ~ '[[:cntrl:]/\\]' OR name ~ '^[. ]' OR name ~ '[. ]$'
 OR (mime='application/pdf' AND name !~ '\.pdf$') OR (mime='image/jpeg' AND name !~ '\.jpg$') OR (mime='image/png' AND name !~ '\.png$')
 THEN RAISE EXCEPTION 'Invalid receipt metadata' USING ERRCODE='22023'; END IF;
 -- Files are validated and encrypted by the authenticated backend before this metadata call.
 -- Bind the opaque blob key to the patient, appointment and declared digest independently here.
 expected_key:=encode(sha256(convert_to(p_actor::text,'UTF8')||decode('00','hex')||convert_to(p_appointment::text,'UTF8')||decode('00','hex')||convert_to(digest,'UTF8')),'hex');
 IF blob_key<>expected_key THEN RAISE EXCEPTION 'Invalid receipt storage reference' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('telecus-receipt-request:'||p_actor||':'||p_request,0));
 SELECT * INTO previous FROM telecus_integration.payment_receipts WHERE patient_id=p_actor AND request_id=p_request;
 IF previous.id IS NOT NULL THEN
  IF previous.appointment_id<>p_appointment OR previous.sha256<>digest OR previous.file_name<>name OR previous.content_type<>mime OR previous.size<>file_size OR previous.storage_key<>blob_key
  THEN RAISE EXCEPTION 'Receipt request mismatch' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('id',previous.id,'file_name',previous.file_name,'content_type',previous.content_type,'size',previous.size,'created_at',previous.created_at);
 END IF;
 SELECT * INTO a FROM public.appointments WHERE id=p_appointment FOR UPDATE;
 IF a.id IS NULL OR a.patient_id<>p_actor THEN RAISE EXCEPTION 'Forbidden appointment' USING ERRCODE='42501'; END IF;
 IF a.status<>'PRE_RESERVED' OR a.payment_status<>'PENDING' OR a.start_time<=now()
 OR EXISTS(SELECT 1 FROM telecus_integration.deliveries WHERE appointment_id=a.id AND status<>'done' AND operation='confirm')
 THEN RAISE EXCEPTION 'Appointment does not accept receipts' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM telecus_integration.payment_receipts WHERE appointment_id=a.id) THEN RAISE EXCEPTION 'Receipt already received' USING ERRCODE='23505'; END IF;
 INSERT INTO telecus_integration.payment_receipts(appointment_id,patient_id,request_id,file_name,content_type,size,sha256,storage_key)
 VALUES(a.id,p_actor,p_request,name,mime,file_size,digest,blob_key) RETURNING * INTO r;
 PERFORM telecus_integration.publish_notification('payment-receipt:'||r.id,'payment_receipt_received',a.id);
 RETURN jsonb_build_object('id',r.id,'file_name',r.file_name,'content_type',r.content_type,'size',r.size,'created_at',r.created_at);
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.download_payment_receipt(p_actor uuid,p_receipt uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles; r telecus_integration.payment_receipts;
BEGIN
 actor:=telecus_integration.actor(p_actor);
 IF actor.role NOT IN ('PATIENT','ADMIN') THEN RAISE EXCEPTION 'Forbidden receipt access' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM telecus_integration.payment_receipts WHERE id=p_receipt AND (actor.role='ADMIN' OR patient_id=p_actor);
 IF r.id IS NULL THEN RAISE EXCEPTION 'Receipt not found within access' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('id',r.id,'file_name',r.file_name,'content_type',r.content_type,'size',r.size,'created_at',r.created_at,'storage_key',r.storage_key,'sha256',r.sha256);
END $$;
REVOKE ALL ON FUNCTION telecus_integration.payment_receipts_version(),telecus_integration.list_payment_receipts(uuid),telecus_integration.upload_payment_receipt(uuid,uuid,uuid,jsonb),telecus_integration.download_payment_receipt(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION telecus_integration.payment_receipts_version(),telecus_integration.list_payment_receipts(uuid),telecus_integration.upload_payment_receipt(uuid,uuid,uuid,jsonb),telecus_integration.download_payment_receipt(uuid,uuid) TO telecus_backend;
