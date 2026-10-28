-- 017: criterios de teleconsulta; tipos históricos conservados en registros existentes.
BEGIN;
ALTER TABLE telecus_integration.visit_context DROP CONSTRAINT visit_context_appointment_type_check;
ALTER TABLE telecus_integration.visit_context ADD CONSTRAINT visit_context_appointment_type_check
 CHECK(appointment_type IN ('FOLLOW_UP','RESULTS_REVIEW','NON_URGENT_GUIDANCE','CHRONIC_FOLLOW_UP','GENERAL_CERTIFICATE','REFERRALS_ORDERS','MEDICATION_PRESCRIPTION'));
-- Conserva el envoltorio de permisos y motivos de rechazo instalado por 015.
CREATE OR REPLACE FUNCTION telecus_integration.execute_before015(p_actor uuid,p_id uuid,p_kind text,p_payload jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cfg telecus_integration.portal_configuration;a public.appointments;old telecus_integration.operations;answer text;fresh jsonb;original_payload jsonb:=p_payload;selected_doctor uuid;start_at timestamptz;
BEGIN
 PERFORM telecus_integration.actor(p_actor);PERFORM pg_advisory_xact_lock(hashtextextended('telecus-operation:'||p_id,0));
 SELECT * INTO old FROM telecus_integration.operations WHERE id=p_id;
 IF old.id IS NOT NULL THEN
  IF old.actor_id<>p_actor OR old.kind<>p_kind OR old.payload<>p_payload THEN RAISE EXCEPTION 'Operation mismatch' USING ERRCODE='42501';END IF;
  RETURN old.result;
 END IF;
 IF p_kind='reserve' THEN
  SELECT * INTO cfg FROM telecus_integration.portal_configuration WHERE singleton FOR SHARE;
  IF p_payload->>'visit_policy_version' IS DISTINCT FROM cfg.version::text OR COALESCE(p_payload->>'appointment_type','') NOT IN ('FOLLOW_UP','RESULTS_REVIEW','NON_URGENT_GUIDANCE','REFERRALS_ORDERS','MEDICATION_PRESCRIPTION') THEN RAISE EXCEPTION 'Visit policy changed' USING ERRCODE='P0002';END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('telecus-service-schedule',0));
  start_at:=telecus_integration.interval(p_payload->>'date',p_payload->>'time');
  PERFORM pg_advisory_xact_lock(hashtextextended('telecus-allocation:'||(p_payload->>'date'),0));
  PERFORM telecus_integration.expire_holds();
  SELECT d.id INTO selected_doctor FROM public.profiles d WHERE d.role='DOCTOR' AND d.active AND telecus_integration.slot_free(d.id,start_at,start_at+interval '30 minutes')
  ORDER BY (SELECT count(*) FROM public.appointments x WHERE x.doctor_id=d.id AND x.status NOT IN ('CANCELLED','COMPLETED') AND x.start_time>=((p_payload->>'date')::date::timestamp AT TIME ZONE 'America/Bogota') AND x.start_time<(((p_payload->>'date')::date+1)::timestamp AT TIME ZONE 'America/Bogota')),d.id LIMIT 1;
  IF selected_doctor IS NULL THEN RAISE EXCEPTION 'Slot taken' USING ERRCODE='23P01';END IF;
  p_payload:=p_payload||jsonb_build_object('doctor_id',selected_doctor);
  answer:=telecus_integration.execute_before010(p_actor,p_id,p_kind,p_payload);
  SELECT * INTO a FROM public.appointments WHERE patient_id=p_actor AND doctor_id=(p_payload->>'doctor_id')::uuid AND start_time=((p_payload->>'date')||' '||(p_payload->>'time'))::timestamp AT TIME ZONE 'America/Bogota' AND status='PRE_RESERVED';
  UPDATE telecus_integration.visit_context SET appointment_type=p_payload->>'appointment_type' WHERE appointment_id=a.id;
  UPDATE telecus_integration.operations SET payload=original_payload WHERE id=p_id;
  IF NOT cfg.payments_enabled THEN
   DELETE FROM telecus_integration.reservation_holds WHERE appointment_id=a.id;
   UPDATE public.appointments SET payment_link=NULL WHERE id=a.id;
   answer:='Solicitud gratuita '||a.code||' registrada. Queda pendiente de revisión administrativa. No debes pagar ni enviar comprobantes.';
   UPDATE telecus_integration.operations SET result=answer WHERE id=p_id;
  END IF;
  RETURN answer;
 END IF;
 SELECT * INTO a FROM public.appointments WHERE code=p_payload->>'appointment_code';
 IF p_kind IN ('approve_change','reject_change') THEN SELECT x.* INTO a FROM public.appointments x JOIN public.appointment_change_requests r ON r.appointment_id=x.id WHERE r.id=(p_payload->>'request_id')::uuid;END IF;
 IF p_kind='confirm_free' OR telecus_integration.is_free_visit(a.id) THEN
  IF NOT (p_payload?'expected_snapshot') AND p_kind='confirm_free' THEN RAISE EXCEPTION 'Review required' USING ERRCODE='22023';END IF;
  IF p_payload?'expected_snapshot' THEN
   PERFORM pg_advisory_xact_lock_shared(hashtextextended('telecus-service-schedule',0));fresh:=telecus_integration.staff_snapshot(p_actor,p_kind,p_payload);
   IF fresh->'snapshot' IS DISTINCT FROM p_payload->'expected_snapshot' THEN RAISE EXCEPTION 'Appointment changed' USING ERRCODE='P0002';END IF;
  END IF;
  IF p_kind='reschedule' AND p_payload->>'schedule_version' IS NOT NULL AND p_payload->>'schedule_version' IS DISTINCT FROM (SELECT max(version)::text FROM telecus_integration.service_schedules) THEN RAISE EXCEPTION 'Schedule changed' USING ERRCODE='P0002';END IF;
  RETURN telecus_integration.execute_free010(p_actor,p_id,p_kind,p_payload);
 END IF;
 RETURN telecus_integration.execute_before010(p_actor,p_id,p_kind,p_payload);
END $$;
-- Invalida propuestas creadas con el catálogo previo.
UPDATE telecus_integration.portal_configuration SET version=version+1 WHERE singleton;
COMMIT;
