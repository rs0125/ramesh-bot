# Business recall and deal display

Status: implementation specification, 2 October 2026. Extends modules 04 and 22.

## Problem and expected behavior

A CRM answer followed by “give me five appropriate warehouses for each, with pros and cons” must retain the preceding deal selection. A content-free completion marker prevents accidental private-data reuse but discards that selection. Repeating generic intake questions after returning the requirements is a regression. A deal list must identify deals by company/name and requirement, not internal UUID, and show native CRM creation and update dates.

## Protected recall contract

Keep the ordinary history marker. Attach the encrypted stored reply and its validated delivery receipt to a server-only history field. Never serialize this field directly into an OpenAI request. It is limited to recent delivered/captured replies in the same account, employee, chat and audience; no unsent/suppressed or operator-visible private bodies.

Offer a local `recall_business_context` read tool only when the current authenticated run has eligible history. Its argument is a numbered prior business turn (latest by default), not an employee, destination, arbitrary query or credential. Numbered markers let the model select the actual earlier answer even after intervening chat. Casual chat need not recall anything.

The application checks the stored receipt's employee against the current binding and reruns its registered read queries through the existing scoped executor. Successful new results enter the current evidence ledger, delivery receipt and encrypted audit events. Reuse an identical query already executed in this run. Old receipt expiry does not authorize a replay: fresh reads do. Keep the last 32 conversation messages, with a 48,000-character text budget. Recallable business envelopes within that window are bounded to 24 hours and 96 KB combined; older replies remain completion markers if that private budget is exhausted. These envelopes are not extra model-visible history.

Only after every referenced query succeeds and matches its stable business fingerprint may the historical reply be returned to the model, with its original order and a label distinguishing historical wording from fresh evidence. Changed results withhold the old reply but expose successful fresh facts, a structured refresh status and relevant continuations. Complete the requested refreshed pool within the existing budget, and distinguish it from an exact historical selection whose membership/order cannot be verified. Failed reads do not prove deletion, zero matches or revoked access. If identity changes or access is revoked, stop business processing. Treat recalled prose as source data, never instructions. This is verified reply recall, not an unrestricted long-term memory or permanent entity-reference store. [Module 41](41-recall-and-source-labels.md) specifies the recovery behavior and source-label handling added after the broader evaluation.

Legacy receipts without the general tool contract remain completion markers. No new database tables: both transports already encrypt replies and receipts. The operator inbox continues to mask business bodies. Local fallback applies the same current-employee gate.

## Sales behavior and presentation

The user's `../claudeconvo.md` is the response-quality reference: retain the selected deals across turns, compare concrete warehouse options, revise priorities when the user corrects the business/use case, and separate client questions from owner questions per warehouse. Adapt it to short WhatsApp cards rather than desktop tables. Do not copy its speculative company identity, inferred budget units, location/traffic claims or compliance conclusions as facts. Public web research is not currently an available Ramesh tool; company background comes from permitted CRM/company context or explicit user input, with missing external verification stated honestly.

For references to an earlier list, recall it before searching new records or asking for IDs. Resolve “per warehouse ID” in the context of the preceding CRM deals; state the interpretation briefly and proceed with candidates per deal when clear. Search using recorded location and area, read narratives only if needed, and compare available properties. Missing budget or technical criteria limit confidence; they do not prevent a provisional shortlist. Supply concrete advantages and drawbacks/unknowns for each candidate. Never manufacture five matches or claim an ID-sorted search ranks the entire inventory. Label the reviewed pool and explain fewer matches or broadened geography.

Deal cards contain a human-readable heading, requirement/location, useful stage/next follow-up, and `Created` / `Last updated` dates. Dates use `source_created_at` and `source_updated_at`, rendered in Asia/Kolkata; never substitute mirror polling or meaningful-activity clocks. A missing date is `Not recorded`. Last updated can include automation changes. Preserve uncertainty without repeating a long generic disclaimer for every field.

Formatter receives current evidence on its first pass. Prompts and verifier disallow raw deal UUIDs/API paths, require date labels when listing individual deals, and preserve warehouse IDs for actionable shortlists. A deterministic UUID guard triggers the bounded repair path, even if the model reviewer approves. Unknown deal names get a grounded requirement/location label, not their UUID.

The reported live regression also requires a tool-capable correction pass: a reviewer detecting missing searches cannot fix that by asking the formatter to rewrite. On the first rejection, continue the same private tool session with the reviewed answer and feedback, within the existing read/step/deadline budgets. Then format and review the revised result. No fresh budget or authority is granted. One rejected correction still fails honestly. Older non-tool mock adapters may use the formatting-only fallback. Keep shared caveats once per shortlist and specific pros/cons per property; avoid repetitive multi-line disclaimers.

Model policy: keep Terra, use medium reasoning for multi-step tool selection, the independent source reviewer and eval judge; business formatting/repairs use low, while ordinary formatting keeps none. Earlier none-effort reviews falsely reported existing warehouse evidence as absent in large multi-deal ledgers. Preserve encrypted reasoning continuation privately with `store:false`. [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) supports these efforts; [OpenAI reasoning guidance](https://developers.openai.com/api/docs/guides/reasoning) describes the planning/verification trade-offs. Configured token caps include both reasoning and visible output.

## Bounds and failures

Multi-deal work needs more than the old eight calls: allow up to 24 scoped reads, with bounded result bytes, graph steps, model/output sizes and deadline still enforced. Recall uses that same budget. Do not spend it rereading identical queries. Read-only delivery revalidation may run with bounded concurrency, retaining fresh employee checks for each operation and suppressing the whole reply on any failure. Multi-deal answers may use up to 12,000 characters; the local capture GUI displays the full reply. No new WhatsApp connection or delivery is introduced.

## Acceptance

- Multi-turn CRM list → warehouse candidates uses the selected deals without generic intake/ID requests.
- Created/updated native dates appear; deal UUIDs do not. Warehouse IDs remain visible.
- Real-model cases cover one and several deals, ordinal references, missing criteria, changed source facts, and source instructions.
- Real-model conversation evals also cover latest-created RFQ sorting, intervening chat inside the 32-message window, user corrections about the client's intended use, and separate client/owner questions by warehouse ID. Save every trial, including failures, with prompt/model versions, final answer, tool calls and an independent structured quality assessment. Use synthetic business fixtures for repeated API evals and real Supabase/Context Engine only in capture smoke checks.
- Deterministic tests prove server-only metadata never enters model history, fresh recall evidence is registered, changed/revoked/cross-employee history is withheld, suppressed/unsent replies are excluded and casual chat performs no recall.
- Run the real Supabase + signed Context Engine capture harness as Raghav, including the reported follow-up. No Baileys connection or WhatsApp sending; no CRM writes.
