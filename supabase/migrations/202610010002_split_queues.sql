-- Preserve every existing job while making the two pipeline stages explicit.
ALTER TABLE public."ramesh-message-jobs" RENAME TO "ramesh-inbound-queue";
ALTER INDEX public."ramesh-jobs-ready" RENAME TO "ramesh-inbound-ready";
ALTER INDEX public."ramesh-one-active-job" RENAME TO "ramesh-inbound-one-active";

ALTER TABLE public."ramesh-messages" DROP CONSTRAINT "ramesh-messages_state_check";
ALTER TABLE public."ramesh-messages" ADD CONSTRAINT "ramesh-messages_state_check"
  CHECK (state IN ('QUEUED','PROCESSING','READY_TO_SEND','SENDING','SENT','EXPIRED','FAILED','UNCERTAIN'));

CREATE TABLE public."ramesh-outbound-queue" (
  message_id uuid PRIMARY KEY,
  account_id text NOT NULL,
  state text NOT NULL DEFAULT 'READY' CHECK (state IN ('READY','LEASED','DONE','DEAD')),
  payload_encrypted text CHECK (octet_length(payload_encrypted) <= 1048576),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (account_id, message_id) REFERENCES public."ramesh-messages" (account_id,id) ON DELETE CASCADE,
  CHECK (state IN ('DONE','DEAD') OR payload_encrypted IS NOT NULL),
  CHECK ((state = 'LEASED' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
      OR (state <> 'LEASED' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX "ramesh-outbound-ready" ON public."ramesh-outbound-queue" (account_id,available_at,created_at)
  WHERE state = 'READY';
CREATE UNIQUE INDEX "ramesh-outbound-one-active" ON public."ramesh-outbound-queue" (account_id)
  WHERE state = 'LEASED';
ALTER TABLE public."ramesh-outbound-queue" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ramesh-outbound-queue" FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public."ramesh-outbound-queue" TO ramesh_worker;
CREATE POLICY ramesh_runtime ON public."ramesh-outbound-queue" FOR ALL TO ramesh_worker USING (true) WITH CHECK (true);

-- A temporary, updatable alias lets the currently deployed worker finish its work
-- between this migration and the new release. It is a VIEW, not a third queue.
-- Invoker security preserves the underlying queue's RLS and grants.
CREATE VIEW public."ramesh-message-jobs" WITH (security_invoker=true)
  AS SELECT * FROM public."ramesh-inbound-queue";
REVOKE ALL ON public."ramesh-message-jobs" FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public."ramesh-message-jobs" TO ramesh_worker;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=api_role) THEN
      EXECUTE format('REVOKE ALL ON public."ramesh-outbound-queue", public."ramesh-message-jobs" FROM %I',api_role);
    END IF;
  END LOOP;
END;
$$;
COMMENT ON TABLE public."ramesh-inbound-queue" IS 'Incoming messages awaiting agent processing. DONE means the reply was atomically saved to the outbound queue, or legacy work already finished.';
COMMENT ON TABLE public."ramesh-outbound-queue" IS 'Encrypted finalized replies awaiting Baileys delivery. Retries reuse the saved reply; ambiguous sends are never automatically retried.';
COMMENT ON VIEW public."ramesh-message-jobs" IS 'Legacy deployment compatibility alias for ramesh-inbound-queue. New application code uses the explicit inbound and outbound table names.';
