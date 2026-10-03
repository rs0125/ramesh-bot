-- Minimal quote provenance follows the reminder lifecycle, independently of inbox retention.
-- Existing reminders remain unquoted; legacy workers continue reading text_encrypted unchanged.
ALTER TABLE public."ramesh-reminders"
  ADD COLUMN source_quote_encrypted text
  CHECK (source_quote_encrypted IS NULL OR octet_length(source_quote_encrypted)<=262144);

-- A cosmetic acknowledgement is attempted at most once across retries/restarts.
-- Claim before transport: losing this optional message is preferable to spamming the chat.
ALTER TABLE public."ramesh-inbound-queue"
  ADD COLUMN acknowledged_at timestamptz;
