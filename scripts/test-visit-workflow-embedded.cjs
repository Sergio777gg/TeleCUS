// Disposable PostgreSQL engine. This is not a Supabase/Google integration test.
const fs=require('node:fs/promises'),path=require('node:path');process.chdir(path.resolve(__dirname,'..'));
async function main(){
 const modulePath=process.argv[2];if(!modulePath)throw Error('Provide the separately installed @electric-sql/pglite module directory.');
 const {PGlite}=require(path.resolve(modulePath)),db=new PGlite();const client={query:async(sql,args=[])=>args.length?db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]}};
 try{
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,created_at timestamptz,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
 CREATE TABLE public.profiles(id uuid PRIMARY KEY,role text NOT NULL DEFAULT 'PATIENT',active boolean NOT NULL DEFAULT true,full_name text,email text,created_at timestamptz DEFAULT now());
 CREATE FUNCTION auth.test_profile() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN INSERT INTO public.profiles(id,email) VALUES(NEW.id,NEW.email);RETURN NEW;END$$;CREATE TRIGGER test_profile AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION auth.test_profile();
 CREATE TABLE public.appointments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text UNIQUE DEFAULT 'TCUS-'||upper(gen_random_uuid()::text),patient_id uuid NOT NULL REFERENCES public.profiles(id),doctor_id uuid NOT NULL REFERENCES public.profiles(id),start_time timestamptz NOT NULL,end_time timestamptz NOT NULL,reason text,status text NOT NULL DEFAULT 'PRE_RESERVED' CHECK(status IN ('PRE_RESERVED','CONFIRMED','RESCHEDULED','CANCELLED','COMPLETED')),payment_status text NOT NULL DEFAULT 'PENDING' CHECK(payment_status IN ('PENDING','VERIFIED')),payment_link text,calendar_event_id text,meet_url text,completed_at timestamptz,completed_by uuid,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 CREATE UNIQUE INDEX one_active_appointment_per_patient ON public.appointments(patient_id) WHERE status IN ('PRE_RESERVED','CONFIRMED','RESCHEDULED');
 CREATE TABLE public.appointment_change_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),appointment_id uuid REFERENCES public.appointments(id),patient_id uuid REFERENCES public.profiles(id),request_type text,requested_start_time timestamptz,requested_end_time timestamptz,status text DEFAULT 'PENDING',reason text,reviewed_by uuid,reviewed_at timestamptz,decision_note text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 CREATE TABLE public.appointment_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),appointment_id uuid,actor_user_id uuid,action text,details jsonb,created_at timestamptz DEFAULT now());
 ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;ALTER TABLE public.appointment_change_requests ENABLE ROW LEVEL SECURITY;ALTER TABLE public.appointment_logs ENABLE ROW LEVEL SECURITY;`);
 for(const name of ['001-agenda-integration','002-notifications','003-notification-inputs','004-payment-receipts','005-administration','006-service-schedule','007-staff-workspace','008-read-only-queries','009-payment-inbox'])await db.exec(await fs.readFile('scripts/sql/'+name+'.sql','utf8'));
 console.log(JSON.stringify(await require('./test-visit-workflow-db.cjs').run(client,{embedded:true})));
 }finally{await db.close();}
}
main().catch(e=>{console.error(JSON.stringify({status:'failed',stage:e.stage,checks:e.checks,code:e.code||e.name,detail:e.message,context:e.where}));process.exitCode=1;});
