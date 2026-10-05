# Conversation context

Status: **Implemented, opt-in for verified employee DMs. Migration and enablement are separate deployment steps.**

## Enablement and storage

Apply message migrations through `202610050001_conversation_context.sql`, then set `AGENT_CONTEXT_ENABLED=true`. It defaults to false. Use `AGENT_TIMEOUT_MS=240000` and `AGENT_MAX_OUTPUT_TOKENS=6000` for summarization plus research/review. Startup checks the new table when enabled; it does not auto-migrate.

`ChatContext.prepare` combines the inbox source, encrypted PostgreSQL store and a freshly resolved employee. State lives in `public."ramesh-conversation-context"`. Account, chat, employee ID, canonical phone and email determine the scope. A new binding starts at the current message rather than adopting history with unknown ownership. Each chat has one active owner binding; changing owners replaces the old state, including when a previous owner later returns. A denied identity receives no private history. Groups retain the existing 32-message/48,000-character shared window; persistent group pins require a membership policy and are not enabled.

The source cursor independently orders inbound admission and **sent** outbound events, preserving PostgreSQL microseconds. Future replies and unsent drafts are excluded. Late replies remain eligible after an earlier inbound event was summarized, but their originating request must be inside the current owner/forget boundary. Summary and cursor commit atomically with a revision check; production reads and saves require the current inbound lease. No transaction stays open during inference. Summarization runs before the turn's checkpoint replay sequence.

Memory commands and model replies carry an encrypted owner binding through the existing protected outbox. Delivery freshly resolves that binding; revocation, reassignment, changed owner attributes or disabled memory authorization suppress the private reply. Mixed responses retain their business, personal and committed-write checks, with another memory identity check after remote preflight. Memory-only historical reply text is restored only after the current context owner matches the saved binding. Legacy history readers cannot unwrap these replies.

## User commands

| Command             | Behavior                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `/pin name: text`   | Creates or replaces a named pin in this chat.                                                                                         |
| `remember that ...` | Creates a note and returns its name.                                                                                                  |
| `/pins`, `/pins 2`  | Lists stored notes in pages that fit the 16,000-character reply limit; the reply gives the next-page command.                         |
| `/unpin name`       | Removes that pin and resets generated working notes/history so the preference cannot reappear from old history. Other pins remain.    |
| `/forget context`   | Clears pins, summary and remembered selections and advances the history boundary. Inbox/action records retain their normal retention. |

Commands must match the original unquoted, unforwarded single message. Batches and extracted media cannot mutate pins. Commands save before acknowledging success and are idempotent for a retry of the same message. Limits: 24 pins, 1,000 characters each, 4,000 estimated tokens combined. Explicit pins remain until removed.

## Summaries and references

Compaction starts above 32 unsummarized messages or 10,000 estimated history tokens. It keeps a recent verbatim tail, normally 16 messages, and summarizes bounded older chunks. Notes track objectives, constraints, corrections, decisions, pending questions and completed work with source IDs. Output must pass the schema, use supplied source IDs and fit 3,000 estimated tokens. Invalid output leaves the last saved cursor intact; it does not silently discard messages. Summarization excludes protected business reply bodies and attachment extracts.

Each historical entry has an application-owned event timestamp and a 4,000-token selection ceiling. Entries above 6,000 characters or that token ceiling use explicitly marked head/tail excerpts; historical user input above the 32,000-character maximum supported input size is represented by an omission notice. The original inbox text is retained under its existing policy. The assistant must ask for missing passages when needed and cannot infer omitted requirements. This applies only to old history, not the current request or fresh tool evidence. Literal tokenizer markers are counted as ordinary text. One historical entry cannot prevent all later turns from advancing.

Up to four warehouse lists retain at most 32 IDs and original positions each, independently of the recent-message window. They contain no cached record facts. `recall_business_context` checks the current employee and freshly reads those records. Unavailable positions are not replaced or renumbered. Old prose receipts keep their existing 24-hour/96KB limits. Named CRM selections and grouped-list disambiguation remain extensions.

Generated notes expire 30 days after their oldest cited source, rather than 30 days after the latest merge. The application assigns expiry from source timestamps and carries the earliest prior expiry forward; models cannot extend it. Expired recent messages are also withheld. Legacy notes without expiry metadata are discarded on load into a turn, while pins and the history boundary remain. Reference lists keep their original 30-day expiry. Minute-by-minute maintenance deletes unpinned idle rows and clears old generated state from pinned idle rows. Only explicit pins are indefinite. Unknown ownership, unavailable storage and invalid summary output fail closed.

Memory is historical source data, not authorization, current business evidence or proof of a completed write. Current corrections supersede older notes. Current requests and the existing personal/business journals remain authoritative for actions; `ramesh-write-events` is unchanged. Prompt caching does not replace memory.

## Token admission and native compaction

The local `o200k_base` tokenizer estimates which history fits. With the feature enabled, `responses.inputTokens.count` counts the **complete rendered request**, including instructions, schemas, tools, history and current evidence, before generation. Input caps are 24k for routing/summary, 48k for planning, 64k for formatting/review and `AGENT_CONTEXT_MAX_INPUT_TOKENS` (default 96k) for the worker. Output has a separate cap. Oversized requests fail before generation; current requests and evidence are not silently truncated. Formatting/review receive memory and the latest eight ordinary messages.

Worker requests enable `context_management` at `AGENT_CONTEXT_COMPACT_THRESHOLD` (default 64k), with `store:false`. The adapter accepts encrypted compaction items, prunes covered history and preserves function-call/result pairs. Checkpoints encrypt and replay native response items. Static instructions and tool definitions stay stable; remaining tool budgets appear in a trailing developer message.

The usage meter allows the non-generating input-count endpoint and meters generating responses, including automatic compaction usage. Summary, agent and reviewer share the model/key and campaign cap in evaluations.

## Verification

Deterministic coverage includes pin replacement and forgetting, forwarded commands, owner changes, expiry, summary provenance failure, encrypted restarts, concurrent revisions, SQL lease fencing/RLS, microsecond ordering, token admission, encrypted compaction continuations and fresh reference reads. Native compaction uses fake provider responses in tests; short live conversations do not exercise a 64k worker threshold.

Adversarial regressions cover send-time identity changes, mixed-receipt authorization, encrypted outbox restart, literal special-token strings, rejected oversized history, token-dense excerpts, expiry across repeated summary merges, legacy undated notes and multi-page pin listings. These checks use synthetic data and fake models/transports; PostgreSQL tests use only an isolated local test database.

[Local context evaluations](../../evals/README.md#local-context-evaluation-with-real-reads) use real read tools with local state and private transcripts. Deployment, migration and runtime enablement remain separate from implementation.

The implementation follows [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction), [input counting](https://developers.openai.com/api/docs/guides/token-counting) and [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). App-owned structured memory complements native within-run compaction.

The initial three real-data Luna scenarios passed **2/3**, spending **$0.03552** under the approved $2 cap. Selection after restart and forgetting before switching to CRM passed. The correction scenario persisted the corrected requirement but omitted it from the final answer. The memory instructions were strengthened afterward and the stage handoff was covered by an offline regression. No extra paid scenario was run; the prompt change still needs a future live validation. Private transcripts and original failures remain local.
