-- Bounded read-run journal. Credentials and business bodies stay out of plaintext metadata.
ALTER TABLE public."ramesh-messages"
  ADD COLUMN reply_kind text NOT NULL DEFAULT 'conversation' CHECK (reply_kind IN ('conversation','business')),
  ADD COLUMN business_evidence_encrypted text CHECK (octet_length(business_evidence_encrypted) <= 65536);
ALTER TABLE public."ramesh-messages" ADD CONSTRAINT "ramesh-business-evidence"
  CHECK ((reply_kind='business') = (business_evidence_encrypted IS NOT NULL));

CREATE TABLE public."ramesh-agent-runs" (
  id uuid PRIMARY KEY REFERENCES public."ramesh-messages"(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  contract_version integer NOT NULL DEFAULT 1 CHECK (contract_version=1),
  state text NOT NULL CHECK (state IN ('running','finalized','failed')),
  attempt integer NOT NULL CHECK (attempt > 0),
  lease_token uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finalized_at timestamptz,
  UNIQUE(account_id,id),
  CHECK ((state='finalized') = (finalized_at IS NOT NULL))
);
CREATE TABLE public."ramesh-agent-events" (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL,
  run_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  kind text NOT NULL CHECK (kind IN ('tool_started','tool_succeeded','tool_failed','finalized')),
  payload_encrypted text CHECK (octet_length(payload_encrypted) <= 2097152),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(account_id,run_id) REFERENCES public."ramesh-agent-runs"(account_id,id) ON DELETE CASCADE
);
CREATE INDEX "ramesh-agent-event-run" ON public."ramesh-agent-events"(account_id,run_id,id);
CREATE INDEX "ramesh-agent-run-state" ON public."ramesh-agent-runs"(account_id,state,updated_at);
REVOKE ALL ON public."ramesh-agent-runs", public."ramesh-agent-events" FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE public."ramesh-agent-events_id_seq" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON public."ramesh-agent-runs" TO ramesh_worker;
GRANT SELECT,INSERT ON public."ramesh-agent-events" TO ramesh_worker;
GRANT USAGE,SELECT ON SEQUENCE public."ramesh-agent-events_id_seq" TO ramesh_worker;
ALTER TABLE public."ramesh-agent-runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ramesh-agent-events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ramesh_agent_runs_runtime" ON public."ramesh-agent-runs" TO ramesh_worker USING (true) WITH CHECK (true);
CREATE POLICY "ramesh_agent_events_runtime" ON public."ramesh-agent-events" TO ramesh_worker USING (true) WITH CHECK (true);
COMMENT ON TABLE public."ramesh-agent-runs" IS 'Bounded read execution journal; one run per inbound message. General paused LangGraph checkpoints remain separate future work.';
COMMENT ON COLUMN public."ramesh-messages".business_evidence_encrypted IS 'Encrypted employee binding and verified-result fingerprint for mandatory delivery reauthorization.';
