# Native locations and the first GIS write

Status: implemented locally, 3 October 2026. Native WhatsApp location capture belongs in this repository. The `create_gis_poi` MCP tool and dashboard adapter belong in Context Engine, with mutation in the dashboard backend. No GIS-specific executor or dashboard credential is added to Ramesh. Production migration/deployment and a generic bot write executor remain pending; the deployed bot baseline remains `dd4c10b`.

## The observed gap

Baileys exposes native static locations as `locationMessage.degreesLatitude` and `degreesLongitude`. Live-location messages provide the same coordinate fields and optional accuracy/caption. No map screenshot, OCR, geocoding or model call is needed to extract them.

The previous mapper reduced both forms to `[Location message]`. Locations were observation-only, so the queue did not retain their raw protocol payload. A read-only inspection confirmed this for the reported production incident. Its old coordinates cannot be recovered from Ramesh's stored row. Ask for a new share after location capture is deployed; never infer a pin from a nearby image, address or conversation.

## Location intake contract

- Normalize protocol wrappers through the existing privacy filter. View-once messages remain excluded.
- Preserve an explicit static/live-snapshot type, finite latitude in `[-90, 90]` and longitude in `[-180, 180]`, with bounded optional place labels. Both coordinate fields must actually be present. A real zero is valid; a missing protobuf field's default zero is not a location.
- Save normalized location data in the encrypted inbox. Include readable coordinates in conversation input/history and the existing ordered debounce batch. Locations use the burst window so a pin, image and following instruction can form one turn.
- Read forwarding and mention metadata from the location's own `contextInfo`. Preserve normal group mention and sender isolation rules.
- Treat labels, addresses and captions as source data. They cannot authorize a personal task, reminder or business write. A forwarded pin can supply coordinates only when a separate direct instruction authorizes using it.
- A live share is a received snapshot, not continuous tracking or proof of the sender's current location. Saving an evolving live share requires an explicit choice of snapshot.
- Native coordinates follow encrypted inbox retention. This is separate from downloaded image/PDF/audio copies and their 24-hour lifecycle.

## Dashboard boundary

The dashboard already uses `POST /api/geo/points` for its browser UI. Its existing POI service writes `public.point_of_interest`; the record appears on the internal GIS layer, not in warehouse inventory or OSM data.

The integration endpoint is `POST /api/integrations/context-engine/geo/points`, called by Context Engine with its own signed request and a stable operation ID. The body contains:

```json
{
  "operationId": "a-server-generated-uuid",
  "name": "Example industrial prospect",
  "category": "POTENTIAL_CLIENT",
  "lat": 12.9716,
  "lng": 77.5946,
  "notes": "User-provided contact details and context",
  "city": "Bengaluru"
}
```

The example is synthetic. `name`, `category`, `lat`, `lng` and `operationId` are required. Category comes from the dashboard's existing set: `POTENTIAL_CLIENT`, `POTENTIAL_WAREHOUSE`, `FOOD_PLACE`, `HOTEL_RESTAURANT`, `LABOR_QUARTERS`, `OPEN_YARD_BTS`. Contact details currently belong in `notes`; this operation does not create or contact a CRM lead.

Context Engine exposes `create_gis_poi` only with an explicit `gis:write` grant and current dashboard/admin eligibility. It derives the employee from the authenticated caller and signs a short-lived Ed25519 assertion using a dedicated server key. The backend verifies the endpoint, method, body hash and narrow delegated `geo:points:create` scope, then rechecks the asserted employee ID/email against the current unique active roster and dashboard permission. Authorship comes from the roster. Browser JWTs, incoming Context Engine read credentials and Ramesh's signing key are not this downstream credential.

Creation and the idempotency receipt commit together. A fresh signed retry with the same employee, operation ID and payload returns the original creation result; changing the payload under that ID conflicts. A lost HTTP response must never force the caller to invent another operation ID. See the dashboard integration documentation for exact headers, validation, migration and environment configuration.

