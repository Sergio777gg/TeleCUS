-- 005: receipt revisions and direct administration. Original public schema/RLS preserved.
ALTER TABLE telecus_integration.payment_receipts ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz;
ALTER TABLE telecus_integration.payment_receipts ADD COLUMN IF NOT EXISTS withdrawn_by uuid REFERENCES public.profiles(id);
ALTER TABLE telecus_integration.payment_receipts ADD COLUMN IF NOT EXISTS withdrawal_request uuid;
ALTER TABLE telecus_integration.payment_receipts DROP CONSTRAINT IF EXISTS payment_receipts_appointment_id_key;
ALTER TABLE telecus_integration.payment_receipts DROP CONSTRAINT IF EXISTS payment_receipts_storage_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS payment_receipts_active ON telecus_integration.payment_receipts(appointment_id) WHERE withdrawn_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_receipts_withdrawal ON telecus_integration.payment_receipts(patient_id,withdrawal_request) WHERE withdrawal_request IS NOT NULL;
CREATE OR REPLACE FUNCTION telecus_integration.payment_receipts_version() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 2 $$;
ALTER TABLE telecus_integration.notification_events DROP CONSTRAINT IF EXISTS notification_events_event_type_check;
ALTER TABLE telecus_integration.notification_events ADD CONSTRAINT notification_events_event_type_check CHECK(event_type IN (
 'appointment_requested','appointment_confirmed','appointment_rescheduled','appointment_cancelled','appointment_completed','doctor_assigned','appointment_unassigned','change_requested','change_approved','change_rejected','integration_attention','payment_receipt_received','payment_receipt_withdrawn'));

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
   'can_withdraw',actor.role='PATIENT' AND NOT d.processing AND r.id IS NOT NULL,
   'receipt',CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('id',r.id,'file_name',r.file_name,'content_type',r.content_type,'size',r.size,'created_at',r.created_at) END) AS item
  FROM public.appointments a JOIN public.profiles p ON p.id=a.doctor_id
  LEFT JOIN telecus_integration.payment_receipts r ON r.appointment_id=a.id AND r.withdrawn_at IS NULL
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
  IF previous.withdrawn_at IS NOT NULL OR previous.appointment_id<>p_appointment OR previous.sha256<>digest OR previous.file_name<>name OR previous.content_type<>mime OR previous.size<>file_size OR previous.storage_key<>blob_key
  THEN RAISE EXCEPTION 'Receipt request mismatch' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('id',previous.id,'file_name',previous.file_name,'content_type',previous.content_type,'size',previous.size,'created_at',previous.created_at);
 END IF;
 SELECT * INTO a FROM public.appointments WHERE id=p_appointment FOR UPDATE;
 IF a.id IS NULL OR a.patient_id<>p_actor THEN RAISE EXCEPTION 'Forbidden appointment' USING ERRCODE='42501'; END IF;
 IF a.status<>'PRE_RESERVED' OR a.payment_status<>'PENDING' OR a.start_time<=now()
 OR EXISTS(SELECT 1 FROM telecus_integration.deliveries WHERE appointment_id=a.id AND status<>'done' AND operation='confirm')
 THEN RAISE EXCEPTION 'Appointment does not accept receipts' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM telecus_integration.payment_receipts WHERE appointment_id=a.id AND withdrawn_at IS NULL) THEN RAISE EXCEPTION 'Receipt already received' USING ERRCODE='23505'; END IF;
 INSERT INTO telecus_integration.payment_receipts(appointment_id,patient_id,request_id,file_name,content_type,size,sha256,storage_key)
 VALUES(a.id,p_actor,p_request,name,mime,file_size,digest,blob_key) RETURNING * INTO r;
 PERFORM telecus_integration.publish_notification('payment-receipt:'||r.id,'payment_receipt_received',a.id);
 RETURN jsonb_build_object('id',r.id,'file_name',r.file_name,'content_type',r.content_type,'size',r.size,'created_at',r.created_at);
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.withdraw_payment_receipt(p_actor uuid,p_receipt uuid,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles;r telecus_integration.payment_receipts;previous telecus_integration.payment_receipts;a public.appointments;
BEGIN
 actor:=telecus_integration.actor(p_actor);
 IF actor.role<>'PATIENT' THEN RAISE EXCEPTION 'Patient required' USING ERRCODE='42501';END IF;
 IF p_receipt IS NULL OR p_request IS NULL THEN RAISE EXCEPTION 'Invalid withdrawal' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('receipt-withdraw:'||p_actor||':'||p_request,0));
 SELECT * INTO previous FROM telecus_integration.payment_receipts WHERE patient_id=p_actor AND withdrawal_request=p_request;
 IF previous.id IS NOT NULL THEN
  IF previous.id<>p_receipt THEN RAISE EXCEPTION 'Withdrawal mismatch' USING ERRCODE='23505';END IF;
  RETURN jsonb_build_object('id',p_receipt,'withdrawn',true);
 END IF;
 SELECT * INTO r FROM telecus_integration.payment_receipts WHERE id=p_receipt AND patient_id=p_actor;
 IF r.id IS NULL THEN RAISE EXCEPTION 'Forbidden receipt' USING ERRCODE='42501';END IF;
 SELECT * INTO a FROM public.appointments WHERE id=r.appointment_id FOR UPDATE;
 IF r.withdrawn_at IS NOT NULL OR a.status<>'PRE_RESERVED' OR a.payment_status<>'PENDING' OR a.start_time<=now()
 OR EXISTS(SELECT 1 FROM telecus_integration.deliveries WHERE appointment_id=a.id AND status<>'done')
 THEN RAISE EXCEPTION 'Receipt no longer editable' USING ERRCODE='P0002';END IF;
 UPDATE telecus_integration.payment_receipts SET withdrawn_at=now(),withdrawn_by=p_actor,withdrawal_request=p_request WHERE id=r.id AND withdrawn_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Receipt changed' USING ERRCODE='P0002';END IF;
 PERFORM telecus_integration.publish_notification('receipt-withdraw:'||r.id,'payment_receipt_withdrawn',a.id);
 RETURN jsonb_build_object('id',r.id,'withdrawn',true);
