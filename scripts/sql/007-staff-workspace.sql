-- Staff read models and optimistic confirmations, reusing the existing agenda mutations/outbox.
CREATE FUNCTION telecus_integration.workspace_version() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 1 $$;
CREATE FUNCTION telecus_integration.workspace_appointments(p_actor uuid,p_filter jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE who public.profiles;view_name text:=COALESCE(p_filter->>'view','current');offset_n integer:=COALESCE((p_filter->>'offset')::integer,0);result jsonb;
BEGIN
 who:=telecus_integration.actor(p_actor);IF who.role NOT IN ('ADMIN','DOCTOR') THEN RAISE EXCEPTION 'Staff required' USING ERRCODE='42501';END IF;
 IF view_name NOT IN ('current','history','all') OR offset_n NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'Invalid filter' USING ERRCODE='22023';END IF;
 WITH scoped AS (
 SELECT a.id,a.code,a.doctor_id,a.start_time,a.end_time,a.status,a.payment_status,a.meet_url,d.full_name AS doctor_name
 FROM public.appointments a JOIN public.profiles d ON d.id=a.doctor_id
 WHERE who.role='ADMIN' OR (a.doctor_id=p_actor AND a.payment_status='VERIFIED' AND a.status<>'PRE_RESERVED')
 ),filtered AS (
 SELECT * FROM scoped WHERE (view_name='all' OR (view_name='current' AND status NOT IN ('CANCELLED','COMPLETED')) OR (view_name='history' AND status IN ('CANCELLED','COMPLETED')))
 AND position(lower(left(COALESCE(p_filter->>'q',''),80)) IN lower(code||' '||COALESCE(doctor_name,'')))>0
 ),page AS (
 SELECT * FROM filtered ORDER BY CASE WHEN view_name='history' THEN start_time END DESC,start_time,id LIMIT 26 OFFSET offset_n
 ) SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(item ORDER BY n) FROM (
 SELECT jsonb_build_object('id',id,'code',code,'doctor_id',doctor_id,'doctor_name',doctor_name,'start_time',start_time,'end_time',end_time,'status',status,'payment_status',payment_status)
 ||CASE WHEN who.role='DOCTOR' AND status IN ('CONFIRMED','RESCHEDULED') AND meet_url ~ '^https://meet[.]google[.]com/[a-z0-9-]+$' THEN jsonb_build_object('meet_url',meet_url) ELSE '{}'::jsonb END AS item,n
 FROM (SELECT *,row_number() OVER(ORDER BY CASE WHEN view_name='history' THEN start_time END DESC,start_time,id) AS n FROM page) numbered WHERE n<=25) rows),'[]'),
 'next_offset',CASE WHEN (SELECT count(*) FROM page)>25 THEN offset_n+25 ELSE NULL END,
 'counts',jsonb_build_object('active',(SELECT count(*) FROM scoped WHERE status NOT IN ('CANCELLED','COMPLETED')),'pending_payments',CASE WHEN who.role='ADMIN' THEN (SELECT count(*) FROM scoped WHERE status='PRE_RESERVED' AND payment_status='PENDING') ELSE 0 END,'pending_requests',CASE WHEN who.role='ADMIN' THEN (SELECT count(*) FROM public.appointment_change_requests WHERE status='PENDING') ELSE 0 END,'to_complete',(SELECT count(*) FROM scoped WHERE status IN ('CONFIRMED','RESCHEDULED') AND payment_status='VERIFIED' AND end_time<=now()))) INTO result;
 RETURN result;
