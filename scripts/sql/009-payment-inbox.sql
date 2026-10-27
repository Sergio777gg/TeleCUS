-- Separate receipt readiness from financial status. No writes or inference in queries.
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
 WHERE a.status='PRE_RESERVED' AND a.payment_status='PENDING' AND a.start_time>now()
 ),filtered AS (
 SELECT * FROM scoped WHERE (view_name='processing' AND processing) OR (NOT processing AND ((view_name='received' AND receipt_id IS NOT NULL) OR (view_name='awaiting' AND receipt_id IS NULL)))
 ),page AS (SELECT *,row_number() OVER(ORDER BY start_time,id) AS n FROM filtered ORDER BY start_time,id LIMIT 26 OFFSET offset_n)
 SELECT jsonb_build_object('view',view_name,'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('appointment_id',id,'code',code,'patient_name',patient_name,'doctor_name',doctor_name,'start_time',start_time,'processing',processing,
 'receipt',CASE WHEN receipt_id IS NULL THEN NULL ELSE jsonb_build_object('id',receipt_id,'file_name',file_name,'content_type',content_type,'size',size,'created_at',created_at) END)||COALESCE(telecus_integration.hold_info(id),'{}') ORDER BY start_time,id) FROM page WHERE n<=offset_n+25),'[]'),
 'next_offset',CASE WHEN (SELECT count(*) FROM page)>25 THEN offset_n+25 ELSE NULL END) INTO result;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION telecus_integration.workspace_appointments(p_actor uuid,p_filter jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
 'counts',jsonb_build_object('active',(SELECT count(*) FROM scoped WHERE status NOT IN ('CANCELLED','COMPLETED')),'pending_payments',CASE WHEN who.role='ADMIN' THEN (SELECT count(*) FROM scoped WHERE status='PRE_RESERVED' AND payment_status='PENDING' AND start_time>now() AND EXISTS(SELECT 1 FROM telecus_integration.payment_receipts r WHERE r.appointment_id=scoped.id AND r.withdrawn_at IS NULL) AND NOT EXISTS(SELECT 1 FROM telecus_integration.deliveries v WHERE v.appointment_id=scoped.id AND v.status<>'done')) ELSE 0 END,'awaiting_receipt',CASE WHEN who.role='ADMIN' THEN (SELECT count(*) FROM scoped WHERE status='PRE_RESERVED' AND payment_status='PENDING' AND start_time>now() AND NOT EXISTS(SELECT 1 FROM telecus_integration.payment_receipts r WHERE r.appointment_id=scoped.id AND r.withdrawn_at IS NULL) AND NOT EXISTS(SELECT 1 FROM telecus_integration.deliveries v WHERE v.appointment_id=scoped.id AND v.status<>'done')) ELSE 0 END,'pending_requests',CASE WHEN who.role='ADMIN' THEN (SELECT count(*) FROM public.appointment_change_requests WHERE status='PENDING') ELSE 0 END,'to_complete',(SELECT count(*) FROM scoped WHERE status IN ('CONFIRMED','RESCHEDULED') AND payment_status='VERIFIED' AND end_time<=now()))) INTO result;
 RETURN result;
END $$;
