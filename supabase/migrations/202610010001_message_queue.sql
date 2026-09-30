-- Bot-owned tables only. Quoted identifiers preserve the requested ramesh- prefix.
-- The provisioning script creates the restricted ramesh_worker login separately.
CREATE TABLE public."ramesh-schema-migrations" (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public."ramesh-messages" (
  id uuid PRIMARY KEY,
  account_id text NOT NULL CHECK (length(account_id) BETWEEN 1 AND 64),
  chat_id text NOT NULL CHECK (length(chat_id) BETWEEN 1 AND 256),
  whatsapp_message_id text NOT NULL CHECK (length(whatsapp_message_id) BETWEEN 1 AND 256),
  sent_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('QUEUED','PROCESSING','SENDING','SENT','EXPIRED','FAILED','UNCERTAIN')),
  payload_encrypted text CHECK (octet_length(payload_encrypted) <= 1048576),
  reason text CHECK (length(reason) <= 64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE (account_id, chat_id, whatsapp_message_id),
  UNIQUE (account_id, id),
  CHECK (state IN ('SENT','EXPIRED','FAILED','UNCERTAIN') OR payload_encrypted IS NOT NULL)
);
CREATE INDEX "ramesh-messages-retention" ON public."ramesh-messages" (finished_at)
  WHERE finished_at IS NOT NULL;

CREATE TABLE public."ramesh-message-jobs" (
  message_id uuid PRIMARY KEY,
  account_id text NOT NULL,
  state text NOT NULL DEFAULT 'READY' CHECK (state IN ('READY','LEASED','DONE','DEAD')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (account_id, message_id) REFERENCES public."ramesh-messages" (account_id,id) ON DELETE CASCADE,
  CHECK ((state = 'LEASED' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
      OR (state <> 'LEASED' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX "ramesh-jobs-ready" ON public."ramesh-message-jobs" (account_id,available_at,created_at)
  WHERE state = 'READY';
CREATE UNIQUE INDEX "ramesh-one-active-job" ON public."ramesh-message-jobs" (account_id)
  WHERE state = 'LEASED';

CREATE TABLE public."ramesh-message-events" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public."ramesh-messages" (id) ON DELETE CASCADE,
  previous_state text,
  state text NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "ramesh-events-message" ON public."ramesh-message-events" (message_id,occurred_at);

CREATE FUNCTION public."ramesh-record-message-state"() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public."ramesh-message-events" (message_id,state,reason)
      VALUES (NEW.id,NEW.state,NEW.reason);
  ELSIF OLD.state IS DISTINCT FROM NEW.state THEN
    INSERT INTO public."ramesh-message-events" (message_id,previous_state,state,reason)
      VALUES (NEW.id,OLD.state,NEW.state,NEW.reason);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public."ramesh-record-message-state"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public."ramesh-record-message-state"() TO ramesh_worker;
CREATE TRIGGER "ramesh-message-state-history" AFTER INSERT OR UPDATE OF state
  ON public."ramesh-messages" FOR EACH ROW EXECUTE FUNCTION public."ramesh-record-message-state"();

ALTER TABLE public."ramesh-schema-migrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ramesh-messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ramesh-message-jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ramesh-message-events" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ramesh-schema-migrations", public."ramesh-messages",
  public."ramesh-message-jobs", public."ramesh-message-events" FROM PUBLIC;

-- Supabase may grant new public tables to API roles by default. Revoke only ours.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=api_role) THEN
      EXECUTE format('REVOKE ALL ON public."ramesh-schema-migrations", public."ramesh-messages", public."ramesh-message-jobs", public."ramesh-message-events" FROM %I',api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public."ramesh-record-message-state"() FROM %I',api_role);
    END IF;
  END LOOP;
END;
$$;
GRANT USAGE ON SCHEMA public TO ramesh_worker;
GRANT SELECT ON public."ramesh-schema-migrations" TO ramesh_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON public."ramesh-messages",public."ramesh-message-jobs" TO ramesh_worker;
GRANT SELECT,INSERT ON public."ramesh-message-events" TO ramesh_worker;
CREATE POLICY ramesh_runtime ON public."ramesh-schema-migrations" FOR SELECT TO ramesh_worker USING (true);
CREATE POLICY ramesh_runtime ON public."ramesh-messages" FOR ALL TO ramesh_worker USING (true) WITH CHECK (true);
CREATE POLICY ramesh_runtime ON public."ramesh-message-jobs" FOR ALL TO ramesh_worker USING (true) WITH CHECK (true);
CREATE POLICY ramesh_runtime_read ON public."ramesh-message-events" FOR SELECT TO ramesh_worker USING (true);
CREATE POLICY ramesh_runtime_insert ON public."ramesh-message-events" FOR INSERT TO ramesh_worker WITH CHECK (true);

COMMENT ON TABLE public."ramesh-messages" IS 'WhatsApp message state and deduplication. Pending quoted messages are encrypted; terminal payloads are cleared.';
COMMENT ON TABLE public."ramesh-message-jobs" IS 'Durable leased reply queue. Only pre-send work may be retried; ambiguous sends become UNCERTAIN.';
COMMENT ON TABLE public."ramesh-message-events" IS 'Transactional history of message state transitions. No message bodies.';
