CREATE TABLE telecus_integration.public_rejections (
 request_id uuid PRIMARY KEY REFERENCES public.appointment_change_requests(id),category text NOT NULL,
 message text NOT NULL CHECK(length(message) BETWEEN 20 AND 300),actor_id uuid REFERENCES public.profiles(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION telecus_integration.publish_notification(p_key text,p_type text,p_appointment uuid,p_request uuid DEFAULT NULL,p_doctor uuid DEFAULT NULL,p_only_doctor boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public.appointments; r public.appointment_change_requests; event_id bigint; data jsonb;
BEGIN
 SELECT * INTO a FROM public.appointments WHERE id=p_appointment;
 IF a.id IS NULL THEN RETURN; END IF;
 IF p_request IS NOT NULL THEN SELECT * INTO r FROM public.appointment_change_requests WHERE id=p_request; END IF;
 -- No reason, patient names, email addresses, Meet links or clinical data in the inbox.
 data:=jsonb_build_object('code',a.code,'start_time',a.start_time,'request_type',r.request_type,'payment_required',NOT telecus_integration.is_free_visit(a.id),'reason',CASE WHEN EXISTS(SELECT 1 FROM telecus_integration.reservation_holds h WHERE h.appointment_id=a.id AND h.expired_at IS NOT NULL) THEN 'reservation_expired' END);
 IF p_type='change_rejected' THEN data:=data||jsonb_build_object('public_reason',(SELECT message FROM telecus_integration.public_rejections WHERE request_id=p_request));END IF;
 INSERT INTO telecus_integration.notification_events(event_key,event_type,payload) VALUES(p_key,p_type,data)
 ON CONFLICT(event_key) DO NOTHING RETURNING id INTO event_id;
 IF event_id IS NULL THEN RETURN; END IF;
 INSERT INTO telecus_integration.notifications(event_id,recipient_id,recipient_role)
 SELECT event_id,p.id,p.role FROM public.profiles p WHERE p.active AND
 ((NOT p_only_doctor AND ((p.role='ADMIN' AND NOT (p_type='appointment_cancelled' AND EXISTS(SELECT 1 FROM public.appointment_change_requests pending WHERE pending.appointment_id=a.id AND pending.request_type='CANCEL' AND pending.status='PENDING'))) OR (p.role='PATIENT' AND p.id=a.patient_id)))
 OR (p.role='DOCTOR' AND p.id=p_doctor)) ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON telecus_integration.public_rejections FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
CREATE FUNCTION telecus_integration.rejection_reasons_version() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 1 $$;
CREATE FUNCTION telecus_integration.public_rejections(p_actor uuid,p_ids jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE who public.profiles;result jsonb;
BEGIN
 who:=telecus_integration.actor(p_actor);IF who.role NOT IN ('PATIENT','ADMIN') THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(p_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(p_ids)>100 THEN RAISE EXCEPTION 'Invalid references' USING ERRCODE='22023';END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('request_id',d.request_id,'rejection_category',d.category,'public_reason',d.message)),'[]') INTO result FROM telecus_integration.public_rejections d JOIN public.appointment_change_requests r ON r.id=d.request_id WHERE r.status='REJECTED' AND p_ids ? r.id::text AND (who.role='ADMIN' OR r.patient_id=p_actor);
 RETURN result;
END $$;
ALTER FUNCTION telecus_integration.execute(uuid,uuid,text,jsonb) RENAME TO execute_before015;
REVOKE ALL ON FUNCTION telecus_integration.execute_before015(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
CREATE FUNCTION telecus_integration.execute(p_actor uuid,p_id uuid,p_kind text,p_payload jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE who public.profiles;request public.appointment_change_requests;category text:=p_payload->>'rejection_category';message text:=trim(p_payload->>'public_reason');
BEGIN
 who:=telecus_integration.actor(p_actor);IF p_id IS NULL THEN RAISE EXCEPTION 'Missing command' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('telecus-operation:'||p_id,0));
 IF EXISTS(SELECT 1 FROM telecus_integration.operations WHERE id=p_id) THEN RETURN telecus_integration.execute_before015(p_actor,p_id,p_kind,p_payload);END IF;
 IF p_kind='reject_change' THEN
  IF who.role<>'ADMIN' THEN RAISE EXCEPTION 'Admin required' USING ERRCODE='42501';END IF;
  IF category IS NULL OR category NOT IN ('availability','information','duplicate','service_rules','other') OR message IS NULL OR length(message) NOT BETWEEN 20 AND 300 OR message ~ '[[:cntrl:]]' OR message !~ '[[:alpha:]]' OR cardinality(string_to_array(regexp_replace(message,'[[:space:]]+',' ','g'),' '))<3 THEN RAISE EXCEPTION 'A public rejection reason is required' USING ERRCODE='22023';END IF;
  SELECT * INTO request FROM public.appointment_change_requests WHERE id=(p_payload->>'request_id')::uuid FOR UPDATE;
  IF request.id IS NULL OR request.status<>'PENDING' THEN RAISE EXCEPTION 'Request changed' USING ERRCODE='P0002';END IF;
  INSERT INTO telecus_integration.public_rejections(request_id,category,message,actor_id) VALUES(request.id,category,message,p_actor);
 END IF;
 RETURN telecus_integration.execute_before015(p_actor,p_id,p_kind,p_payload);
END $$;
CREATE FUNCTION telecus_integration.require_public_rejection() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE appointment public.appointments;
BEGIN
 IF NEW.status='REJECTED' AND OLD.status IS DISTINCT FROM NEW.status AND NOT EXISTS(SELECT 1 FROM telecus_integration.public_rejections WHERE request_id=NEW.id) THEN
  SELECT * INTO appointment FROM public.appointments WHERE id=NEW.appointment_id;
  IF appointment.status IN ('CANCELLED','COMPLETED') THEN
   INSERT INTO telecus_integration.public_rejections(request_id,category,message,actor_id) VALUES(NEW.id,'appointment_closed','La cita ya fue cancelada o finalizada; esta solicitud de cambio dejó de corresponder.',NEW.reviewed_by);
  ELSE RAISE EXCEPTION 'A public rejection reason is required' USING ERRCODE='22023';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER telecus_public_rejection BEFORE UPDATE OF status ON public.appointment_change_requests FOR EACH ROW EXECUTE FUNCTION telecus_integration.require_public_rejection();
ALTER FUNCTION telecus_integration.workspace_requests(uuid,jsonb) RENAME TO workspace_requests_before015;
REVOKE ALL ON FUNCTION telecus_integration.workspace_requests_before015(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
CREATE FUNCTION telecus_integration.workspace_requests(p_actor uuid,p_filter jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE page jsonb;
BEGIN
 PERFORM telecus_integration.admin_actor(p_actor);page:=telecus_integration.workspace_requests_before015(p_actor,p_filter);
 RETURN page||jsonb_build_object('items',(SELECT COALESCE(jsonb_agg(item||CASE WHEN d.request_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('public_reason',d.message,'rejection_category',d.category) END ORDER BY ord),'[]') FROM jsonb_array_elements(page->'items') WITH ORDINALITY x(item,ord) LEFT JOIN telecus_integration.public_rejections d ON d.request_id=(item->>'id')::uuid));
END $$;
REVOKE ALL ON FUNCTION telecus_integration.rejection_reasons_version(),telecus_integration.public_rejections(uuid,jsonb),telecus_integration.require_public_rejection(),telecus_integration.execute(uuid,uuid,text,jsonb),telecus_integration.workspace_requests(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
GRANT EXECUTE ON FUNCTION telecus_integration.rejection_reasons_version(),telecus_integration.public_rejections(uuid,jsonb),telecus_integration.execute(uuid,uuid,text,jsonb),telecus_integration.workspace_requests(uuid,jsonb) TO telecus_backend;
