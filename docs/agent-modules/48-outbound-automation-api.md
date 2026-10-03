# Outbound automation API

Implementation and focused deterministic tests are complete. Migration `202610030006` is applied and the restricted runtime schema checks pass. The separate service key is provisioned in SSM runtime version 11 and the protected host environment; the HTTPS routes are validated. Code is deployed in `3ad3408`; CI and CD passed, WhatsApp is connected and non-mutating HTTPS authorization probes pass. See the [integration guide](../outbound-automation.md).

## Purpose and boundary

CRM and other trusted server automations can enqueue a WhatsApp notification through the Ramesh worker. This path uses the existing production outbound queue and transport pacing, without invoking the agent graph or granting Context Engine access. It may target a new direct conversation. It does not change the admin inbox's received-conversation restriction.

## HTTP contract

`POST /v1/outbound-messages` requires `X-Ramesh-Api-Key`, `Idempotency-Key` (1–128 printable ASCII characters, without spaces), and `Content-Type: application/json`.

```json
{
  "to": "+919876543210",
  "text": "Your requested warehouse brochure is attached.",
  "media": {
    "mimeType": "application/pdf",
    "fileName": "brochure.pdf",
    "dataBase64": "<standard padded base64>"
  },
  "expiresInSeconds": 900
}
```

`to` must be an E.164 number with a leading `+` (8–15 digits). Raw WhatsApp JIDs and group destinations are rejected. Text is optional only when media exists. Text is at most 4,000 characters; image captions are at most 1,024 characters. One attachment is supported: JPEG, PNG or PDF, up to 8 MiB decoded. MIME signatures must match. File names are plain names without paths or control characters. Only uploaded bytes are accepted; remote URLs are not fetched. This first version does not accept voice notes or video. Base64 is strict and canonical. Unknown fields are rejected to catch caller mistakes.

Expiry defaults to 900 seconds and may be 30–86,400 seconds. The queue waits while WhatsApp is disconnected, up to that deadline. This is an immediate enqueue API, not a reminder scheduler.

Successful admission returns HTTP 202 with `{ "messageId": "<uuid>", "status": "queued" }`. An identical retry returns the same ID and `status: "duplicate"`. Reusing a key with different normalized content returns 409, full queues return 429, invalid input 400/413/415, unavailable storage 503, and invalid credentials 401. Acceptance does not mean delivery.

`GET /v1/outbound-messages/<messageId>` uses the same API key and returns only that automation job's ID, state, creation/expiry/finish timestamps and sanitized reason. Other origins are invisible. `SENT` means the WhatsApp SDK accepted the send, not that the recipient received or read it. `UNCERTAIN` means delivery may have occurred; do not automatically create a new key and resend.

## Authentication and resource limits

`RAMESH_AUTOMATION_API_KEY` is a separate 32-byte base64url secret. It is compared using constant-time hashes before reading the body. It does not authorize admin controls, inbox reads or business tools. Omission disables the API. Configuration requires Supabase storage and rejects reuse of the admin token. The existing HTTPS proxy exposes only these explicit routes. Never log keys, message bodies, attachment bytes or phone numbers.

The body is bounded at 12 MiB, with at most two authenticated uploads being read concurrently. Existing queue capacity, lease fencing, one active outbound sender and chat FIFO apply to this path. Operators should keep the API key in server-side secret storage; it authorizes sending to any accepted direct number.

Ordering is currently scoped to the stored WhatsApp chat ID. Automation destinations use phone-number JIDs; an existing inbound conversation using a LID can appear separately. Canonical PN/LID conversation merging is a follow-up, so recipient-wide FIFO and shared history across these aliases are not guaranteed.

## Durable storage and delivery

Normalize the request, derive a deterministic UUID from account plus idempotency key, and fingerprint target, text, attachment digest/metadata and expiry duration. One database transaction inserts the message ledger row (`origin=automation`), encrypted outbound text and optional separately encrypted media. Idempotency lasts for the ledger retention window (currently 30 days). A retry never extends the original expiry.

Migration `202610030006_outbound_automation.sql` extends only Ramesh tables. Media remains outside small text/history payloads. Bound encrypted size and recorded byte length; purge media upon terminal state or expiry, including crash recovery. Existing restricted worker access and RLS stay in force; capture roles cannot send through production tables.

After claim, decrypt and validate media before the send boundary. Use a single Baileys `sendMessage` with media plus caption. Preserve current timeout, lease and uncertain-send behavior. Attachments never enter the inbound media pipeline, STT, model context or conversation history. Show an outgoing automation entry with text or an attachment marker; do not invent an inbound user message.

## Verification and rollout

Use fake transports and local PostgreSQL only: authentication separation and disabled mode; size/type/phone validation; stable retry and conflicting reuse; atomic rollback; outgoing-only history; same-chat order; encrypted media purge; disconnect, timeout and lease recovery. No paid model evaluations or actual WhatsApp test sends are required.

Apply the additive migration before deployment. Provision the dedicated API key in the worker's protected environment and SSM runtime secret, preserving other values. Update and validate the HTTPS proxy allowlist. Push after focused deterministic checks, then verify release health, WhatsApp connection and non-mutating authentication/status behavior. Keep the integration credential in a private ignored local file for the operator, never in documentation or Git.
