-- Order is assigned at admission, never by message timestamps supplied by clients.
ALTER TABLE public."ramesh-messages" ADD COLUMN queue_order bigint;
-- Preserve the known admission ordering for existing records, including active jobs.
WITH ordered AS (
  SELECT id,row_number() OVER (ORDER BY created_at,id) AS n FROM public."ramesh-messages"
)
UPDATE public."ramesh-messages" m SET queue_order=o.n FROM ordered o WHERE m.id=o.id;
ALTER TABLE public."ramesh-messages" ALTER COLUMN queue_order SET NOT NULL;
ALTER TABLE public."ramesh-messages" ALTER COLUMN queue_order ADD GENERATED ALWAYS AS IDENTITY;
REVOKE ALL ON SEQUENCE public."ramesh-messages_queue_order_seq" FROM PUBLIC;
GRANT USAGE ON SEQUENCE public."ramesh-messages_queue_order_seq" TO ramesh_worker;
SELECT setval('public."ramesh-messages_queue_order_seq"',
  greatest(1,coalesce((SELECT max(queue_order) FROM public."ramesh-messages"),0)),
  EXISTS(SELECT 1 FROM public."ramesh-messages"));
CREATE INDEX "ramesh-messages-chat-pending" ON public."ramesh-messages" (account_id,chat_id,queue_order)
  WHERE state IN ('QUEUED','PROCESSING','READY_TO_SEND','SENDING');
-- Atomic repository claims retain the account advisory lock while enforcing the
-- cross-table per-chat exclusion and bounded account-wide lease count.
DROP INDEX public."ramesh-inbound-one-active";
CREATE INDEX "ramesh-inbound-active" ON public."ramesh-inbound-queue" (account_id,lease_until) WHERE state='LEASED';
-- Keep the outbound account-wide unique lease index: actual sends stay serial.
COMMENT ON COLUMN public."ramesh-messages".queue_order IS 'Monotonic server admission order used for per-chat queue sequencing. Queue claims are serialized by the account transaction advisory lock.';

DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=api_role) THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE public."ramesh-messages_queue_order_seq" FROM %I',api_role);
    END IF;
  END LOOP;
END;
$$;
