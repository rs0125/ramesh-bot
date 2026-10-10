-- Match bounded application payloads after JSON escaping and AES-GCM/base64
-- encoding. No content is rewritten and every ownership/audit policy is retained.
ALTER TABLE public."ramesh-write-operations"
  DROP CONSTRAINT "ramesh-write-operations_payload_encrypted_check",
  ADD CONSTRAINT "ramesh-write-operations_payload_encrypted_check"
    CHECK (octet_length(payload_encrypted) <= 2097152);
ALTER TABLE public."ramesh-write-events"
  DROP CONSTRAINT "ramesh-write-events_payload_encrypted_check",
  ADD CONSTRAINT "ramesh-write-events_payload_encrypted_check"
    CHECK (octet_length(payload_encrypted) <= 5242880);