END $$;
CREATE FUNCTION telecus_integration.workspace_requests(p_actor uuid,p_filter jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE view_name text:=COALESCE(p_filter->>'view','current');offset_n integer:=COALESCE((p_filter->>'offset')::integer,0);items jsonb;
BEGIN
 PERFORM telecus_integration.admin_actor(p_actor);IF view_name NOT IN ('current','history','all') OR offset_n NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'Invalid filter' USING ERRCODE='22023';END IF;
 SELECT COALESCE(jsonb_agg(item ORDER BY created_at DESC,id),'[]') INTO items FROM (
 SELECT r.created_at,r.id,jsonb_build_object('id',r.id,'appointment_code',a.code,'appointment_status',a.status,'current_start_time',a.start_time,'doctor_name',d.full_name,'request_type',r.request_type,'status',r.status,'requested_start_time',r.requested_start_time,'requested_end_time',r.requested_end_time,'created_at',r.created_at) AS item
 FROM public.appointment_change_requests r JOIN public.appointments a ON a.id=r.appointment_id JOIN public.profiles d ON d.id=a.doctor_id
 WHERE (view_name='all' OR (view_name='current' AND r.status='PENDING') OR (view_name='history' AND r.status<>'PENDING')) AND position(lower(left(COALESCE(p_filter->>'q',''),80)) IN lower(a.code))>0
 ORDER BY r.created_at DESC,r.id LIMIT 26 OFFSET offset_n) page;
 RETURN jsonb_build_object('items',(SELECT COALESCE(jsonb_agg(value ORDER BY ord),'[]') FROM jsonb_array_elements(items) WITH ORDINALITY x(value,ord) WHERE ord<=25),'next_offset',CASE WHEN jsonb_array_length(items)>25 THEN offset_n+25 ELSE NULL END);
END $$;
CREATE FUNCTION telecus_integration.staff_snapshot(p_actor uuid,p_kind text,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE who public.profiles;target public.appointments;change public.appointment_change_requests;selected public.profiles;physician_name text;version text;
BEGIN
 who:=telecus_integration.actor(p_actor);
 IF who.role='DOCTOR' AND p_kind<>'complete' OR who.role='ADMIN' AND p_kind NOT IN ('cancel','reschedule','assign_doctor','approve_change','reject_change') OR who.role NOT IN ('ADMIN','DOCTOR') THEN RAISE EXCEPTION 'Forbidden action' USING ERRCODE='42501';END IF;
 IF p_kind IN ('approve_change','reject_change') THEN
  SELECT * INTO change FROM public.appointment_change_requests WHERE id=(p_payload->>'request_id')::uuid FOR UPDATE;
  IF change.id IS NULL OR change.status<>'PENDING' THEN RAISE EXCEPTION 'Request changed' USING ERRCODE='P0002';END IF;
  SELECT * INTO target FROM public.appointments WHERE id=change.appointment_id FOR UPDATE;
 ELSE SELECT * INTO target FROM public.appointments WHERE code=p_payload->>'appointment_code' FOR UPDATE;END IF;
 IF target.id IS NULL OR (who.role='DOCTOR' AND (target.doctor_id<>p_actor OR target.payment_status<>'VERIFIED')) THEN RAISE EXCEPTION 'Forbidden appointment' USING ERRCODE='42501';END IF;
 IF target.status IN ('CANCELLED','COMPLETED') THEN RAISE EXCEPTION 'Appointment changed or delivery pending' USING ERRCODE='P0002';END IF;
 IF EXISTS(SELECT 1 FROM telecus_integration.deliveries WHERE appointment_id=target.id AND status<>'done') THEN RAISE EXCEPTION 'Appointment changed or delivery pending' USING ERRCODE='P0002';END IF;
 IF p_kind='complete' AND (target.status NOT IN ('CONFIRMED','RESCHEDULED') OR target.payment_status<>'VERIFIED' OR target.end_time>now()) THEN RAISE EXCEPTION 'Cannot complete' USING ERRCODE='22023';END IF;
 IF p_kind='assign_doctor' THEN SELECT * INTO selected FROM public.profiles WHERE id=(p_payload->>'doctor_id')::uuid AND active AND role='DOCTOR';IF selected.id IS NULL THEN RAISE EXCEPTION 'Invalid doctor' USING ERRCODE='22023';END IF;END IF;
 IF p_kind='reschedule' THEN PERFORM telecus_integration.interval(p_payload->>'date',p_payload->>'time');END IF;
 SELECT full_name INTO physician_name FROM public.profiles WHERE id=target.doctor_id;
 IF p_kind IN ('reschedule','approve_change') THEN SELECT max(s.version)::text INTO version FROM telecus_integration.service_schedules s;END IF;
 RETURN jsonb_build_object('snapshot',jsonb_build_array(target.id,target.doctor_id,target.start_time,target.end_time,target.status,target.payment_status,change.id,change.status,change.requested_start_time,change.requested_end_time,selected.id,version),
 'details',jsonb_build_object('appointment_code',target.code,'doctor_name',physician_name,'current_start_time',target.start_time,'current_end_time',target.end_time,'requested_start_time',change.requested_start_time,'request_type',change.request_type,'target_doctor_name',selected.full_name,'date',p_payload->>'date','time',p_payload->>'time'));
END $$;
ALTER FUNCTION telecus_integration.execute(uuid,uuid,text,jsonb) RENAME TO execute_before007;
CREATE FUNCTION telecus_integration.execute(p_actor uuid,p_id uuid,p_kind text,p_payload jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_data jsonb;
BEGIN
 PERFORM telecus_integration.actor(p_actor);
 PERFORM pg_advisory_xact_lock(hashtextextended('telecus-operation:'||p_id,0));
 IF p_payload?'expected_snapshot' AND NOT EXISTS(SELECT 1 FROM telecus_integration.operations WHERE id=p_id) THEN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('telecus-service-schedule',0));
  current_data:=telecus_integration.staff_snapshot(p_actor,p_kind,p_payload);
  IF current_data->'snapshot' IS DISTINCT FROM p_payload->'expected_snapshot' THEN RAISE EXCEPTION 'Staff review changed' USING ERRCODE='P0002';END IF;
 END IF;
 RETURN telecus_integration.execute_before007(p_actor,p_id,p_kind,p_payload);
END $$;
REVOKE ALL ON FUNCTION telecus_integration.execute_before007(uuid,uuid,text,jsonb),telecus_integration.workspace_version(),telecus_integration.workspace_appointments(uuid,jsonb),telecus_integration.workspace_requests(uuid,jsonb),telecus_integration.staff_snapshot(uuid,text,jsonb),telecus_integration.execute(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
GRANT EXECUTE ON FUNCTION telecus_integration.workspace_version(),telecus_integration.workspace_appointments(uuid,jsonb),telecus_integration.workspace_requests(uuid,jsonb),telecus_integration.staff_snapshot(uuid,text,jsonb),telecus_integration.execute(uuid,uuid,text,jsonb) TO telecus_backend;
