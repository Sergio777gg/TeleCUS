-- Versioned operational calendar and NEW reservation holds. No legacy appointment is enrolled.
CREATE TABLE telecus_integration.service_schedules(
 version bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,effective_from date NOT NULL,
 days integer[] NOT NULL,start_time time NOT NULL,end_time time NOT NULL,hold_hours integer NOT NULL CHECK(hold_hours BETWEEN 1 AND 168),
 created_by uuid REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(cardinality(days) BETWEEN 1 AND 7),CHECK(start_time<end_time)
);
INSERT INTO telecus_integration.service_schedules(effective_from,days,start_time,end_time,hold_hours) VALUES('2000-01-01',ARRAY[1],'14:00','16:00',24);
CREATE INDEX ON telecus_integration.service_schedules(effective_from DESC,version DESC);
CREATE TABLE telecus_integration.reservation_holds(
 appointment_id uuid PRIMARY KEY REFERENCES public.appointments(id),schedule_version bigint NOT NULL REFERENCES telecus_integration.service_schedules(version),
 expires_at timestamptz NOT NULL,expired_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON telecus_integration.reservation_holds(expires_at) WHERE expired_at IS NULL;
REVOKE ALL ON telecus_integration.service_schedules,telecus_integration.reservation_holds FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
REVOKE ALL ON SEQUENCE telecus_integration.service_schedules_version_seq FROM PUBLIC,anon,authenticated,service_role,telecus_backend;

CREATE FUNCTION telecus_integration.schedule_version() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 1 $$;
CREATE FUNCTION telecus_integration.service_schedules() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version',max(version)::text,'items',jsonb_agg(jsonb_build_object('version',version::text,'effective_from',effective_from,'days',days,'start',to_char(start_time,'HH24:MI'),'end',to_char(end_time,'HH24:MI'),'minutes',30,'timezone','America/Bogota','hold_hours',hold_hours) ORDER BY effective_from,version)) FROM telecus_integration.service_schedules
$$;
CREATE FUNCTION telecus_integration.schedule_for(p_date date) RETURNS telecus_integration.service_schedules LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT * FROM telecus_integration.service_schedules WHERE effective_from<=p_date ORDER BY effective_from DESC,version DESC LIMIT 1
$$;
CREATE FUNCTION telecus_integration.save_service_schedule(p_actor uuid,p_request uuid,p_expected text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous telecus_integration.admin_commands;fingerprint text;latest text;days integer[];day_value jsonb;start_time time;end_time time;effective date;hours integer;v bigint;result jsonb;
BEGIN
 PERFORM telecus_integration.admin_actor(p_actor);
 IF p_request IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid schedule' USING ERRCODE='22023';END IF;
 fingerprint:=md5(jsonb_build_array('schedule',p_expected,p_payload)::text);
 PERFORM pg_advisory_xact_lock(hashtextextended('admin-command:'||p_request,0));
 SELECT * INTO previous FROM telecus_integration.admin_commands WHERE id=p_request;
 IF previous.id IS NOT NULL THEN
  IF previous.actor_id<>p_actor OR previous.fingerprint<>fingerprint THEN RAISE EXCEPTION 'Command mismatch' USING ERRCODE='23505';END IF;
  RETURN previous.result;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('telecus-service-schedule',0));
 SELECT max(version)::text INTO latest FROM telecus_integration.service_schedules;
 IF latest IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Schedule changed' USING ERRCODE='P0002';END IF;
 IF jsonb_typeof(p_payload->'days') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'days') NOT BETWEEN 1 AND 7
 OR COALESCE(p_payload->>'start','') !~ '^([01][0-9]|2[0-3]):(00|30)$' OR COALESCE(p_payload->>'end','') !~ '^([01][0-9]|2[0-3]):(00|30)$'
 OR COALESCE(p_payload->>'effective_from','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR COALESCE(p_payload->>'hold_hours','') !~ '^[0-9]{1,3}$'
 THEN RAISE EXCEPTION 'Invalid schedule' USING ERRCODE='22023';END IF;
 FOR day_value IN SELECT value FROM jsonb_array_elements(p_payload->'days') LOOP
  IF jsonb_typeof(day_value)<>'number' OR day_value::text !~ '^[0-6]$' THEN RAISE EXCEPTION 'Invalid day' USING ERRCODE='22023';END IF;
  days:=array_append(days,(day_value::text)::integer);
 END LOOP;
 IF cardinality(days)<>(SELECT count(DISTINCT d) FROM unnest(days) d) THEN RAISE EXCEPTION 'Duplicate day' USING ERRCODE='22023';END IF;
 BEGIN effective:=(p_payload->>'effective_from')::date;EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid effective date' USING ERRCODE='22023';END;
 start_time:=(p_payload->>'start')::time;end_time:=(p_payload->>'end')::time;hours:=(p_payload->>'hold_hours')::integer;
 IF effective<(now() AT TIME ZONE 'America/Bogota')::date OR start_time>=end_time OR hours NOT BETWEEN 1 AND 168 THEN RAISE EXCEPTION 'Invalid schedule' USING ERRCODE='22023';END IF;
 INSERT INTO telecus_integration.service_schedules(effective_from,days,start_time,end_time,hold_hours,created_by) VALUES(effective,days,start_time,end_time,hours,p_actor) RETURNING version INTO v;
 result:=jsonb_build_object('status','saved','version',v::text);
 INSERT INTO telecus_integration.admin_audit(actor_id,action,target,details) VALUES(p_actor,'schedule',v::text,jsonb_build_object('previous_version',latest,'new',p_payload,'request',p_request));
 INSERT INTO telecus_integration.admin_commands(id,actor_id,fingerprint,result) VALUES(p_request,p_actor,fingerprint,result);
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.interval(p_date text,p_time text) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE start_at timestamptz;p telecus_integration.service_schedules;offset_minutes integer;
BEGIN
 IF p_date IS NULL OR p_time IS NULL OR p_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR p_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RAISE EXCEPTION 'Invalid schedule' USING ERRCODE='22023';END IF;
 BEGIN start_at:=(p_date||' '||p_time)::timestamp AT TIME ZONE 'America/Bogota';p:=telecus_integration.schedule_for(p_date::date);
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid date' USING ERRCODE='22023';END;
 offset_minutes:=extract(epoch FROM (p_time::time-p.start_time))/60;
 IF p.version IS NULL OR start_at<=now() OR NOT extract(dow FROM start_at AT TIME ZONE 'America/Bogota')::integer=ANY(p.days)
 OR p_time::time<p.start_time OR p_time::time>=p.end_time OR p_time::time+interval '30 minutes'>p.end_time OR offset_minutes%30<>0
 THEN RAISE EXCEPTION 'Invalid schedule' USING ERRCODE='22023';END IF;
 RETURN start_at;
END $$;

-- SKIP LOCKED permits several API workers; receipts and expiration lock the SAME appointment.
CREATE FUNCTION telecus_integration.expire_holds() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE entry public.appointments;n integer:=0;
BEGIN
 FOR entry IN SELECT a.* FROM public.appointments a JOIN telecus_integration.reservation_holds h ON h.appointment_id=a.id
 WHERE h.expired_at IS NULL AND h.expires_at<=now() AND a.status='PRE_RESERVED' AND a.payment_status='PENDING'
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
CREATE FUNCTION telecus_integration.hold_info(p_appointment uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('expires_at',h.expires_at,'hold_expired',h.expired_at IS NOT NULL) FROM telecus_integration.reservation_holds h WHERE h.appointment_id=p_appointment
$$;
CREATE OR REPLACE FUNCTION telecus_integration.availability(p_actor uuid,p_doctor uuid,p_date text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles;p telecus_integration.service_schedules;t timestamp;start_at timestamptz;result jsonb:='[]';
BEGIN
 actor:=telecus_integration.actor(p_actor);IF actor.role NOT IN ('PATIENT','ADMIN') THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';END IF;
 PERFORM telecus_integration.expire_holds();
 IF p_date IS NULL OR p_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'Invalid date' USING ERRCODE='22023';END IF;
 BEGIN p:=telecus_integration.schedule_for(p_date::date);EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid date' USING ERRCODE='22023';END;
 FOR t IN SELECT s FROM generate_series(p_date::date+p.start_time,p_date::date+p.end_time-interval '30 minutes',interval '30 minutes') s LOOP
  BEGIN start_at:=telecus_integration.interval(p_date,to_char(t,'HH24:MI'));EXCEPTION WHEN SQLSTATE '22023' THEN CONTINUE;END;
  IF telecus_integration.slot_free(p_doctor,start_at,start_at+interval '30 minutes') THEN result:=result||to_jsonb(to_char(t,'HH24:MI'));END IF;
 END LOOP;RETURN result;
END $$;

ALTER FUNCTION telecus_integration.execute(uuid,uuid,text,jsonb) RENAME TO execute_before006;
CREATE FUNCTION telecus_integration.execute(p_actor uuid,p_id uuid,p_kind text,p_payload jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result text;reserved public.appointments;p telecus_integration.service_schedules;deadline timestamptz;already boolean;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('telecus-service-schedule',0));
 SELECT EXISTS(SELECT 1 FROM telecus_integration.operations WHERE id=p_id) INTO already;
 IF NOT already THEN
  IF p_kind='reserve' THEN PERFORM telecus_integration.expire_holds();END IF;
  IF p_kind IN ('reserve','reschedule') AND p_payload->>'schedule_version' IS NOT NULL AND p_payload->>'schedule_version' IS DISTINCT FROM (SELECT max(version)::text FROM telecus_integration.service_schedules) THEN RAISE EXCEPTION 'Schedule changed' USING ERRCODE='P0002';END IF;
  IF p_kind='verify_payment' AND EXISTS(SELECT 1 FROM public.appointments a JOIN telecus_integration.reservation_holds h ON h.appointment_id=a.id WHERE a.code=p_payload->>'appointment_code' AND h.expires_at<=now() AND NOT EXISTS(SELECT 1 FROM telecus_integration.payment_receipts r WHERE r.appointment_id=a.id AND r.withdrawn_at IS NULL)) THEN RAISE EXCEPTION 'Payment no longer reviewable' USING ERRCODE='P0002';END IF;
 END IF;
 result:=telecus_integration.execute_before006(p_actor,p_id,p_kind,p_payload);
 IF p_kind='reserve' AND NOT already THEN
  SELECT * INTO reserved FROM public.appointments WHERE patient_id=p_actor AND doctor_id=(p_payload->>'doctor_id')::uuid AND start_time=((p_payload->>'date')||' '||(p_payload->>'time'))::timestamp AT TIME ZONE 'America/Bogota' AND status='PRE_RESERVED';
  p:=telecus_integration.schedule_for((p_payload->>'date')::date);deadline:=least(reserved.start_time,now()+make_interval(hours=>p.hold_hours));
  INSERT INTO telecus_integration.reservation_holds(appointment_id,schedule_version,expires_at) VALUES(reserved.id,p.version,deadline);
 END IF;
 IF p_kind='reschedule' AND NOT already THEN UPDATE telecus_integration.reservation_holds h SET expires_at=least(h.expires_at,a.start_time) FROM public.appointments a WHERE a.id=h.appointment_id AND a.code=p_payload->>'appointment_code' AND a.status='PRE_RESERVED';END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION telecus_integration.execute_before006(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;

ALTER FUNCTION telecus_integration.upload_payment_receipt(uuid,uuid,uuid,jsonb) RENAME TO upload_receipt_before006;
CREATE FUNCTION telecus_integration.upload_payment_receipt(p_actor uuid,p_appointment uuid,p_request uuid,p_file jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM telecus_integration.actor(p_actor);
 PERFORM 1 FROM public.appointments WHERE id=p_appointment FOR UPDATE;
 IF EXISTS(SELECT 1 FROM telecus_integration.reservation_holds WHERE appointment_id=p_appointment AND expires_at<=now()) AND NOT EXISTS(SELECT 1 FROM telecus_integration.payment_receipts WHERE appointment_id=p_appointment AND withdrawn_at IS NULL) THEN RAISE EXCEPTION 'Payment no longer reviewable' USING ERRCODE='P0002';END IF;
 RETURN telecus_integration.upload_receipt_before006(p_actor,p_appointment,p_request,p_file);
END $$;
ALTER FUNCTION telecus_integration.withdraw_payment_receipt(uuid,uuid,uuid) RENAME TO withdraw_receipt_before006;
CREATE FUNCTION telecus_integration.withdraw_payment_receipt(p_actor uuid,p_receipt uuid,p_request uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;retry boolean;
BEGIN
 SELECT EXISTS(SELECT 1 FROM telecus_integration.payment_receipts WHERE id=p_receipt AND patient_id=p_actor AND withdrawal_request=p_request) INTO retry;
 result:=telecus_integration.withdraw_receipt_before006(p_actor,p_receipt,p_request);
 IF NOT retry THEN UPDATE telecus_integration.reservation_holds h SET expires_at=least(a.start_time,greatest(h.expires_at,now()+interval '15 minutes')) FROM public.appointments a,telecus_integration.payment_receipts r WHERE r.id=p_receipt AND a.id=r.appointment_id AND h.appointment_id=a.id;END IF;
 RETURN result;
END $$;
ALTER FUNCTION telecus_integration.list_payment_receipts(uuid) RENAME TO list_receipts_before006;
CREATE FUNCTION telecus_integration.list_payment_receipts(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE page jsonb;
BEGIN
 PERFORM telecus_integration.expire_holds();page:=telecus_integration.list_receipts_before006(p_actor);
 RETURN page||jsonb_build_object('items',(SELECT COALESCE(jsonb_agg(item||COALESCE(telecus_integration.hold_info((item->>'appointment_id')::uuid),'{}')),'[]') FROM jsonb_array_elements(page->'items') item));
END $$;
ALTER FUNCTION telecus_integration.administration_read(uuid,text,jsonb) RENAME TO admin_read_before006;
CREATE FUNCTION telecus_integration.administration_read(p_actor uuid,p_resource text,p_filter jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE page jsonb;
BEGIN
 PERFORM telecus_integration.admin_actor(p_actor);
 IF p_resource='payments' THEN PERFORM telecus_integration.expire_holds();END IF;
 page:=telecus_integration.admin_read_before006(p_actor,p_resource,p_filter);
 IF p_resource='payments' THEN RETURN page||jsonb_build_object('items',(SELECT COALESCE(jsonb_agg(item||COALESCE(telecus_integration.hold_info((item->>'appointment_id')::uuid),'{}')),'[]') FROM jsonb_array_elements(page->'items') item));END IF;
 RETURN page;
END $$;
REVOKE ALL ON FUNCTION telecus_integration.upload_receipt_before006(uuid,uuid,uuid,jsonb),telecus_integration.withdraw_receipt_before006(uuid,uuid,uuid),telecus_integration.list_receipts_before006(uuid),telecus_integration.admin_read_before006(uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
REVOKE ALL ON FUNCTION telecus_integration.schedule_version(),telecus_integration.service_schedules(),telecus_integration.schedule_for(date),telecus_integration.save_service_schedule(uuid,uuid,text,jsonb),telecus_integration.expire_holds(),telecus_integration.hold_info(uuid),telecus_integration.execute(uuid,uuid,text,jsonb),telecus_integration.upload_payment_receipt(uuid,uuid,uuid,jsonb),telecus_integration.withdraw_payment_receipt(uuid,uuid,uuid),telecus_integration.list_payment_receipts(uuid),telecus_integration.administration_read(uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
GRANT EXECUTE ON FUNCTION telecus_integration.schedule_version(),telecus_integration.service_schedules(),telecus_integration.save_service_schedule(uuid,uuid,text,jsonb),telecus_integration.expire_holds(),telecus_integration.execute(uuid,uuid,text,jsonb),telecus_integration.upload_payment_receipt(uuid,uuid,uuid,jsonb),telecus_integration.withdraw_payment_receipt(uuid,uuid,uuid),telecus_integration.list_payment_receipts(uuid),telecus_integration.administration_read(uuid,text,jsonb) TO telecus_backend;

-- Keep the existing trigger and recipient policy, adding only a non-clinical expiration reason.
CREATE OR REPLACE FUNCTION telecus_integration.publish_notification(p_key text,p_type text,p_appointment uuid,p_request uuid DEFAULT NULL,p_doctor uuid DEFAULT NULL,p_only_doctor boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public.appointments; r public.appointment_change_requests; event_id bigint; data jsonb;
BEGIN
 SELECT * INTO a FROM public.appointments WHERE id=p_appointment;
 IF a.id IS NULL THEN RETURN; END IF;
 IF p_request IS NOT NULL THEN SELECT * INTO r FROM public.appointment_change_requests WHERE id=p_request; END IF;
 -- No reason, patient names, email addresses, Meet links or clinical data in the inbox.
 data:=jsonb_build_object('code',a.code,'start_time',a.start_time,'request_type',r.request_type,'reason',CASE WHEN EXISTS(SELECT 1 FROM telecus_integration.reservation_holds h WHERE h.appointment_id=a.id AND h.expired_at IS NOT NULL) THEN 'reservation_expired' END);
 INSERT INTO telecus_integration.notification_events(event_key,event_type,payload) VALUES(p_key,p_type,data)
 ON CONFLICT(event_key) DO NOTHING RETURNING id INTO event_id;
 IF event_id IS NULL THEN RETURN; END IF;
 INSERT INTO telecus_integration.notifications(event_id,recipient_id,recipient_role)
 SELECT event_id,p.id,p.role FROM public.profiles p WHERE p.active AND
 ((NOT p_only_doctor AND (p.role='ADMIN' OR (p.role='PATIENT' AND p.id=a.patient_id)))
 OR (p.role='DOCTOR' AND p.id=p_doctor)) ON CONFLICT DO NOTHING;
END $$;


-- Fix the legacy payments alias colliding with the knowledge-document row variable.
CREATE OR REPLACE FUNCTION telecus_integration.admin_read_before006(p_actor uuid,p_resource text,p_filter jsonb DEFAULT '{}') RETURNS jsonb
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
   SELECT a.start_time,a.id,jsonb_build_object('appointment_id',a.id,'code',a.code,'patient_name',p.full_name,'doctor_name',physician.full_name,'start_time',a.start_time,
    'processing',EXISTS(SELECT 1 FROM telecus_integration.deliveries v WHERE v.appointment_id=a.id AND v.status<>'done'),
    'receipt',CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('id',r.id,'file_name',r.file_name,'content_type',r.content_type,'size',r.size,'created_at',r.created_at) END) AS item
   FROM public.appointments a JOIN public.profiles p ON p.id=a.patient_id JOIN public.profiles physician ON physician.id=a.doctor_id LEFT JOIN telecus_integration.payment_receipts r ON r.appointment_id=a.id AND r.withdrawn_at IS NULL
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

