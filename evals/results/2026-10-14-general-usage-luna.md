# Generic usage audit: Luna, 14 October 2026

**Original campaign: not ready to ship.** Fourteen of seventeen paths passed the predefined state/tool checks. Three functional failures were found: attachment-to-RFQ data loss, overlapping personal mutations, and CMS preview delivery. These failures were retained; bot code and prompts were not tuned during the campaign.

At campaign completion, the approved direct-request execution change remained local. The earlier five-turn real-voice replay passed after that change, and `npm run check` passed all 1,206 tests, Prisma validation, type checking, build and formatting. Those checks did not cover the new failures below.

**Subsequent source-binding repair:** conversation history and write sources now share an exact-message attachment reader. Selected captions and retained extraction text are bound before dispatch; unavailable or truncated selected attachment text cannot silently become a caption-only save. Explicit part selections remain possible, and creation receipts no longer assert source completeness. The original caption-only call now makes zero writes. Real local PostgreSQL tests cover image/PDF capture through the graph and journal, quoted/current messages, context shortening, expiry, recovery, explicit caption-only capture and owner isolation. The full check passed 1,223 tests. These are deterministic checks with scripted model/extraction/provider responses, not a new paid-model result. The task/reminder and CMS issues below remain open.

## Scope and cost

- [Case catalogue](../general-usage-paths.json): 17 paths, 37 planned turns; 36 turns reached in the selected valid attempts. CMS failed before its confirmation turn.
- Luna agent and Luna grader only. Real local Podman PostgreSQL, durable queue, media extraction, source reader, write/personal repositories, graph and delivery checks. CRM/Gmail/GIS/CMS/web were synthetic; outbound replies were captured.
- No production mutations, actual WhatsApp sends, deployment, commit or push.
- **Conservative accounted cost: $1.450790 / $3.00.** All 324 metered requests settled; no pending, unknown or held cost. The versioned upper-rate profile is retained in each usage policy. This is budget accounting, not a final provider invoice.
- First campaign: $0.861325; fixture-corrected continuation: $0.546246; corrected fault-injection path: $0.043219. Each continuation received only the unspent balance.
- 25 total path attempts and 43 delivered turns include eight invalid fixture attempts. All originals remain available. No real bot failure was rerun to obtain a passing result.
- One valid attempt per path is a diagnostic screen, not pass@k or a reliability percentage. Future reminder delivery, live provider permissions and the full group/authorization matrix were not exercised.
- Selected-attempt preparation time: median 45.2 seconds, maximum 112.6 seconds. This excludes prior media extraction and is not a production latency benchmark.

## Functional failures

### 1. Attachment data disappears at the write boundary

The first image turn correctly extracted Fixture Orchid Foods, 16,000–18,000 sq ft, Tumakuru, fire documentation and parking for two trucks. On “Save that full brief as a new RFQ,” `write_sources` returned only the earlier image caption. `create_crm_rfq` received that caption as `raw_text`; the actual stored description was the instruction to read the image. Enrichment withheld the company/location/area because those facts were absent from the supplied source, and the record title became `New RFQ`. The code receipt nevertheless said “Full brief saved in the description.”

The factual reviewer noticed the mismatch after execution. Preserving the recorded receipt then preserved that misleading completeness claim too. This is why source completeness must be established before dispatch; post-action reply review cannot repair a missing brief.

Evidence: `paid-2/image-brief-to-rfq-result.json`, its original tool results and stored RFQ snapshot. `src/infrastructure/database/write.repository.ts` decodes ordinary media sources from caption text; normalized voice transcripts have a special path, but image/document extraction is not joined into these write sources. The observed failure was an image; document writes share the source-handling gap but were not separately executed.

Required fix: provide a common retained source representation containing caption plus available extracted attachment text, while keeping command authority separate from attachment content. Missing, expired or truncated source material must not silently become a caption-only “full brief.” Do not replace original sources with an assistant summary.

### 2. Task completion conflicts with its own reminder cancellation

The model selected the correct task and linked reminder with current versions. Its batch contained `task_complete` followed by `reminder_cancel`. The repository automatically cancels linked reminders during task completion, incrementing their version. The explicit cancellation then fails `PERSONAL_VERSION_CONFLICT`, rolling the entire batch back. The task remained open and the reminder scheduled.

A free Podman reproduction confirmed the combined request fails, whereas task completion alone produces a done task and cancelled reminder. Relevant code: `src/infrastructure/database/personal.repository.ts`, sequential `applyBatch`, target version checking, and the linked-reminder cancellation in task completion.

Required fix: reconcile overlapping effects within one atomic batch while preserving checks against external concurrent changes. Another prompt telling the model to choose a particular operation order would not fix the repository contract.

### 3. Delivery refresh recreates a CMS preview

The agent prepared a correct title diff. Delivery authorization called `cms_prepare_import` again to refresh its evidence. That allocated a second preview ID, so the fingerprint comparison rejected `SOURCE_CHANGED`. The user received “I couldn't verify access to this saved reply. Please try again.” No confirmation or CMS draft save was reached.

A free reproduction exercised the actual `BusinessReadService.canDeliver` path and observed two allocated previews and rejection. This matches the current CMS service: `wareongo-cms/lib/agent-cms/service.ts` calls `randomUUID()` and `saveImport()` for each `prepare_import`. It is not a pure lookup.

