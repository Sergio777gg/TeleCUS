-- Solo consulta metadatos: no modifica tablas ni obtiene filas de pacientes.
-- Ejecutar en el SQL Editor del proyecto Supabase existente.
-- Devuelve una sola celda: copiar su contenido o exportar el resultado.
WITH columns_info AS (
 SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default
 FROM information_schema.columns
 WHERE table_schema='public' AND table_name IN
 ('profiles','appointments','appointment_logs','appointment_change_requests','appointment_details','appointment_change_request_details')
 ORDER BY table_name,ordinal_position
), constraints_info AS (
 SELECT c.relname AS table_name,con.conname,con.contype,pg_get_constraintdef(con.oid) AS definition
 FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN ('profiles','appointments','appointment_logs','appointment_change_requests')
 ORDER BY c.relname,con.conname
), policies_info AS (
 SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies
 WHERE schemaname='public' AND tablename IN ('profiles','appointments','appointment_logs','appointment_change_requests')
 ORDER BY tablename,policyname
), security_info AS (
 SELECT c.relname AS table_name,c.relrowsecurity AS rls_enabled,c.relforcerowsecurity AS rls_forced
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN ('profiles','appointments','appointment_logs','appointment_change_requests')
), triggers_info AS (
 SELECT n.nspname AS schema_name,c.relname AS table_name,t.tgname AS trigger_name,
 pg_get_triggerdef(t.oid) AS definition,pg_get_functiondef(t.tgfoid) AS function_definition
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE NOT t.tgisinternal AND ((n.nspname='public' AND c.relname IN ('profiles','appointments','appointment_logs','appointment_change_requests')) OR (n.nspname='auth' AND c.relname='users'))
 ORDER BY n.nspname,c.relname,t.tgname
), views_info AS (
 SELECT v.viewname,v.definition,c.reloptions,pg_get_userbyid(c.relowner) AS owner,
 COALESCE('security_invoker=true'=ANY(c.reloptions),false) AS security_invoker
 FROM pg_views v JOIN pg_namespace n ON n.nspname=v.schemaname
 JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=v.viewname
 WHERE v.schemaname='public' AND v.viewname IN ('appointment_details','appointment_change_request_details')
), indexes_info AS (
 SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('profiles','appointments','appointment_logs','appointment_change_requests')
 ORDER BY tablename,indexname
), enums_info AS (
 SELECT t.typname AS enum_type,e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace
 WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder
), public_functions AS (
 SELECT p.oid,p.proname,CASE WHEN p.prokind IN ('f','p') THEN pg_get_functiondef(p.oid) ELSE NULL END AS definition
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
), functions_info AS (
 SELECT * FROM public_functions WHERE definition ~* '(appointments|profiles|appointment_change_requests)'
 OR (definition IS NOT NULL AND (proname ~* '(appointment|profile)' OR proname IN ('handle_new_user','current_user_role','set_updated_at')))
), table_privileges_info AS (
 SELECT c.relname AS object_name,
 CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS grantee,
 pg_get_userbyid(a.grantor)::text AS grantor,a.privilege_type,a.is_grantable
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
 WHERE n.nspname='public' AND c.relname IN
 ('profiles','appointments','appointment_logs','appointment_change_requests','appointment_details','appointment_change_request_details')
 ORDER BY c.relname,grantee,a.privilege_type
), function_privileges_info AS (
 SELECT p.proname AS function_name,pg_get_function_identity_arguments(p.oid) AS arguments,
 CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS grantee,
 pg_get_userbyid(a.grantor)::text AS grantor,a.privilege_type,a.is_grantable
 FROM pg_proc p JOIN functions_info f ON f.oid=p.oid
 CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
 ORDER BY p.proname,arguments,grantee
), objects_info AS (
 SELECT x.object_name,c.relkind AS actual_kind,c.oid IS NOT NULL AS exists_in_database
 FROM (VALUES ('profiles'),('appointments'),('appointment_logs'),('appointment_change_requests'),
 ('appointment_details'),('appointment_change_request_details')) x(object_name)
 LEFT JOIN pg_namespace n ON n.nspname='public'
 LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=x.object_name
 ORDER BY x.object_name
)
SELECT jsonb_pretty(jsonb_build_object(
 'columns',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM columns_info x),'[]'::jsonb),
 'constraints',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM constraints_info x),'[]'::jsonb),
 'policies',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM policies_info x),'[]'::jsonb),
 'security',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM security_info x),'[]'::jsonb),
 'triggers',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM triggers_info x),'[]'::jsonb),
 'views',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM views_info x),'[]'::jsonb),
 'indexes',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM indexes_info x),'[]'::jsonb),
 'enums',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM enums_info x),'[]'::jsonb),
 'functions',COALESCE((SELECT jsonb_agg(to_jsonb(x)-'oid') FROM functions_info x),'[]'::jsonb),
 'table_privileges',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM table_privileges_info x),'[]'::jsonb),
 'function_privileges',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM function_privileges_info x),'[]'::jsonb),
 'objects',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM objects_info x),'[]'::jsonb)
)) AS telecus_schema;
