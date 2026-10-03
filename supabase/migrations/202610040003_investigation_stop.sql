-- A STOP is archived and its fixed reply queued within capacity in the cancellation transaction.
-- Only identifiers and counts are retained here; no input, answer, or business data.
ALTER TABLE public."ramesh-messages"
  ADD COLUMN stop_result jsonb
  CHECK (stop_result IS NULL OR (
    jsonb_typeof(stop_result)='object'
    AND stop_result ?& ARRAY['version','cancelledRunIds','alreadySending','preservedOutcomes','replyQueued']
    AND stop_result->>'version'='1'
    AND jsonb_typeof(stop_result->'cancelledRunIds')='array'
    AND jsonb_typeof(stop_result->'alreadySending')='number'
    AND jsonb_typeof(stop_result->'preservedOutcomes')='number'
    AND jsonb_typeof(stop_result->'replyQueued')='boolean'
    AND octet_length(stop_result::text)<=1048576
  ));
CREATE INDEX "ramesh-inbound-sender-roots"
  ON public."ramesh-inbound-queue" (account_id,sender_key,message_id)
  WHERE batch_parent IS NULL;
COMMENT ON COLUMN public."ramesh-messages".stop_result IS
  'Metadata-only idempotent STOP outcome. Cancellation uses terminal EXPIRED/user_stopped; committed effects and sends already begun remain intact.';
