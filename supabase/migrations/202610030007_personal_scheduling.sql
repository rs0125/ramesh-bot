-- Personal intent outlives message retention. Never alters legacy task/reminder tables.
CREATE TABLE public."ramesh-tasks" (
 id uuid PRIMARY KEY,account_id text NOT NULL,owner_employee_id integer NOT NULL CHECK(owner_employee_id>0),
 text_encrypted text NOT NULL CHECK(octet_length(text_encrypted)<=32768),
 state text NOT NULL DEFAULT 'open' CHECK(state IN('open','done','cancelled')),
 deadline jsonb,version integer NOT NULL DEFAULT 1 CHECK(version>0),creation_command_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 UNIQUE(account_id,id),UNIQUE(account_id,creation_command_key)
);
CREATE INDEX "ramesh-tasks-owner" ON public."ramesh-tasks"(account_id,owner_employee_id,state,created_at,id);
CREATE TABLE public."ramesh-reminders" (
 id uuid PRIMARY KEY,account_id text NOT NULL,owner_employee_id integer NOT NULL CHECK(owner_employee_id>0),
 recipient_phone_e164 text NOT NULL CHECK(recipient_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),recipient_chat_id text NOT NULL,
 text_encrypted text NOT NULL CHECK(octet_length(text_encrypted)<=32768),
 task_id uuid,state text NOT NULL DEFAULT 'scheduled' CHECK(state IN('scheduled','completed','cancelled')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),schedule jsonb NOT NULL,
 next_due_at timestamptz,consumed boolean NOT NULL DEFAULT false,dispatch_counter integer NOT NULL DEFAULT 0 CHECK(dispatch_counter>=0),
 creation_command_key text NOT NULL,last_outcome text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 UNIQUE(account_id,id),UNIQUE(account_id,creation_command_key),
 FOREIGN KEY(account_id,task_id) REFERENCES public."ramesh-tasks"(account_id,id)
);
CREATE INDEX "ramesh-reminders-owner" ON public."ramesh-reminders"(account_id,owner_employee_id,state,created_at,id);
CREATE INDEX "ramesh-reminders-due" ON public."ramesh-reminders"(account_id,next_due_at) WHERE state='scheduled' AND next_due_at IS NOT NULL;
CREATE TABLE public."ramesh-reminder-occurrences" (
 id uuid PRIMARY KEY,account_id text NOT NULL,reminder_id uuid NOT NULL,schedule_version integer NOT NULL CHECK(schedule_version>0),
 slot_key timestamptz NOT NULL,dispatch_generation integer NOT NULL DEFAULT 0 CHECK(dispatch_generation>=0),
 scheduled_for timestamptz NOT NULL,eligible_at timestamptz NOT NULL,not_after timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','preparing','waiting_source','queued','sent','cancelled','missed','failed','uncertain','suppressed')),
 lease_token uuid,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),next_attempt_at timestamptz NOT NULL,
 recipient_employee_id integer NOT NULL CHECK(recipient_employee_id>0),recipient_phone_e164 text NOT NULL,recipient_chat_id text NOT NULL,
 outbound_message_id uuid REFERENCES public."ramesh-messages"(id) ON DELETE SET NULL,
 reason_code text CHECK(length(reason_code)<=64),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 FOREIGN KEY(account_id,reminder_id) REFERENCES public."ramesh-reminders"(account_id,id),
 UNIQUE(account_id,reminder_id,schedule_version,slot_key,dispatch_generation),
 UNIQUE(outbound_message_id),CHECK(not_after>eligible_at),
 CHECK((state='preparing' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (state<>'preparing' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX "ramesh-reminder-occurrences-due" ON public."ramesh-reminder-occurrences"(account_id,next_attempt_at,eligible_at) WHERE state IN('pending','preparing','waiting_source');
CREATE INDEX "ramesh-reminder-occurrences-intent" ON public."ramesh-reminder-occurrences"(account_id,reminder_id,schedule_version);
CREATE TABLE public."ramesh-assistant-commands" (
 id uuid PRIMARY KEY,account_id text NOT NULL,owner_employee_id integer NOT NULL CHECK(owner_employee_id>0),
 run_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('mutation','selection')),
 fingerprint text,payload_encrypted text NOT NULL CHECK(octet_length(payload_encrypted)<=262144),
 result_encrypted text CHECK(octet_length(result_encrypted)<=262144),presented boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,expires_at timestamptz NOT NULL,
 CHECK(fingerprint IS NULL OR fingerprint ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "ramesh-one-mutation-batch" ON public."ramesh-assistant-commands"(account_id,run_id) WHERE kind='mutation';
CREATE INDEX "ramesh-personal-selections" ON public."ramesh-assistant-commands"(account_id,owner_employee_id,created_at DESC) WHERE kind='selection';
ALTER TABLE public."ramesh-messages" DROP CONSTRAINT "ramesh-messages_origin_check";
ALTER TABLE public."ramesh-messages" ADD CONSTRAINT "ramesh-messages_origin_check" CHECK(origin IN('whatsapp','admin','automation','reminder'));
DO $$
DECLARE tab text; api_role text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['ramesh-tasks','ramesh-reminders','ramesh-reminder-occurrences','ramesh-assistant-commands'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',tab);
  FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role','ramesh_playground'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=api_role) THEN EXECUTE format('REVOKE ALL ON public.%I FROM %I',tab,api_role); END IF;
  END LOOP;
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO ramesh_worker',tab);
  EXECUTE format('CREATE POLICY ramesh_runtime ON public.%I FOR ALL TO ramesh_worker USING(true) WITH CHECK(true)',tab);
 END LOOP;
END;
$$;
-- Persist delivery outcome before 30-day message cleanup can remove its audit row.
CREATE FUNCTION public."ramesh-reconcile-reminder-delivery"() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.origin='reminder' AND NEW.state IN('SENT','EXPIRED','FAILED','UNCERTAIN') THEN
  UPDATE public."ramesh-reminder-occurrences" SET
   state=CASE NEW.state WHEN 'SENT' THEN 'sent' WHEN 'EXPIRED' THEN 'missed' WHEN 'UNCERTAIN' THEN 'uncertain' ELSE 'failed' END,
   reason_code=left(NEW.reason,64),lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE account_id=NEW.account_id AND outbound_message_id=NEW.id AND state='queued';
  UPDATE public."ramesh-reminders" r SET
   last_outcome=o.state,
   state=CASE WHEN r.next_due_at IS NULL AND NOT EXISTS(SELECT 1 FROM public."ramesh-reminder-occurrences" pending
     WHERE pending.account_id=r.account_id AND pending.reminder_id=r.id AND pending.state IN('pending','preparing','waiting_source','queued')) THEN 'completed' ELSE r.state END,
   finished_at=CASE WHEN r.next_due_at IS NULL AND NOT EXISTS(SELECT 1 FROM public."ramesh-reminder-occurrences" pending
     WHERE pending.account_id=r.account_id AND pending.reminder_id=r.id AND pending.state IN('pending','preparing','waiting_source','queued')) THEN clock_timestamp() ELSE r.finished_at END,
   updated_at=clock_timestamp()
   FROM public."ramesh-reminder-occurrences" o WHERE o.outbound_message_id=NEW.id
   AND o.account_id=NEW.account_id AND r.account_id=o.account_id AND r.id=o.reminder_id AND r.state='scheduled';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public."ramesh-reconcile-reminder-delivery"() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public."ramesh-reconcile-reminder-delivery"() TO ramesh_worker;
CREATE TRIGGER "ramesh-reminder-delivery-terminal" AFTER UPDATE OF state ON public."ramesh-messages"
 FOR EACH ROW EXECUTE FUNCTION public."ramesh-reconcile-reminder-delivery"();
