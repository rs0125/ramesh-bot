# Send notifications from CRM and other automations

The Ramesh worker accepts an immediate outbound message, persists it in Supabase, and sends it through its existing WhatsApp connection. This does not invoke a model. Text and one uploaded JPEG, PNG or PDF are supported.

## Credentials

Base URL: `https://wareongo-ramesh.duckdns.org`.

Use the dedicated `RAMESH_AUTOMATION_API_KEY` in the `X-Ramesh-Api-Key` header. It is separate from the worker admin token. Store it only in your automation server's secret configuration. The operator's ignored `.local/automation-client.env` contains the integration URL and credential with mode `0600`; neither belongs in Git or browser code.

## Enqueue a message

The following examples send real messages when run against production. Replace the recipient and run only for an intended notification.

```sh
curl --fail-with-body "$RAMESH_API_URL/v1/outbound-messages" \
  -H "X-Ramesh-Api-Key: $RAMESH_AUTOMATION_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: crm-followup-123-revision-1' \
  --data '{"to":"+919876543210","text":"Your follow-up is due today.","expiresInSeconds":900}'
```

Example response (HTTP 202):

```json
{ "messageId": "20000000-0000-8000-8000-000000000001", "status": "queued" }
```

Use a stable event ID as the idempotency key, including a revision when the intended content changes. Retry the identical request with the **same key** after network errors or 503. Do not generate a new key on each retry. Identical requests return the original message ID and `duplicate`; different content with that key returns 409. Deduplication lasts for the message ledger's current 30-day retention window.

For attachments, add `media` to the same JSON request:

```json
{
  "to": "+919876543210",
  "text": "The warehouse brochure you requested.",
  "media": {
    "mimeType": "application/pdf",
    "fileName": "brochure.pdf",
    "dataBase64": "<base64 encoding of the actual file bytes>"
  }
}
```

Read the file in your automation and encode its bytes with standard padded base64. URL references and `data:` URLs are rejected. The attachment and caption are sent together. A file is at most 8 MiB; text is at most 4,000 characters, or 1,024 for an image caption. Attachment-only requests may omit text. Supported MIME types are `application/pdf`, `image/jpeg`, and `image/png`. Voice notes and video are not accepted by this version.

Recipients use an E.164 phone number with leading `+`. Groups and raw JIDs are not accepted. An existing conversation is not required.

## Check progress

```sh
curl --fail-with-body "$RAMESH_API_URL/v1/outbound-messages/$MESSAGE_ID" \
  -H "X-Ramesh-Api-Key: $RAMESH_AUTOMATION_API_KEY"
```

| State           | Meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `READY_TO_SEND` | Persisted and waiting for its chat/transport slot                       |
| `SENDING`       | A send attempt is in progress                                           |
| `SENT`          | WhatsApp SDK accepted the send; not a recipient delivery/read receipt   |
| `EXPIRED`       | Deadline passed before a safe send                                      |
| `FAILED`        | Delivery could not be prepared or safe attempts were exhausted          |
| `UNCERTAIN`     | Sending may have succeeded; do not automatically resend under a new key |

Status returns timestamps and a bounded reason code, not message text or attachment bytes. A 404 means the ID is absent, beyond retention, or not an automation job. A duplicate POST does not change the original deadline or requeue a terminal job.

`expiresInSeconds` defaults to 900; allowed range is 30–86,400. Disconnected WhatsApp pauses delivery until reconnection or expiry. The deadline is an expiry limit, not a scheduled send time. Longer-lived reminders will use a separate scheduler which enqueues notifications when due.

HTTP 401 means wrong/missing/disabled credentials, 400 invalid fields, 413 an oversized body/file, 415 unsupported content, 409 idempotency conflict, 429 queue/upload capacity, and 503 a temporary worker/storage failure. Back off before retrying 429/503 with the same key. The API currently has no cancellation operation; producers should send only notifications ready for immediate delivery.

Attachments are encrypted separately and cleared on terminal completion or expiry. The normal encrypted text ledger remains for 30 days. Image signatures are checked, but Ramesh does not scan documents for malware. Trusted producers remain responsible for the content they send. Phone/LID aliases currently retain separate conversation histories and FIFO boundaries.

See [the module contract](agent-modules/48-outbound-automation-api.md) for implementation and test boundaries.
