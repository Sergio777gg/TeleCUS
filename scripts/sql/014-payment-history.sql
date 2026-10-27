-- Read-only history. Keep financial evidence after confirmation, cancellation or completion.
CREATE INDEX IF NOT EXISTS telecus_paid_history ON public.appointments(start_time DESC,id DESC) WHERE payment_status='VERIFIED';
CREATE FUNCTION telecus_integration.payment_history_version() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 1 $$;

ALTER FUNCTION telecus_integration.administration_read(uuid,text,jsonb) RENAME TO admin_read_before014;
REVOKE ALL ON FUNCTION telecus_integration.admin_read_before014(uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;

CREATE FUNCTION telecus_integration.administration_read(p_actor uuid,p_resource text,p_filter jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE offset_n integer:=COALESCE((p_filter->>'offset')::integer,0);query_text text:=lower(trim(COALESCE(p_filter->>'q','')));result jsonb;
BEGIN
 PERFORM telecus_integration.admin_actor(p_actor);
 IF p_resource<>'payments' OR COALESCE(p_filter->>'view','received')<>'history' THEN
  RETURN telecus_integration.admin_read_before014(p_actor,p_resource,p_filter);
 END IF;
 IF offset_n NOT BETWEEN 0 AND 100000 OR length(query_text)>80 THEN RAISE EXCEPTION 'Invalid payment history filter' USING ERRCODE='22023';END IF;
 WITH page AS (
  SELECT a.id AS appointment_id,a.code,a.start_time,a.status::text,a.payment_status::text,
   p.full_name AS patient_name,d.full_name AS doctor_name,
   CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('id',r.id,'file_name',r.file_name,'content_type',r.content_type,'size',r.size,'created_at',r.created_at) END AS receipt
  FROM public.appointments a JOIN public.profiles p ON p.id=a.patient_id JOIN public.profiles d ON d.id=a.doctor_id
  LEFT JOIN telecus_integration.payment_receipts r ON r.appointment_id=a.id AND r.withdrawn_at IS NULL
  WHERE a.payment_status='VERIFIED' AND NOT telecus_integration.is_free_visit(a.id)
   AND (query_text='' OR strpos(lower(a.code||' '||COALESCE(p.full_name,'')||' '||COALESCE(d.full_name,'')),query_text)>0)
  ORDER BY a.start_time DESC,a.id DESC LIMIT 26 OFFSET offset_n
 ),visible AS (SELECT * FROM page ORDER BY start_time DESC,appointment_id DESC LIMIT 25)
 SELECT jsonb_build_object('items',(SELECT COALESCE(jsonb_agg(to_jsonb(v)||jsonb_build_object('processing',false) ORDER BY v.start_time DESC,v.appointment_id DESC),'[]'::jsonb) FROM visible v),
  'next_offset',CASE WHEN (SELECT count(*) FROM page)>25 THEN offset_n+25 ELSE NULL END) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION telecus_integration.payment_history_version(),telecus_integration.administration_read(uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
GRANT EXECUTE ON FUNCTION telecus_integration.payment_history_version(),telecus_integration.administration_read(uuid,text,jsonb) TO telecus_backend;
