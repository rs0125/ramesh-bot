# Per-chat queue concurrency

Status: **deployed on 3 October 2026 in [e0b7232](https://github.com/rs0125/ramesh-bot/commit/e0b723290478da646809af1542a343d49b913b07).** WhatsApp is connected, the effective concurrency is three and production schema health checks pass.

## Contract

Different chats on one WhatsApp account may progress concurrently, with at most three active jobs by default. A configurable limit applies both in the consumer and in PostgreSQL, including overlapping worker processes. Every conversation preserves admission order across incoming turns, finalized replies and operator messages. A turn retains its place through retries and the inbound-to-outbound handoff. Debounced children belong to their root turn; a burst never absorbs messages across an intervening turn by another sender or an operator.

## Persistence and coordination

The message ledger assigns a monotonic admission sequence. Queue claims take the existing short account-scoped transaction advisory lock, recover expired leases, enforce the active-lease ceiling, and select the oldest eligible conversation head. Pending/debouncing/retrying work blocks its own chat only. Only one outbound delivery lease is allowed per account, preserving existing WhatsApp send pacing. No database transaction remains open during model, tool or transport work. The existing random lease token fences all mutations. Renewals extend only a still-valid token and stop at message expiry; a lost lease aborts the task. Completion and handoff still validate token ownership.

The consumer owns a bounded set of promises, wakes when a task finishes, and drains all owned work on disconnect before reconnecting. Cancellation stops new admission to the consumer and releases only work known not to have invoked the transport. Ambiguous sends keep the existing UNCERTAIN behavior and are never automatically resent. Durable replay checkpoints use the trusted inbound job ID and current lease, independently of scheduler slot or process identity.

## Verification

Offline tests use synthetic messages and local PostgreSQL: concurrent chats versus ordered same-chat turns; account cap across competing repository instances; admin ordering; debounce barriers; retry/lease expiry and fencing; consumer cancellation/draining; and lease loss. Tests never connect to WhatsApp, call a model, or query business data. Fresh installations must apply the queue migration before starting the worker; old serial workers remain safe during the transition, but the health check rejects an unmigrated schema. Production migration `202610030004` is applied; the deployed release also includes `202610030005` for replay. CI and CD passed, with no paid evaluations or test WhatsApp sends.
