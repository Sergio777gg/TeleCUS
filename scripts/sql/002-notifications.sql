-- Additive migration. Existing tables, data, constraints and RLS policies remain intact.
-- Business events and recipient inbox entries commit in the SAME agenda transaction.
CREATE TABLE IF NOT EXISTS telecus_integration.notification_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_key text NOT NULL UNIQUE,
 event_type text NOT NULL CHECK(event_type IN ('appointment_requested','appointment_confirmed','appointment_rescheduled','appointment_cancelled','appointment_completed','doctor_assigned','appointment_unassigned','change_requested','change_approved','change_rejected','integration_attention')),
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telecus_integration.notifications (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_id bigint NOT NULL REFERENCES telecus_integration.notification_events(id),
 recipient_id uuid NOT NULL REFERENCES public.profiles(id),
 recipient_role text NOT NULL CHECK(recipient_role IN ('PATIENT','ADMIN','DOCTOR')),
 read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(event_id,recipient_id,recipient_role)
);
CREATE INDEX IF NOT EXISTS notifications_inbox ON telecus_integration.notifications(recipient_id,recipient_role,id DESC);
CREATE INDEX IF NOT EXISTS notifications_unread ON telecus_integration.notifications(recipient_id,recipient_role,id DESC) WHERE read_at IS NULL;
REVOKE ALL ON telecus_integration.notification_events,telecus_integration.notifications FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
REVOKE ALL ON SEQUENCE telecus_integration.notification_events_id_seq,telecus_integration.notifications_id_seq FROM PUBLIC,anon,authenticated,service_role,telecus_backend;

CREATE OR REPLACE FUNCTION telecus_integration.notification_version() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 1 $$;

