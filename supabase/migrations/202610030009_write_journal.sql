-- Business writes are durable intents, not transport retries or model checkpoints.
-- No message FK: audit must survive normal inbox retention.
CREATE TABLE public."ramesh-write-operations" (
 id uuid PRIMARY KEY,account_id text NOT NULL,owner_employee_id integer NOT NULL CHECK(owner_employee_id>0),
 phone_e164 text NOT NULL CHECK(phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),chat_id text NOT NULL,
 proposal_run_id uuid NOT NULL,source_message_id uuid NOT NULL,approval_run_id uuid,approval_source_message_id uuid,
 state text NOT NULL CHECK(state IN('DRAFT','PROPOSED','APPROVED','DISPATCHING','SUCCEEDED','REJECTED','UNKNOWN','CANCELLED','EXPIRED')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),published_version integer CHECK(published_version>0),delivery_mode text NOT NULL DEFAULT 'production' CHECK(delivery_mode='production'),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),code_hash text NOT NULL CHECK(code_hash ~ '^[a-f0-9]{64}$'),
 payload_encrypted text NOT NULL CHECK(octet_length(payload_encrypted)<=524288),result_encrypted text CHECK(octet_length(result_encrypted)<=524288),
 parent_operation_id uuid,parent_expected_version integer CHECK(parent_expected_version>0),
 dispatch_token uuid,dispatch_until timestamptz,dispatch_attempts integer NOT NULL DEFAULT 0 CHECK(dispatch_attempts>=0),
 has_uncertain_attempt boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 UNIQUE(account_id,id),UNIQUE(account_id,proposal_run_id),UNIQUE(account_id,owner_employee_id,code_hash),
 FOREIGN KEY(account_id,parent_operation_id) REFERENCES public."ramesh-write-operations"(account_id,id),
 CHECK((parent_operation_id IS NULL)=(parent_expected_version IS NULL)),
 CHECK((state='DISPATCHING')=(dispatch_token IS NOT NULL AND dispatch_until IS NOT NULL))
);
CREATE INDEX "ramesh-write-owner-history" ON public."ramesh-write-operations"(account_id,owner_employee_id,chat_id,created_at DESC,id);
CREATE INDEX "ramesh-write-unfinished" ON public."ramesh-write-operations"(account_id,state,expires_at) WHERE state IN('DRAFT','PROPOSED','APPROVED','DISPATCHING','UNKNOWN');
CREATE TABLE public."ramesh-write-events" (
 id uuid PRIMARY KEY,account_id text NOT NULL,owner_employee_id integer NOT NULL CHECK(owner_employee_id>0),
 phone_e164 text NOT NULL,chat_id text NOT NULL,operation_id uuid,personal_command_id uuid,
 source_family text NOT NULL CHECK(length(source_family) BETWEEN 1 AND 64),kind text NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),
 actor_type text NOT NULL CHECK(actor_type IN('employee','system')),run_id uuid,source_message_id uuid,operation_version integer,
 payload_encrypted text NOT NULL CHECK(octet_length(payload_encrypted)<=1240000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(account_id,operation_id) REFERENCES public."ramesh-write-operations"(account_id,id),
 CHECK(operation_id IS NULL OR personal_command_id IS NULL)
);
CREATE UNIQUE INDEX "ramesh-write-event-version" ON public."ramesh-write-events"(account_id,operation_id,operation_version) WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX "ramesh-personal-audit-command" ON public."ramesh-write-events"(account_id,personal_command_id) WHERE personal_command_id IS NOT NULL;
CREATE INDEX "ramesh-write-audit-owner" ON public."ramesh-write-events"(account_id,owner_employee_id,chat_id,created_at DESC,id);
DO $$
DECLARE tab text; api_role text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['ramesh-write-operations','ramesh-write-events'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',tab);
  FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role','ramesh_playground'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=api_role) THEN EXECUTE format('REVOKE ALL ON public.%I FROM %I',tab,api_role); END IF;
  END LOOP;
  EXECUTE format('GRANT SELECT,INSERT ON public.%I TO ramesh_worker',tab);
  EXECUTE format('CREATE POLICY ramesh_runtime_read ON public.%I FOR SELECT TO ramesh_worker USING(true)',tab);
  EXECUTE format('CREATE POLICY ramesh_runtime_append ON public.%I FOR INSERT TO ramesh_worker WITH CHECK(true)',tab);
 END LOOP;
END;
$$;
GRANT UPDATE ON public."ramesh-write-operations" TO ramesh_worker;
CREATE POLICY ramesh_runtime_update ON public."ramesh-write-operations" FOR UPDATE TO ramesh_worker USING(true) WITH CHECK(true);
