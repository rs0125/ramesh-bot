-- Separate application tables: production migrations and queues are never changed here.
CREATE TABLE public."ramesh-test-inbound-queue" (
  id uuid PRIMARY KEY,
  namespace uuid NOT NULL,
  conversation text NOT NULL CHECK (conversation ~ '^[A-Za-z0-9_-]{1,100}$'),
  employee_id integer NOT NULL CHECK (employee_id > 0),
  sender text NOT NULL CHECK (sender IN ('me','teammate')),
  audience text NOT NULL CHECK (audience IN ('dm','group')),
  source text NOT NULL DEFAULT 'operator_test' CHECK (source='operator_test'),
  input_encrypted text NOT NULL CHECK (octet_length(input_encrypted) <= 65536),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','PROCESSING','COMPLETED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
  CHECK ((state='PROCESSING') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  UNIQUE(namespace,id)
);
CREATE INDEX "ramesh-test-conversation" ON public."ramesh-test-inbound-queue"(namespace,conversation,created_at,id);
CREATE TABLE public."ramesh-test-outbound-queue" (
  message_id uuid PRIMARY KEY REFERENCES public."ramesh-test-inbound-queue"(id) ON DELETE CASCADE,
  transport text NOT NULL DEFAULT 'capture' CHECK (transport='capture'),
  state text NOT NULL CHECK (state IN ('CAPTURED','SUPPRESSED')),
  reply_kind text NOT NULL CHECK (reply_kind IN ('conversation','business')),
  output_encrypted text NOT NULL CHECK (octet_length(output_encrypted) <= 262144),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public."ramesh-test-agent-events" (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES public."ramesh-test-inbound-queue"(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0),
  kind text NOT NULL CHECK (kind IN ('tool_started','tool_succeeded','tool_failed')),
  payload_encrypted text NOT NULL CHECK (octet_length(payload_encrypted) <= 2097152),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "ramesh-test-event-message" ON public."ramesh-test-agent-events"(message_id,id);
REVOKE ALL ON public."ramesh-test-inbound-queue",public."ramesh-test-outbound-queue",public."ramesh-test-agent-events"
  FROM PUBLIC,anon,authenticated,service_role,ramesh_worker;
REVOKE ALL ON SEQUENCE public."ramesh-test-agent-events_id_seq" FROM PUBLIC,anon,authenticated,service_role,ramesh_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON public."ramesh-test-inbound-queue" TO ramesh_playground;
GRANT SELECT,INSERT,UPDATE ON public."ramesh-test-outbound-queue" TO ramesh_playground;
GRANT SELECT,INSERT ON public."ramesh-test-agent-events" TO ramesh_playground;
GRANT USAGE,SELECT ON SEQUENCE public."ramesh-test-agent-events_id_seq" TO ramesh_playground;
ALTER TABLE public."ramesh-test-inbound-queue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ramesh-test-outbound-queue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ramesh-test-agent-events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ramesh_test_inbound_runtime" ON public."ramesh-test-inbound-queue" TO ramesh_playground USING (true) WITH CHECK (true);
CREATE POLICY "ramesh_test_outbound_runtime" ON public."ramesh-test-outbound-queue" TO ramesh_playground USING (true) WITH CHECK (true);
CREATE POLICY "ramesh_test_events_runtime" ON public."ramesh-test-agent-events" TO ramesh_playground USING (true) WITH CHECK (true);
COMMENT ON TABLE public."ramesh-test-outbound-queue" IS 'Captured operator-test output only. No Baileys consumer, promotion, or routable WhatsApp destination.';
