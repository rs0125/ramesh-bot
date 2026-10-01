-- Keep readable history separately from the temporary encrypted transport payload.
-- OBSERVED messages are retained for the inbox/context without creating reply jobs.
ALTER TABLE public."ramesh-messages"
  ADD COLUMN origin text NOT NULL DEFAULT 'whatsapp' CHECK (origin IN ('whatsapp','admin')),
  ADD COLUMN mentions_bot boolean NOT NULL DEFAULT false,
  ADD COLUMN content_encrypted text CHECK (octet_length(content_encrypted) <= 1048576),
  ADD COLUMN reply_encrypted text CHECK (octet_length(reply_encrypted) <= 1048576),
  ADD COLUMN request_fingerprint text CHECK (length(request_fingerprint) = 64),
  ADD COLUMN reply_created_at timestamptz;
ALTER TABLE public."ramesh-messages" DROP CONSTRAINT "ramesh-messages_state_check";
ALTER TABLE public."ramesh-messages" ADD CONSTRAINT "ramesh-messages_state_check"
  CHECK (state IN ('OBSERVED','QUEUED','PROCESSING','READY_TO_SEND','SENDING','SENT','EXPIRED','FAILED','UNCERTAIN'));
-- Observed messages have no temporary transport payload or pending reply job.
ALTER TABLE public."ramesh-messages" DROP CONSTRAINT "ramesh-messages_check";
ALTER TABLE public."ramesh-messages" ADD CONSTRAINT "ramesh-messages_check"
  CHECK (state IN ('OBSERVED','SENT','EXPIRED','FAILED','UNCERTAIN') OR payload_encrypted IS NOT NULL);
CREATE INDEX "ramesh-inbox-chat" ON public."ramesh-messages" (account_id,chat_id,created_at DESC,id DESC)
  WHERE content_encrypted IS NOT NULL;
CREATE INDEX "ramesh-inbox-recent" ON public."ramesh-messages" (account_id,updated_at DESC,id DESC)
  WHERE content_encrypted IS NOT NULL;
COMMENT ON COLUMN public."ramesh-messages".content_encrypted IS 'Encrypted inbox text, sender and chat display metadata; retained for 30 days, including untagged group messages.';
COMMENT ON COLUMN public."ramesh-messages".reply_encrypted IS 'Encrypted outgoing text retained for the inbox. Only SENT replies enter conversational context.';
