-- Trusted server automations use the same ordered queue, without inventing an inbound message.
ALTER TABLE public."ramesh-messages" DROP CONSTRAINT "ramesh-messages_origin_check";
ALTER TABLE public."ramesh-messages" ADD CONSTRAINT "ramesh-messages_origin_check"
  CHECK (origin IN ('whatsapp','admin','automation'));

-- Keep file bytes out of the 1 MiB text/history payload and inbound extraction pipeline.
ALTER TABLE public."ramesh-outbound-queue"
  ADD COLUMN media_payload_encrypted text CHECK (octet_length(media_payload_encrypted)<=16777216),
  ADD COLUMN media_byte_length integer CHECK (media_byte_length BETWEEN 1 AND 8388608),
  ADD COLUMN media_expires_at timestamptz,
  ADD CONSTRAINT "ramesh-outbound-media-complete" CHECK (
    (media_payload_encrypted IS NULL AND media_byte_length IS NULL AND media_expires_at IS NULL)
    OR (media_payload_encrypted IS NOT NULL AND media_byte_length IS NOT NULL AND media_expires_at IS NOT NULL)
  );
CREATE INDEX "ramesh-outbound-media-expiry" ON public."ramesh-outbound-queue" (account_id,media_expires_at)
  WHERE media_expires_at IS NOT NULL;

CREATE FUNCTION public."ramesh-purge-terminal-outbound-media"() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.state IN ('SENT','EXPIRED','FAILED','UNCERTAIN') OR NEW.expires_at<=clock_timestamp() THEN
    UPDATE public."ramesh-outbound-queue"
      SET media_payload_encrypted=NULL,media_byte_length=NULL,media_expires_at=NULL
      WHERE message_id=NEW.id AND account_id=NEW.account_id AND media_payload_encrypted IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public."ramesh-purge-terminal-outbound-media"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public."ramesh-purge-terminal-outbound-media"() TO ramesh_worker;
CREATE TRIGGER "ramesh-outbound-media-terminal-cleanup" AFTER UPDATE OF state,expires_at
  ON public."ramesh-messages" FOR EACH ROW EXECUTE FUNCTION public."ramesh-purge-terminal-outbound-media"();
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=api_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public."ramesh-purge-terminal-outbound-media"() FROM %I',api_role);
    END IF;
  END LOOP;
END;
$$;
COMMENT ON COLUMN public."ramesh-outbound-queue".media_payload_encrypted IS 'Encrypted outbound-only attachment. Cleared on terminal state and expiry; never passed to an agent or retained in inbox history.';
