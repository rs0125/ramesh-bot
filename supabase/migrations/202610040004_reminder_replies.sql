-- Native WhatsApp reply targets are recorded only when the matching send is confirmed SENT.
-- Keep the key on the occurrence so deleting an expired outbound job does not redirect a reply.
ALTER TABLE public."ramesh-reminder-occurrences"
  ADD COLUMN whatsapp_message_id text
    CHECK (whatsapp_message_id IS NULL OR (length(whatsapp_message_id) BETWEEN 1 AND 256 AND whatsapp_message_id !~ '[[:cntrl:]]')),
  ADD COLUMN acknowledged_at timestamptz,
  ADD CONSTRAINT "ramesh-reminder-occurrences-native-key"
    UNIQUE (account_id, recipient_chat_id, whatsapp_message_id);
