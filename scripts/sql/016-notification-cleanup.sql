CREATE TABLE telecus_integration.notification_cleanup(id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES public.profiles(id),role text NOT NULL,payload jsonb NOT NULL,total integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE telecus_integration.notification_dismissals(notification_id bigint PRIMARY KEY REFERENCES telecus_integration.notifications(id) ON DELETE CASCADE,actor_id uuid NOT NULL,role text NOT NULL,batch uuid NOT NULL REFERENCES telecus_integration.notification_cleanup(id));
CREATE INDEX telecus_notification_undo ON telecus_integration.notification_dismissals(actor_id,role,batch);
REVOKE ALL ON telecus_integration.notification_cleanup,telecus_integration.notification_dismissals FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
CREATE FUNCTION telecus_integration.notification_actions_version() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 1 $$;
CREATE FUNCTION telecus_integration.dismiss_notifications(p_actor uuid,p_ids jsonb,p_read boolean,p_batch uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE who public.profiles;previous telecus_integration.notification_cleanup;total integer;payload jsonb:=jsonb_build_object('ids',p_ids,'read',p_read);
BEGIN
 who:=telecus_integration.actor(p_actor);
 IF p_batch IS NULL OR p_read IS NULL OR jsonb_typeof(p_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(p_ids)>50 OR p_read AND jsonb_array_length(p_ids)>0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_ids) x WHERE x !~ '^[1-9][0-9]{0,17}$') THEN RAISE EXCEPTION 'Invalid cleanup request' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('notifications:'||p_batch,0));SELECT * INTO previous FROM telecus_integration.notification_cleanup WHERE id=p_batch;
 IF previous.id IS NOT NULL THEN
  IF previous.actor_id<>p_actor OR previous.role<>who.role OR previous.payload<>payload THEN RAISE EXCEPTION 'Cleanup mismatch' USING ERRCODE='42501';END IF;RETURN previous.total;
 END IF;
 INSERT INTO telecus_integration.notification_cleanup(id,actor_id,role,payload) VALUES(p_batch,p_actor,who.role,payload);
 INSERT INTO telecus_integration.notification_dismissals(notification_id,actor_id,role,batch)
 SELECT n.id,p_actor,who.role,p_batch FROM telecus_integration.notifications n WHERE n.recipient_id=p_actor AND n.recipient_role=who.role AND ((p_read AND n.read_at IS NOT NULL) OR (NOT p_read AND p_ids ? n.id::text)) ON CONFLICT(notification_id) DO NOTHING;
 GET DIAGNOSTICS total=ROW_COUNT;UPDATE telecus_integration.notification_cleanup SET total=(SELECT count(*) FROM telecus_integration.notification_dismissals d WHERE d.batch=p_batch) WHERE id=p_batch;
 RETURN total;
END $$;
CREATE FUNCTION telecus_integration.restore_notifications(p_actor uuid,p_batch uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE who public.profiles;total integer;
BEGIN
 who:=telecus_integration.actor(p_actor);PERFORM pg_advisory_xact_lock(hashtextextended('notifications:'||p_batch,0));
 IF NOT EXISTS(SELECT 1 FROM telecus_integration.notification_cleanup WHERE id=p_batch AND actor_id=p_actor AND role=who.role) THEN RAISE EXCEPTION 'Forbidden cleanup' USING ERRCODE='42501';END IF;
 DELETE FROM telecus_integration.notification_dismissals WHERE batch=p_batch AND actor_id=p_actor AND role=who.role;GET DIAGNOSTICS total=ROW_COUNT;RETURN total;
END $$;
CREATE OR REPLACE FUNCTION telecus_integration.list_notifications(p_actor uuid,p_before bigint,p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE who public.profiles;items jsonb;cursor bigint;
BEGIN
 who:=telecus_integration.actor(p_actor);IF p_limit NOT BETWEEN 1 AND 50 OR p_before<1 THEN RAISE EXCEPTION 'Invalid pagination' USING ERRCODE='22023';END IF;
 SELECT COALESCE(jsonb_agg(x ORDER BY x.id::bigint DESC),'[]'),min(x.id::bigint) INTO items,cursor FROM (SELECT n.id::text,n.created_at,n.read_at,e.event_type,e.payload FROM telecus_integration.notifications n JOIN telecus_integration.notification_events e ON e.id=n.event_id WHERE n.recipient_id=p_actor AND n.recipient_role=who.role AND (p_before IS NULL OR n.id<p_before) AND NOT EXISTS(SELECT 1 FROM telecus_integration.notification_dismissals d WHERE d.notification_id=n.id) ORDER BY n.id DESC LIMIT p_limit) x;
 RETURN jsonb_build_object('items',items,'unread',(SELECT count(*) FROM telecus_integration.notifications n WHERE recipient_id=p_actor AND recipient_role=who.role AND read_at IS NULL AND NOT EXISTS(SELECT 1 FROM telecus_integration.notification_dismissals d WHERE d.notification_id=n.id)),
 'read_count',(SELECT count(*) FROM telecus_integration.notifications n WHERE recipient_id=p_actor AND recipient_role=who.role AND read_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM telecus_integration.notification_dismissals d WHERE d.notification_id=n.id)),
 'next_cursor',CASE WHEN EXISTS(SELECT 1 FROM telecus_integration.notifications n WHERE recipient_id=p_actor AND recipient_role=who.role AND n.id<cursor AND NOT EXISTS(SELECT 1 FROM telecus_integration.notification_dismissals d WHERE d.notification_id=n.id)) THEN cursor::text ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION telecus_integration.notification_actions_version(),telecus_integration.dismiss_notifications(uuid,jsonb,boolean,uuid),telecus_integration.restore_notifications(uuid,uuid),telecus_integration.list_notifications(uuid,bigint,integer) FROM PUBLIC,anon,authenticated,service_role,telecus_backend;
GRANT EXECUTE ON FUNCTION telecus_integration.notification_actions_version(),telecus_integration.dismiss_notifications(uuid,jsonb,boolean,uuid),telecus_integration.restore_notifications(uuid,uuid),telecus_integration.list_notifications(uuid,bigint,integer) TO telecus_backend;
