-- Queries do not expire business records. Maintenance runs in its worker and reservation writes.
CREATE OR REPLACE FUNCTION telecus_integration.availability(p_actor uuid,p_doctor uuid,p_date text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor public.profiles;p telecus_integration.service_schedules;t timestamp;start_at timestamptz;result jsonb:='[]';
BEGIN
 actor:=telecus_integration.actor(p_actor);IF actor.role NOT IN ('PATIENT','ADMIN') THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';END IF;
 IF p_date IS NULL OR p_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'Invalid date' USING ERRCODE='22023';END IF;
 BEGIN p:=telecus_integration.schedule_for(p_date::date);EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid date' USING ERRCODE='22023';END;
 FOR t IN SELECT s FROM generate_series(p_date::date+p.start_time,p_date::date+p.end_time-interval '30 minutes',interval '30 minutes') s LOOP
  BEGIN start_at:=telecus_integration.interval(p_date,to_char(t,'HH24:MI'));EXCEPTION WHEN SQLSTATE '22023' THEN CONTINUE;END;
  IF telecus_integration.slot_free(p_doctor,start_at,start_at+interval '30 minutes') THEN result:=result||to_jsonb(to_char(t,'HH24:MI'));END IF;
 END LOOP;RETURN result;
END $$;


CREATE OR REPLACE FUNCTION telecus_integration.list_payment_receipts(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE page jsonb;
BEGIN
 page:=telecus_integration.list_receipts_before006(p_actor);
 RETURN page||jsonb_build_object('items',(SELECT COALESCE(jsonb_agg(item||COALESCE(telecus_integration.hold_info((item->>'appointment_id')::uuid),'{}')),'[]') FROM jsonb_array_elements(page->'items') item));
END $$;

CREATE OR REPLACE FUNCTION telecus_integration.administration_read(p_actor uuid,p_resource text,p_filter jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE page jsonb;
BEGIN
 PERFORM telecus_integration.admin_actor(p_actor);
 page:=telecus_integration.admin_read_before006(p_actor,p_resource,p_filter);
 IF p_resource='payments' THEN RETURN page||jsonb_build_object('items',(SELECT COALESCE(jsonb_agg(item||COALESCE(telecus_integration.hold_info((item->>'appointment_id')::uuid),'{}')),'[]') FROM jsonb_array_elements(page->'items') item));END IF;
 RETURN page;
END $$;
