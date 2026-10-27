-- Harden function inputs independently of the HTTP validation. No changes to agenda data.
CREATE OR REPLACE FUNCTION telecus_integration.list_notifications(p_actor uuid,p_before bigint,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles; items jsonb; cursor bigint;
BEGIN
 actor:=telecus_integration.actor(p_actor);
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR (p_before IS NOT NULL AND p_before<1) THEN RAISE EXCEPTION 'Invalid pagination' USING ERRCODE='22023'; END IF;
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
 IF p_ids IS NULL OR jsonb_typeof(p_ids)<>'array' THEN RAISE EXCEPTION 'Invalid notification ids' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(p_ids)>50 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_ids) x WHERE x IS NULL OR x !~ '^[1-9][0-9]{0,17}$') THEN RAISE EXCEPTION 'Invalid notification ids' USING ERRCODE='22023'; END IF;
 UPDATE telecus_integration.notifications SET read_at=COALESCE(read_at,now()) WHERE recipient_id=p_actor AND recipient_role=actor.role AND id IN (SELECT x::bigint FROM jsonb_array_elements_text(p_ids) x);
 GET DIAGNOSTICS total=ROW_COUNT; RETURN total;
END $$;
CREATE OR REPLACE FUNCTION telecus_integration.notification_version() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 2 $$;
REVOKE ALL ON FUNCTION telecus_integration.notification_version(),telecus_integration.list_notifications(uuid,bigint,integer),telecus_integration.read_notifications(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION telecus_integration.notification_version(),telecus_integration.list_notifications(uuid,bigint,integer),telecus_integration.read_notifications(uuid,jsonb) TO telecus_backend;