Required fix: refresh the exact returned immutable preview through its stable reference, with current authorization, instead of rerunning an allocating operation. Do not disable source checks or ignore arbitrary changed fields.

## Other usability findings

- Knowledge: the checklist was correct, but the missing shareable URL became a vague partial-answer notice.
- Revoked access: no private data leaked, but the response described absent conversation details instead of the access restriction.
- GIS undo: the point was removed correctly, but its receipt displayed raw JSON and “Reverse create gis poi.”
- Personal receipts: punctuation such as “landlord..” and “landlord.;” comes from deterministic presentation code.

## Path results

“Pass” below means state/tool checks passed; it does not erase the separate reply-quality findings.

| Path                          | State/tool checks | Observation                                                                                                                                                                             |
| ----------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat-advice`                 | Pass              | Useful general help; no unnecessary source calls or writes.                                                                                                                             |
| `crm-followups`               | Pass              | Today versus overdue remained separate; named-deal context was retrieved.                                                                                                               |
| `warehouse-comparison`        | Pass              | Correct displayed ordinals; recommendation qualified by missing truck-access evidence.                                                                                                  |
| `client-shortlist-correction` | Pass              | Search range changed without editing CRM; client/use preserved. Reviewed manually after grader input-size rejection.                                                                    |
| `knowledge`                   | Pass              | Correct checklist; vague partial-answer notice instead of explaining that the source supplied no shareable URL.                                                                         |
| `analytics-source-outage`     | Pass              | GA4 denial did not suppress available Search Console facts or become zero traffic.                                                                                                      |
| `public-research-and-cost`    | Pass              | Cited synthetic public page; 32,000 × INR 24 = INR 768,000/month.                                                                                                                       |
| `rfq-create-edit-undo`        | Pass              | One RFQ; explicit No and budget clear; edit undo restored fields; original description preserved.                                                                                       |
| `rfq-uncertain-retry`         | Pass              | Two attempts reused one operation ID and frozen arguments; only one RFQ; uncertainty remained explicit.                                                                                 |
| `note-create-edit-undo`       | Pass              | One note; two → three → two trucks; title and evening preference preserved.                                                                                                             |
| `gmail-draft-lifecycle`       | Pass              | Same draft updated Tuesday → Wednesday; recipient/fire-document request preserved; sending refused.                                                                                     |
| `gis-native-pin`              | Pass              | Exact native coordinates saved; point removed once. Undo receipt exposes raw JSON and awkward tool wording.                                                                             |
| `cms-preview-confirm`         | Fail              | Delivery replayed preview creation, allocated a different preview ID, then rejected SOURCE_CHANGED. Confirmation/save turn was not reached.                                             |
| `personal-task-reminder`      | Fail              | Creation/list/reschedule worked. Completing task auto-cancels reminder; explicit reminder cancellation then conflicts and rolls back both operations. Receipt also doubles punctuation. |
| `image-brief-to-rfq`          | Fail              | Image read succeeded. Write sources exposed only its caption, so CRM description saved the read instruction and lost the extracted brief. Receipt falsely said full brief saved.        |
| `revoked-private-recall`      | Pass              | Protected details withheld; reply incorrectly described unavailable conversation details instead of the access restriction.                                                             |
| `pdf-requirement`             | Pass              | Covered/open areas and unresolved power preserved. Extra extraction caveat was supported by actual media context, omitted from grader input.                                            |

## Fixture and grader audit

Three fixture defects invalidated initial attempts: extra profile fields in a strict write identity; non-API source paths in synthetic read envelopes; and read-style metadata on an RFQ unknown-outcome response. The corrected fixtures mirror the production identity projection, run reads through `verifyToolEvidence`, and validate the actual unknown-response schema. Free queue/receipt and retry preflights preceded paid continuations. Inputs and checks stayed the same. Those invalid attempts remain in the original directories and are included in cost.

The grader was advisory. The final assessment uses actual stored state, delivered messages and retained sources:

- The client-shortlist grader exceeded its input limit; its source calls, correction and delivered reply were reviewed manually.
- The grader incorrectly called the personal reschedule uncommitted. The database snapshot proves the same reminder moved to 11 am.
- The PDF extraction caveat was present in the media context supplied to the agent. That context was omitted from the grader input, causing a false grounding flag.
- The CMS grader saw the prepared preview and passed it; the actual delivered message was the authorization fallback. Delivery checks correctly failed the path.

## Retained evidence

All private requests/responses, causal grades, original failures, manifests, usage ledgers, fixture versions and reproductions are under `.local/general-usage-luna-20261014/`:

- `paid-1/`, `paid-2/`, `paid-3/`: original and continuation attempts; never overwritten.
- `personal-batch-repro.mts` / `.log` and `cms-refresh-repro.mts` / `.log`: free deterministic reproductions.
- `audit-summary.json`: selected-attempt mapping, budget totals and caveats.
- `paid-1/source-provenance.json`, `working-tree.patch` and `source-integrity.json`: exact local code baseline and integrity checks.
- The original voice replay remains in `.local/queued-voice-luna-20261014/paid-2/`; full check output is `.local/direct-write-check-2.log`.

A shareable, synthetic-only summary of the original campaign is [stored alongside this report](2026-10-14-general-usage-luna.json). The original paid results remain unchanged. The source-binding follow-up is documented above; the two other functional failures remain open, and no claim of overall release readiness is made.