CREATE OR REPLACE FUNCTION telecus_integration.publish_notification(p_key text,p_type text,p_appointment uuid,p_request uuid DEFAULT NULL,p_doctor uuid DEFAULT NULL,p_only_doctor boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public.appointments; r public.appointment_change_requests; event_id bigint; data jsonb;
BEGIN
 SELECT * INTO a FROM public.appointments WHERE id=p_appointment;
 IF a.id IS NULL THEN RETURN; END IF;
 IF p_request IS NOT NULL THEN SELECT * INTO r FROM public.appointment_change_requests WHERE id=p_request; END IF;
 -- No reason, patient names, email addresses, Meet links or clinical data in the inbox.
 data:=jsonb_build_object('code',a.code,'start_time',a.start_time,'request_type',r.request_type);
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
   ELSIF NEW.payment_status='VERIFIED' AND NEW.status IN ('CONFIRMED','RESCHEDULED') THEN kind:='appointment_confirmed'; END IF;
 ELSE
   IF NEW.status='CANCELLED' AND OLD.status IS DISTINCT FROM NEW.status THEN kind:='appointment_cancelled';
   ELSIF NEW.status='COMPLETED' AND OLD.status IS DISTINCT FROM NEW.status THEN kind:='appointment_completed';
   ELSIF NEW.payment_status='VERIFIED' AND NEW.status IN ('CONFIRMED','RESCHEDULED') THEN
     IF OLD.payment_status IS DISTINCT FROM NEW.payment_status OR (OLD.status IS DISTINCT FROM NEW.status AND NEW.status='CONFIRMED') THEN kind:='appointment_confirmed';
     ELSIF OLD.start_time IS DISTINCT FROM NEW.start_time OR OLD.end_time IS DISTINCT FROM NEW.end_time THEN kind:='appointment_rescheduled';
     ELSIF OLD.doctor_id IS DISTINCT FROM NEW.doctor_id THEN kind:='doctor_assigned'; END IF;
   END IF;
   IF OLD.doctor_id IS DISTINCT FROM NEW.doctor_id AND OLD.payment_status='VERIFIED' AND OLD.status IN ('CONFIRMED','RESCHEDULED') THEN
     PERFORM telecus_integration.publish_notification(key||':removed','appointment_unassigned',NEW.id,NULL,OLD.doctor_id,true);
   END IF;
 END IF;
 IF kind IS NOT NULL THEN
   IF NEW.payment_status='VERIFIED' THEN physician:=NEW.doctor_id; END IF;
   PERFORM telecus_integration.publish_notification(key,kind,NEW.id,NULL,physician);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS telecus_appointment_notifications ON public.appointments;
CREATE TRIGGER telecus_appointment_notifications AFTER INSERT OR UPDATE ON public.appointments
FOR EACH ROW EXECUTE FUNCTION telecus_integration.appointment_notification_trigger();

CREATE OR REPLACE FUNCTION telecus_integration.change_notification_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE kind text;
BEGIN
 IF TG_OP='INSERT' AND NEW.status='PENDING' THEN kind:='change_requested';
 ELSIF TG_OP='UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
   IF NEW.status='APPROVED' THEN kind:='change_approved'; ELSIF NEW.status='REJECTED' THEN kind:='change_rejected'; END IF;
 END IF;
 IF kind IS NOT NULL THEN PERFORM telecus_integration.publish_notification(NEW.id::text||':'||kind,kind,NEW.appointment_id,NEW.id); END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS telecus_change_notifications ON public.appointment_change_requests;
CREATE TRIGGER telecus_change_notifications AFTER INSERT OR UPDATE ON public.appointment_change_requests
FOR EACH ROW EXECUTE FUNCTION telecus_integration.change_notification_trigger();

CREATE OR REPLACE FUNCTION telecus_integration.delivery_notification_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE event_id bigint;
BEGIN
 IF NEW.status='review' AND OLD.status IS DISTINCT FROM NEW.status THEN
   INSERT INTO telecus_integration.notification_events(event_key,event_type,payload)
   SELECT NEW.id::text||':review','integration_attention',jsonb_build_object('code',a.code,'stage',NEW.stage)
   FROM public.appointments a WHERE a.id=NEW.appointment_id ON CONFLICT(event_key) DO NOTHING RETURNING id INTO event_id;
   IF event_id IS NOT NULL THEN
     INSERT INTO telecus_integration.notifications(event_id,recipient_id,recipient_role)
     SELECT event_id,id,role FROM public.profiles WHERE active AND role='ADMIN' ON CONFLICT DO NOTHING;
   END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS telecus_delivery_notifications ON telecus_integration.deliveries;
CREATE TRIGGER telecus_delivery_notifications AFTER UPDATE ON telecus_integration.deliveries
FOR EACH ROW EXECUTE FUNCTION telecus_integration.delivery_notification_trigger();

CREATE OR REPLACE FUNCTION telecus_integration.list_notifications(p_actor uuid,p_before bigint,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles; items jsonb; cursor bigint;
BEGIN
 actor:=telecus_integration.actor(p_actor);
 IF p_limit NOT BETWEEN 1 AND 50 OR (p_before IS NOT NULL AND p_before<1) THEN RAISE EXCEPTION 'Invalid pagination' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(jsonb_agg(x ORDER BY x.id::bigint DESC),'[]'::jsonb),min(x.id::bigint) INTO items,cursor FROM
 (SELECT n.id::text,n.created_at,n.read_at,e.event_type,e.payload FROM telecus_integration.notifications n JOIN telecus_integration.notification_events e ON e.id=n.event_id
 WHERE n.recipient_id=p_actor AND n.recipient_role=actor.role AND (p_before IS NULL OR n.id<p_before) ORDER BY n.id DESC LIMIT p_limit) x;
 RETURN jsonb_build_object('items',items,'unread',(SELECT count(*) FROM telecus_integration.notifications WHERE recipient_id=p_actor AND recipient_role=actor.role AND read_at IS NULL),
 'next_cursor',CASE WHEN EXISTS(SELECT 1 FROM telecus_integration.notifications WHERE recipient_id=p_actor AND recipient_role=actor.role AND id<cursor) THEN cursor::text ELSE NULL END);
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.read_notifications(p_actor uuid,p_ids jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles; total integer;
BEGIN
 actor:=telecus_integration.actor(p_actor);
 IF jsonb_typeof(p_ids)<>'array' OR jsonb_array_length(p_ids)>50 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_ids) x WHERE x !~ '^[1-9][0-9]{0,17}$') THEN RAISE EXCEPTION 'Invalid notification ids' USING ERRCODE='22023'; END IF;
 UPDATE telecus_integration.notifications SET read_at=COALESCE(read_at,now()) WHERE recipient_id=p_actor AND recipient_role=actor.role AND id IN (SELECT x::bigint FROM jsonb_array_elements_text(p_ids) x);
 GET DIAGNOSTICS total=ROW_COUNT; RETURN total;
END $$;
REVOKE ALL ON FUNCTION telecus_integration.notification_version(),telecus_integration.publish_notification(text,text,uuid,uuid,uuid,boolean),telecus_integration.appointment_notification_trigger(),telecus_integration.change_notification_trigger(),telecus_integration.delivery_notification_trigger(),telecus_integration.list_notifications(uuid,bigint,integer),telecus_integration.read_notifications(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
GRANT EXECUTE ON FUNCTION telecus_integration.notification_version(),telecus_integration.list_notifications(uuid,bigint,integer),telecus_integration.read_notifications(uuid,jsonb) TO telecus_backend;