END $$;


CREATE TABLE IF NOT EXISTS telecus_integration.portal_configuration(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version bigint NOT NULL DEFAULT 1,
 payment_url text NOT NULL,support_phone text NOT NULL
);
INSERT INTO telecus_integration.portal_configuration VALUES(true,1,'https://pagosonline.sirec.unicauca.edu.co/','573148336862') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS telecus_integration.admin_commands(id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES public.profiles(id),fingerprint text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS telecus_integration.admin_audit(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL REFERENCES public.profiles(id),action text NOT NULL,target text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS telecus_integration.registrations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text NOT NULL,full_name text NOT NULL,role text NOT NULL CHECK(role IN ('PATIENT','DOCTOR')),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACTIVATED','CANCELLED')),version bigint NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT now(),activated_profile uuid REFERENCES public.profiles(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS registrations_email_pending ON telecus_integration.registrations(lower(email)) WHERE status='PENDING';
CREATE TABLE IF NOT EXISTS telecus_integration.knowledge_documents(
 file text PRIMARY KEY CHECK(file ~ '^[0-9]{2}_[A-Z_]+[.]md$'),title text NOT NULL,roles text[] NOT NULL,
 version bigint NOT NULL DEFAULT 1,published_id uuid
);
CREATE TABLE IF NOT EXISTS telecus_integration.knowledge_revisions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),file text NOT NULL REFERENCES telecus_integration.knowledge_documents(file),
 body text NOT NULL CHECK(length(body) BETWEEN 10 AND 20000),created_by uuid REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_revision_history ON telecus_integration.knowledge_revisions(file,created_at DESC,id);
CREATE TABLE IF NOT EXISTS telecus_integration.payment_reviews(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES public.profiles(id),appointment_id uuid NOT NULL REFERENCES public.appointments(id),
 snapshot jsonb NOT NULL,details jsonb NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',result jsonb,created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON telecus_integration.portal_configuration,telecus_integration.admin_commands,telecus_integration.admin_audit,telecus_integration.registrations,telecus_integration.knowledge_documents,telecus_integration.knowledge_revisions,telecus_integration.payment_reviews FROM PUBLIC,anon,authenticated,service_role,telecus_backend;

CREATE OR REPLACE FUNCTION telecus_integration.administration_version() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$SELECT 1$$;
CREATE OR REPLACE FUNCTION telecus_integration.admin_actor(p_actor uuid) RETURNS public.profiles
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public.profiles;
BEGIN a:=telecus_integration.actor(p_actor);IF a.role<>'ADMIN' THEN RAISE EXCEPTION 'Admin required' USING ERRCODE='42501';END IF;RETURN a;END $$;
CREATE OR REPLACE FUNCTION telecus_integration.profile_version(p public.profiles) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$SELECT md5(jsonb_build_array(p.id,p.full_name,p.email,p.role,p.active)::text)$$;
CREATE OR REPLACE FUNCTION telecus_integration.portal_settings() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version',version::text,'payment_url',payment_url,'support_phone',support_phone) FROM telecus_integration.portal_configuration WHERE singleton
$$;
CREATE OR REPLACE FUNCTION telecus_integration.seed_knowledge_catalog(p_catalog jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d jsonb;revision uuid;audiences text[];
BEGIN
 IF jsonb_typeof(p_catalog)<>'array' OR jsonb_array_length(p_catalog)>30 THEN RAISE EXCEPTION 'Invalid catalog' USING ERRCODE='22023';END IF;
 FOR d IN SELECT value FROM jsonb_array_elements(p_catalog) LOOP
  IF COALESCE(d->>'file','') !~ '^[0-9]{2}_[A-Z_]+[.]md$' OR length(COALESCE(d->>'body','')) NOT BETWEEN 10 AND 20000 OR length(COALESCE(d->>'title','')) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid document' USING ERRCODE='22023';END IF;
  SELECT array_agg(value) INTO audiences FROM jsonb_array_elements_text(d->'roles');
  IF audiences IS NULL OR NOT audiences<@ARRAY['patient','admin','doctor']::text[] THEN RAISE EXCEPTION 'Invalid audience' USING ERRCODE='22023';END IF;
  INSERT INTO telecus_integration.knowledge_documents(file,title,roles) VALUES(d->>'file',d->>'title',audiences) ON CONFLICT DO NOTHING;
  IF FOUND THEN
   INSERT INTO telecus_integration.knowledge_revisions(file,body) VALUES(d->>'file',d->>'body') RETURNING id INTO revision;
   UPDATE telecus_integration.knowledge_documents SET published_id=revision WHERE file=d->>'file';
  END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION telecus_integration.published_knowledge() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('file',d.file,'title',d.title,'roles',d.roles,'body',v.body,'version',v.id::text) ORDER BY d.file),'[]'::jsonb)
 FROM telecus_integration.knowledge_documents d JOIN telecus_integration.knowledge_revisions v ON v.id=d.published_id AND v.file=d.file
$$;

CREATE OR REPLACE FUNCTION telecus_integration.administration_read(p_actor uuid,p_resource text,p_filter jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles;offset_n integer;items jsonb;d telecus_integration.knowledge_documents;
BEGIN
 actor:=telecus_integration.admin_actor(p_actor);
 offset_n:=COALESCE((p_filter->>'offset')::integer,0);
 IF offset_n NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'Invalid offset' USING ERRCODE='22023';END IF;
 IF p_resource='settings' THEN RETURN telecus_integration.portal_settings();END IF;
 IF p_resource='people' THEN
  IF COALESCE(p_filter->>'role','PATIENT') NOT IN ('PATIENT','DOCTOR') THEN RAISE EXCEPTION 'Invalid role' USING ERRCODE='22023';END IF;
  SELECT COALESCE(jsonb_agg(x.item ORDER BY x.email,x.id),'[]'::jsonb) INTO items FROM (
   SELECT p.email,p.id,jsonb_build_object('id',p.id,'full_name',p.full_name,'email',p.email,'role',p.role,'active',p.active,'version',telecus_integration.profile_version(p)) AS item
   FROM public.profiles p WHERE p.role=COALESCE(p_filter->>'role','PATIENT') AND position(lower(left(COALESCE(p_filter->>'q',''),80)) IN lower(COALESCE(p.full_name,'')||' '||COALESCE(p.email,'')))>0 ORDER BY p.email,p.id LIMIT 26 OFFSET offset_n
  ) x;
 ELSIF p_resource='payments' THEN
  SELECT COALESCE(jsonb_agg(x.item ORDER BY x.start_time,x.id),'[]'::jsonb) INTO items FROM (
   SELECT a.start_time,a.id,jsonb_build_object('appointment_id',a.id,'code',a.code,'patient_name',p.full_name,'doctor_name',d.full_name,'start_time',a.start_time,
    'processing',EXISTS(SELECT 1 FROM telecus_integration.deliveries v WHERE v.appointment_id=a.id AND v.status<>'done'),
    'receipt',CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('id',r.id,'file_name',r.file_name,'content_type',r.content_type,'size',r.size,'created_at',r.created_at) END) AS item
   FROM public.appointments a JOIN public.profiles p ON p.id=a.patient_id JOIN public.profiles d ON d.id=a.doctor_id LEFT JOIN telecus_integration.payment_receipts r ON r.appointment_id=a.id AND r.withdrawn_at IS NULL
   WHERE a.status='PRE_RESERVED' AND a.payment_status='PENDING' AND a.start_time>now() ORDER BY a.start_time,a.id LIMIT 26 OFFSET offset_n
  ) x;
 ELSIF p_resource='registrations' THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'email',r.email,'full_name',r.full_name,'role',r.role,'status',r.status,'version',r.version::text,'created_at',r.created_at) ORDER BY r.created_at DESC),'[]'::jsonb) INTO items FROM (SELECT * FROM telecus_integration.registrations ORDER BY created_at DESC LIMIT 100) r;
  RETURN jsonb_build_object('items',items);
 ELSIF p_resource='knowledge' THEN
  IF p_filter->>'file' IS NOT NULL THEN
   SELECT * INTO d FROM telecus_integration.knowledge_documents WHERE file=p_filter->>'file';
   IF d.file IS NULL THEN RAISE EXCEPTION 'Document not found' USING ERRCODE='P0002';END IF;
   SELECT COALESCE(jsonb_agg(jsonb_build_object('id',v.id,'body',v.body,'created_at',v.created_at,'author',COALESCE(p.full_name,'Corpus inicial')) ORDER BY v.created_at DESC,v.id),'[]'::jsonb) INTO items
    FROM (SELECT * FROM telecus_integration.knowledge_revisions WHERE file=d.file ORDER BY created_at DESC,id LIMIT 20) v LEFT JOIN public.profiles p ON p.id=v.created_by;
   RETURN jsonb_build_object('file',d.file,'title',d.title,'roles',d.roles,'version',d.version::text,'published_id',d.published_id,'versions',items);
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('file',file,'title',title,'roles',roles,'version',version::text,'published_id',published_id) ORDER BY file),'[]'::jsonb) INTO items FROM telecus_integration.knowledge_documents;
  RETURN jsonb_build_object('items',items);
 ELSE RAISE EXCEPTION 'Unknown administrative section' USING ERRCODE='22023';
 END IF;
 RETURN jsonb_build_object('items',(SELECT COALESCE(jsonb_agg(value ORDER BY ord),'[]'::jsonb) FROM jsonb_array_elements(items) WITH ORDINALITY AS entries(value,ord) WHERE ord<=25),'next_offset',CASE WHEN jsonb_array_length(items)>25 THEN offset_n+25 ELSE NULL END);