## Generic agent integration still required

Do not insert creation into `ContextToolRun`, a Context Engine read descriptor or business-read delivery checks. Those paths re-read evidence for authorization and freshness. Replaying a write there would be an unsafe side effect.

Implement one general write execution path for MCP write contracts, following these steps. Keep GIS schemas, categories, validation and the dashboard HTTP client in Context Engine; do not add a local GIS tool or duplicate them in Ramesh:

1. Resolve the messaging employee from the transport key and discover permitted write tools from Context Engine. Preserve their explicit scope and separate write-contract metadata.
2. Let the model propose a name/category/notes and select a native location source reference. Resolve the actual coordinates in application code. The model cannot supply an employee, auth header or replacement coordinates.
3. Require a current direct instruction to save the point. Ask for missing name/category or an ambiguous pin; do not turn “I will add it” or a shared image alone into authorization. Source material may describe an action without requesting it.
4. Review the proposal before any side effect. A correction replaces the uncommitted proposal. Preserve the exact image-extracted contact data and surface uncertain characters for clarification rather than guessing.
5. Durably freeze the authorized payload and a server-generated operation ID before HTTP dispatch, bound to the inbound run, employee and source location. Recheck identity/permission immediately before dispatch.
6. Call the discovered Context Engine write tool with that frozen operation. Context Engine owns the signed dashboard call. On timeout or restart, recover with the same operation and arguments; a changed plan cannot replace an operation whose outcome is unknown.
7. Persist the backend receipt and produce a factual creation confirmation. Queue handoff must be fenced while the write outcome is unresolved. Failure to send the WhatsApp confirmation does not undo the created point.
8. Delivery preflight may reauthorize access to the receipt, but must never invoke POI creation. If access was revoked after creation, withhold sensitive receipt details without claiming that creation was rolled back.

Separate dynamically discovered write contracts from reads and reserved local utilities. Keep tool definitions and employee authorization dynamic. Do not relax read-only contracts to enable this one mutation. Context Engine's `docs/gis-write-tool.md` documents the implemented tool, explicit scope, signing configuration and rollout prerequisites.

Keep Ramesh's current signing configuration read-only during this rollout. Its `CONTEXT_RAMESH_SIGNING_KEY_JSON` schema currently accepts only `:read` scopes; adding `gis:write` before the generic write path is implemented fails worker configuration validation. Context Engine and the dashboard can enable the separately granted tool for compatible clients without changing this bot credential.

`TrustedReplyContext.locationMessages` initially contains only the current inbound batch. Conversation history can explain an earlier pin, but history text is not a trusted write reference. Before enabling the writer, add bounded retrieval of the encrypted structured pin by its source-message reference, restricted to the same account/chat/sender and retention window. This covers the normal case where a user sends the instruction after the debounce window has closed. Multiple possible pins require clarification; never silently use the newest coordinates.

## Focused acceptance checks

- Static location, live snapshot, valid zero and boundary coordinates; missing, nonfinite and out-of-range fields.
- Wrapped/view-once messages, location mention/forwarding metadata, separate senders and ordered image/location/text bursts.
- Encrypted inbox and history retain the location after the raw protocol payload is removed; source metadata cannot become a personal-command instruction.
- Valid signature and current permissions; changed body/endpoint/scope, expired key/assertion, nonce reuse, unknown/inactive/ambiguous employees and permission revocation fail closed.
- Same operation retry, key rotation, concurrent duplicates and changed payload conflict; creation and receipt roll back together.
- Before agent-tool rollout: explicit intent versus quoted/forwarded instructions, uncertain image contact details, restart after backend commit, lost HTTP response, lost delivery, and permission changes between proposal/commit/send.

Use synthetic coordinates/contact details in committed fixtures and model-free transport/backend tests. Do not create a production POI or send a real WhatsApp message as an automated test. No paid model evaluation is needed for this foundation.
