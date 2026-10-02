# Live-data playground and captured delivery

Specified before implementation on 2 October 2026; now implemented and verified with live signed reads as Raghav. This supplements the synthetic playground: the user requested real Supabase and Context Engine reads with no WhatsApp delivery. Commands, provisioning and validation evidence are in the [runbook](../live-data-playground.md).

## Contract and boundaries

The separate `dev:chat:live` entry point binds to loopback and loads a private harness configuration. The browser selects only the configured employee or a synthetic unknown user, plus DM/group audience. Employee ID, signing key, database login and capture transport are server-owned. This is an explicitly authorized operator test identity, not proof of an incoming WhatsApp message.

The pipeline is: browser → `ramesh-test-inbound-queue` → shared LangGraph/verified CRM read → `ramesh-test-outbound-queue` → browser capture. The existing production queue repository and Baileys session factory are never constructed. The outbound table has a capture-only transport constraint and no WhatsApp address field. There is no switch to promote its rows to real delivery.

The restricted `ramesh_playground` database login may operate only on the test tables and SELECT the four identity columns of `VerifiedNumber`, with a SELECT row-security policy scoped to that login. It cannot read or write production message queues. The production `ramesh_worker` has no test-table access. Startup verifies role attributes, memberships, cross-queue denial, roster privileges and actual employee visibility; selecting an owner or production login fails. Existing database-wide PUBLIC extension grants remain outside this application-table boundary.

The harness resolves the configured active employee through the live roster, constructs an employee-pinned signed MCP credential resolver, and uses the same fixed CRM read and verifier as production. Unknown users and groups cannot reach business reads. Context Engine retains its independent live authorization. No employee OAuth grants, real device state or SQLite database is used by this entry point.

## Storage and lifecycle

Test inbound rows contain namespace, conversation, configured employee, simulated actor/audience, an authenticated encrypted input, request fingerprint, timestamps, processing state, bounded attempts and fenced lease. The namespace is generated during setup and stored in the private environment. Browser-supplied request UUIDs are idempotent only for identical input and identity.

The harness claims work on demand; pre-finalization failures can retry the same request after lease recovery, within expiry/attempt limits. It does not automatically send or execute abandoned browser requests after a restart. Finalization atomically completes the input and inserts one encrypted captured output; a failed display-time check subsequently marks that output suppressed. Retrying a finalized request reuses the saved output rather than regenerating it. Event receipts are encrypted in `ramesh-test-agent-events` and tied to the current lease. Retention is 24 hours, with cleanup at startup and during use.

Before returning sensitive output to the browser, repeat the identity/scope/result check used by production delivery. Retrieving a stored result also rechecks authority and evidence; stale/revoked output becomes suppressed. A successful empty CRM result is distinct from an unavailable source. Private business reply bodies never enter model history; delivered answers contribute only a content-free completion marker. Conversation history is scoped to namespace, employee, simulated actor, audience and conversation.

## Configuration and operations

`PLAYGROUND_DATABASE_URL`, `PLAYGROUND_DB_SSL_CA`, `PLAYGROUND_NAMESPACE`, `PLAYGROUND_EMPLOYEE_ID`, `PLAYGROUND_EMPLOYEE_LABEL` and `PLAYGROUND_ENCRYPTION_KEY` live in a gitignored mode-0600 harness environment. The existing OpenAI settings and signed Context Engine configuration are copied by key name from private source files during setup, never printed. An explicit administrative env file is used only by provisioning. Provisioning supports transaction rollback/dry run and repeatable checksums, and does not apply pending production-worker migrations.

Real data is clearly labelled in the GUI. The configured employee label is escaped before HTML rendering. Existing loopback, Host/Origin validation, random per-process request token, bounded bodies and cancellation protections remain. Test output is CAPTURED, never SENT. Model and Context Engine usage is real; lead details are not written to evaluation reports or normal terminal logs.

## Acceptance

- Real SQL tests verify test-table grants, production queue denial in both directions, encrypted storage, atomic handoff, duplicate requests, stale-owner rejection, retention and saved-output replay.
- Synthetic service tests verify actor pinning, group/unknown denial, private-history exclusion, revocation before display and cancellation.
- An explicitly requested live smoke test uses Raghav's roster binding, real signed MCP reads, the real model and Supabase capture, printing only status/counts. No Baileys factory or production queue receives work.
- Existing deterministic/fixture evaluations remain the repeatable CI path; live CRM state is not asserted to contain fixed records or fixed counts.

## Architectural rationale

The outbox separates durable result production from the delivery adapter. AWS documents atomic outbox persistence and idempotent consumers in its [transactional outbox guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html). Supabase documents distinct queues, explicit consumers and [queue permissions](https://supabase.com/docs/guides/queues/quickstart). The isolated capture adapter is the recommendation for this application; a mutable test flag alone would leave too much responsibility in the real sender.

Provider sandboxes are another established technique: [Twilio test credentials](https://www.twilio.com/docs/iam/test-credentials) simulate supported messaging operations without connecting to real numbers. Baileys has no equivalent provider test account here, so the harness replaces delivery locally while retaining real, authorized business reads.
