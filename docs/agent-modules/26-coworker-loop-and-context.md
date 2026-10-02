# Coworker loop and context continuity

Status: implemented and locally tested, 2 October 2026. See the eval runbook for measured outcomes and remaining limitations.

## Evidence behind the change

`claudeconvo.md` demonstrates a working selection carried across several requests: recent RFQs, candidate warehouses, client background, revised use, reranking and owner questions. It completes dependent reads and offers decision-relevant trade-offs before asking about unknowns. It also contains guesses about brand identity, price units, geographic proximity and compliance. The target is its continuity and initiative, with clearer boundaries between recorded facts, user corrections and recommendations. This is not a controlled comparison of models or tool traces, so perceived differences cannot all be attributed to model capability.

The old logistics bot stores raw inbound content in `MessageLog`; a separate per-sender `Conversation.turns` JSON contains model-visible user/assistant exchanges. Its checked-out implementation caps this at 16 messages, 1200 characters per message and 6000 total characters. It sends the history explicitly rather than depending on provider response IDs. Separate `MediaContext` rows pin R2 image references or extracted document text per sender. Pins last two hours and auto-attach for fifteen minutes or when referenced. The main assistant receives history; specialist one-shots do not. Tasks/reminders are injected fresh rather than inferred from history. This is a useful separation of transcript, attachment state and current business state. The read-modify-write conversation JSON and aggressive truncation are not patterns to copy into concurrent durable queue handling.

Ramesh uses durable queue records to reconstruct 32 messages within a 48000-character budget, preserving sent/captured replies, speaker/audience boundaries and timestamps. Private replies use protected references, then fresh evidence recall. The initial increment had only media type/caption markers. [Module 30](30-media-lifecycle.md) subsequently specified and implemented owner-scoped encrypted image/PDF/voice extraction with 24-hour retention; [module 35](35-voice-transcripts.md) defines exact STT quoting. Failed or expired extraction still cannot imply attachment comprehension.

## Anti-patterns to remove

- Discarding useful prior business selections and asking the user to provide known facts again.
- Treating every missing optional field as an intake blocker. Give provisional candidates and say what remains uncertain.
- A CRM-only bot restriction when the server exposes an employee-authorized catalogue.
- Ignoring MCP server guidance while passing only function schemas. Carry bounded server guidance into the reasoning context.
- Making a formatter silently do missing research or fix factual gaps. It selects and formats supported content; the tool loop owns research.
- Sending formatting-only review feedback through another tool reasoning pass. Route it directly to the formatter.
- Treating a long, confident response as intelligence. Evaluate useful next steps and factual support separately from verbosity.
- Optimizing prompts against a single successful transcript, masking failed stochastic trials, or judging against real customer records committed to CI.

## Role

Ramesh is a personal chief of staff for each messaging user, not a dedicated sales persona. It helps with personal planning, work preparation, prioritization, research and drafting. Company tools are available capabilities within current employee permissions. Unknown users retain ordinary chat and drafting. No invented HRMS/calendar/reminder/send capability.

## Revised graph

Trusted employee/context discovery → conversational tool loop → formatter → verifier → delivery receipt. A needed read returns to the same conversation/tool session. Formatting-only repair goes directly to the formatter. There is one bounded repair, with the same tool/latency budgets. A deterministic worker validates each tool proposal; no new planner/worker agent is invented just to increase agent count.

Pass the Context Engine's bounded MCP guidance with its discovered tools. Load company knowledge only for the relevant process/background question; use briefing, details and related notes when those are the right sources. Do not dump all organization data into every prompt or make a policy from an unreviewed CRM note. Tool guidance explains semantics but cannot change the employee boundary or override application constraints.

The conversation prompt should follow an evidence-first work pattern: understand the current task and selection, obtain the missing decisive facts, make a grounded comparison or draft, identify specific next steps, and ask at most one unresolved decision question when useful. Do not manufacture tasks when the user only greets or supplies background. Use medium reasoning for native business tool decisions; use low reasoning for business formatting/repairs and none for ordinary formatting. Record the cost/latency consequences in evals.

## Acceptance

Tests exercise the reported RFQ→shortlist flow, revised use→reranking/questions, context after intervening turns, source failures, company guidance, unavailable media, analytics follow-ups and no execution claims for writes. Retain every real-model trial and report both quality failures and duration. Real-data smoke uses the authorized admin and isolated capture queues, never a WhatsApp session.

When business tools are enabled, the default eligibility is every active employee resolved by trusted phone/LID. `BUSINESS_READ_EMPLOYEE_IDS=all` removes the extra pilot allowlist; an explicit numeric list remains available for deliberate staged rollouts. The capture playground remains pinned to its configured employee. This does not grant an employee roles they lack.

## Refinements found by repeated evaluation

Formatting is a substantive stage: an early trial had both correct per-deal lists in the draft, but formatting replaced the second list with a cross-reference. The business formatter now has its own instructions rather than inheriting the ordinary-chat short-reply prompt, uses low reasoning for evidence-heavy text and repairs, and the review checks each requested group. A code-level chat layout check forces table/code-fence repair independently of semantic approval.

The formatter receives relevant user history and a trusted clock. A repair receives the previous actual reply, and the verifier sees its earlier feedback so it can avoid contradicting its own requested correction. The clock supplies an explicit 24-hour local time instead of asking the reviewer to infer India time from a UTC string. Personal task updates implicitly continue the current objective; standalone news still gets an acknowledgement. The enum of supported correction types does not grant another iteration or a new read budget.

Evaluation judges also need the real context boundary: the harness now passes each turn's actual tool catalogue, active-employee/audience state and clock. A denied employee does not need a successful business read to justify an access limitation. Equivalent relative/calendar dates and valid alternative report groupings should not be scored as wrong merely for differing from one preferred query. Tests still fail actual private redisclosure, wrong filters, ungrounded metrics, incomplete requested work and unsuitable chat presentation.

Measured results and failures remain in the [eval record](../../evals/README.md). Remaining limitations include conservative whole-reply revalidation, several model passes, per-operation MCP connection setup and probabilistic semantic review. These can add latency or occasionally reject an answer whose core facts were useful. No Claude-equivalence claim is established by these tests.

### Final recovery review

The v6 run found a successful overview discarded after an unavailable specialist report. The formatter must receive the same bounded failure/recovery metadata and trusted access state as the reviewer, so shortening a reply cannot turn a failed request into a capability claim. The reviewer must permit a user-requested successful fallback; discovery advertises capabilities but does not prove that a particular report worked. This does not relax source verification or permit failed evidence to support metrics.

The v7 harness makes the unavailable-report fixture consistent with its discovery response, accepts both valid exact-query page groupings in the semantic rubric as well as hard checks, and distinguishes ignoring injected note instructions from a requirement to repeat them to the user. Original failures remain in their original reports. Focused repeated cases and a fresh full run measure the revision, rather than retroactively changing its score.

The full v7 run exposed a separate trace omission: source calls were supplied to the judge, but the application-owned recall execution was only recorded outside its input. One ordinal-reference trial actually recalled and correctly answered, yet the judge said recall was absent. The harness now includes each executed local recall and its returned output in `local_calls`; proposals alone remain insufficient evidence. Three fresh ordinal-reference trials passed with this trace correction. The earlier full-run score is retained without rescoring it.