END $$;

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
  before_data:=to_jsonb(cfg);target_key:='portal';
  UPDATE telecus_integration.portal_configuration SET version=version+1,payment_url=p_payload->>'payment_url',support_phone=p_payload->>'support_phone' WHERE singleton;
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

CREATE OR REPLACE FUNCTION telecus_integration.claim_registration(p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE identity_row auth.users;reg telecus_integration.registrations;profile_row public.profiles;
BEGIN
 SELECT * INTO identity_row FROM auth.users WHERE id=p_actor;
 IF identity_row.id IS NULL OR identity_row.email_confirmed_at IS NULL THEN RETURN;END IF;
 SELECT * INTO reg FROM telecus_integration.registrations WHERE lower(email)=lower(identity_row.email) AND status='PENDING' AND created_at<=identity_row.created_at FOR UPDATE;
 IF reg.id IS NULL THEN RETURN;END IF;
 SELECT * INTO profile_row FROM public.profiles WHERE id=p_actor FOR UPDATE;
 IF profile_row.id IS NULL OR profile_row.role<>'PATIENT' OR NOT profile_row.active
 OR EXISTS(SELECT 1 FROM public.appointments WHERE patient_id=p_actor OR doctor_id=p_actor) THEN RETURN;END IF;
 UPDATE public.profiles SET role=reg.role,full_name=reg.full_name WHERE id=p_actor;
 UPDATE telecus_integration.registrations SET status='ACTIVATED',version=version+1,activated_profile=p_actor WHERE id=reg.id;
 INSERT INTO telecus_integration.admin_audit(actor_id,action,target,details) VALUES(reg.created_by,'registration_activated',p_actor::text,jsonb_build_object('registration',reg.id,'role',reg.role));
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.payment_review_snapshot(p_appointment uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public.appointments;r telecus_integration.payment_receipts;patient_name text;doctor_name text;
BEGIN
 SELECT * INTO a FROM public.appointments WHERE id=p_appointment FOR UPDATE;
 IF a.id IS NULL OR a.status<>'PRE_RESERVED' OR a.payment_status<>'PENDING' OR a.start_time<=now()
 OR EXISTS(SELECT 1 FROM telecus_integration.deliveries WHERE appointment_id=a.id AND status<>'done')
 THEN RAISE EXCEPTION 'Payment no longer reviewable' USING ERRCODE='P0002';END IF;
 SELECT * INTO r FROM telecus_integration.payment_receipts WHERE appointment_id=a.id AND withdrawn_at IS NULL;
 SELECT full_name INTO patient_name FROM public.profiles WHERE id=a.patient_id;
 SELECT full_name INTO doctor_name FROM public.profiles WHERE id=a.doctor_id;
 RETURN jsonb_build_object('appointment',jsonb_build_object('id',a.id,'code',a.code,'patient_name',patient_name,'doctor_name',doctor_name,'start_time',a.start_time),
  'receipt',CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('id',r.id,'file_name',r.file_name,'content_type',r.content_type,'size',r.size,'created_at',r.created_at) END,
  'snapshot',jsonb_build_array(a.doctor_id,a.start_time,a.end_time,r.id));
END $$;
CREATE OR REPLACE FUNCTION telecus_integration.prepare_payment_review(p_actor uuid,p_appointment uuid,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles;previous telecus_integration.payment_reviews;data jsonb;r telecus_integration.payment_reviews;
BEGIN
 actor:=telecus_integration.admin_actor(p_actor);
 IF p_request IS NULL OR p_appointment IS NULL THEN RAISE EXCEPTION 'Invalid review' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('payment-review:'||p_request,0));
 SELECT * INTO previous FROM telecus_integration.payment_reviews WHERE id=p_request;
 IF previous.id IS NOT NULL THEN
  IF previous.actor_id<>p_actor OR previous.appointment_id<>p_appointment THEN RAISE EXCEPTION 'Review mismatch' USING ERRCODE='23505';END IF;
  RETURN previous.details||jsonb_build_object('id',previous.id,'expires_at',previous.expires_at);
 END IF;
 data:=telecus_integration.payment_review_snapshot(p_appointment);
 INSERT INTO telecus_integration.payment_reviews(id,actor_id,appointment_id,snapshot,details) VALUES(p_request,p_actor,p_appointment,data->'snapshot',data-'snapshot') RETURNING * INTO r;
 RETURN r.details||jsonb_build_object('id',r.id,'expires_at',r.expires_at);
END $$;
CREATE OR REPLACE FUNCTION telecus_integration.confirm_payment_review(p_actor uuid,p_review uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles;r telecus_integration.payment_reviews;current_data jsonb;result_text text;answer jsonb;
BEGIN
 actor:=telecus_integration.admin_actor(p_actor);
 SELECT * INTO r FROM telecus_integration.payment_reviews WHERE id=p_review FOR UPDATE;
 IF r.id IS NULL OR r.actor_id<>p_actor THEN RAISE EXCEPTION 'Forbidden review' USING ERRCODE='42501';END IF;
 IF r.result IS NOT NULL THEN RETURN r.result;END IF;
 IF r.expires_at<=now() THEN RAISE EXCEPTION 'Review expired' USING ERRCODE='P0002';END IF;
 current_data:=telecus_integration.payment_review_snapshot(r.appointment_id);
 IF current_data->'snapshot' IS DISTINCT FROM r.snapshot THEN RAISE EXCEPTION 'Receipt or appointment changed' USING ERRCODE='P0002';END IF;
 result_text:=telecus_integration.execute(p_actor,r.id,'verify_payment',jsonb_build_object('appointment_code',r.details->'appointment'->>'code'));
 answer:=jsonb_build_object('status','queued','reply',result_text,'mode','supabase-live');
 UPDATE telecus_integration.payment_reviews SET result=answer WHERE id=r.id;
 INSERT INTO telecus_integration.admin_audit(actor_id,action,target,details) VALUES(p_actor,'payment_verified',r.appointment_id::text,jsonb_build_object('review',r.id,'receipt',r.details->'receipt'->'id'));
 RETURN answer;
END $$;

-- No browser role can call these functions or read the private tables directly.
REVOKE ALL ON FUNCTION telecus_integration.administration_version(),telecus_integration.admin_actor(uuid),telecus_integration.profile_version(public.profiles),telecus_integration.portal_settings(),telecus_integration.seed_knowledge_catalog(jsonb),telecus_integration.published_knowledge(),telecus_integration.administration_read(uuid,text,jsonb),telecus_integration.administration_write(uuid,uuid,text,text,jsonb),telecus_integration.claim_registration(uuid),telecus_integration.payment_review_snapshot(uuid),telecus_integration.prepare_payment_review(uuid,uuid,uuid),telecus_integration.confirm_payment_review(uuid,uuid),telecus_integration.withdraw_payment_receipt(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
GRANT EXECUTE ON FUNCTION telecus_integration.administration_version(),telecus_integration.portal_settings(),telecus_integration.seed_knowledge_catalog(jsonb),telecus_integration.published_knowledge(),telecus_integration.administration_read(uuid,text,jsonb),telecus_integration.administration_write(uuid,uuid,text,text,jsonb),telecus_integration.claim_registration(uuid),telecus_integration.prepare_payment_review(uuid,uuid,uuid),telecus_integration.confirm_payment_review(uuid,uuid),telecus_integration.withdraw_payment_receipt(uuid,uuid,uuid) TO telecus_backend;
