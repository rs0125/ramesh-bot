# Gmail draft integration

Context Engine owns each employee's Google connection and the `get_email_connection`,
`create_email_draft`, `list_email_drafts` and `read_email_draft` tools. Ramesh discovers their current
schemas and platform permissions through the existing signed employee connection.
Mail tools default to WhatsApp availability. No Gmail refresh token or Google
client secret belongs in the bot configuration, model arguments or WhatsApp reply.

Explicitly grant `mail:drafts` in the worker's `CONTEXT_RAMESH_SIGNING_KEY_JSON`
scope ceiling and the corresponding Context Engine issuer registration. This is
a narrow additional scope; existing grants do not acquire it automatically.
The signing and write-contract validators accept this specific capability without
admitting `mail:send`, arbitrary `*:drafts`, or wildcard scopes. Optional legacy
Context Engine OAuth enrollment also accepts explicitly requested `mail:drafts`;
that enrollment is separate from an employee connecting their Gmail mailbox.

Business writes must already be enabled and their journal migration applied.
The employee connects their mailbox through Context Engine's authenticated `/mail`
page. Read `get_email_connection` before preparing a draft. The create arguments
include the returned `connection_id` and `connection_version`; the reviewed
operation preserves those values so a later reconnect cannot silently select
another mailbox. Context Engine validates the connection again before dispatch.

The existing write lifecycle remains intact: the model prepares one reviewed
proposal, the user receives the exact fields, and a later standalone typed
`confirm CODE` authorizes creation. Proposal, verifier, delivery and recall reads
never execute the write. An uncertain result must be recovered using the same
operation ID and frozen arguments. No send tool is introduced.

Recovery replies expose only application-owned guidance for allowlisted error
codes, independently of the closed mail history policy. A changed connection or
required reconnect leads to connection-check and fresh-proposal instructions
only when the service confirms no draft was created and there is no earlier
uncertain attempt. Pending revocation directs the employee to finish disconnecting
on the connection page before reconnecting. Definite rate-limit rejection keeps
the same approved operation and shows the structured `retry_at` time in IST,
alongside the original approval deadline. If the wait extends beyond that deadline,
the employee must cancel and review a fresh proposal after the wait; approvals
are never extended automatically. An uncertain attempt always
takes precedence over later errors: check Gmail and recover the same operation,
without creating a replacement. Optional structured `recovery.action` can direct
the employee to reconnect the same Google account or finish disconnecting while
keeping the uncertain operation unchanged. Provider error prose and stored email
contents are never copied into these replies.

After an uncertain Gmail operation's approval expires, the journal refuses another
dispatch claim and the service rechecks expiry immediately before any write call.
Its state remains uncertain; it is not marked failed or safely cancelled. Automatic
reconciliation through the create endpoint is unavailable after expiry because a
lost quota-rejection response could otherwise authorize a new creation. The employee
must inspect Gmail directly. A separate read-only reconciliation capability would
be needed to automate recovery after expiry safely.

The WhatsApp preview shows the complete To, CC, subject and plain-text body, with
JSON escaping to preserve their exact contents, and says that this action saves
a draft without sending email. Only a validated, closed draft payload hides the
technical connection and operation identifiers; unknown additional fields use
the generic full-field preview. The connection remains frozen in the stored
arguments and is checked again when the user confirms.
Leading and trailing subject whitespace is normalized before the preview and
stored proposal, matching Context Engine's eventual draft subject.

The existing WhatsApp proposal budget remains 4,800 characters for the serialized
arguments plus summary. Although Context Engine accepts bodies up to 12,000
characters (20,000 UTF-8 bytes), a long body can exceed that smaller proposal
budget. The bot rejects it before storing a proposal and asks for shorter
content; it never truncates the text being authorized.

Successful `create_email_draft` receipts have this strict data shape:

```json
{
  "draft_ref": "22222222-2222-4222-8222-222222222222",
  "mailbox": "employee@example.com",
  "subject": "Warehouse options",
  "status": "draft",
  "provider": "gmail"
}
```

The subject is one line and at most 200 characters. Ramesh validates these fields
before displaying the mailbox, subject and a deterministic saved/not-sent message.
Malformed receipt data produces no mailbox, subject or link. Replayed creation
receipts explicitly describe a past save and do not claim to verify the draft's
current Gmail status. Source tokens and draft bodies are excluded from the success
message. Draft write history stays closed; subsequent content reads use
`read_email_draft` and current connection authorization.

For “read that draft”, use `list_email_drafts` to recover creation references from
the current employee and active mailbox connection, then read the selected
`draft_ref`. The list contains references and creation timestamps only, newest
first, with a bounded page size and `nextCursor` for older entries. It does not
redisclose historical bodies, recipients or subjects, nor prove that a draft
still exists. Clarify an ambiguous selection rather than assuming the newest
entry is necessarily the one intended. Reconnecting the same verified Google
account preserves saved references and cursors; a different Google account cannot
use them. Reconnection still invalidates unexecuted creation proposals, while an
uncertain creation must continue recovery of the same operation. Current content
and permission are checked again before delivery.
Retrieval timing stays in the standard `meta.generatedAt` envelope so a fresh
check of unchanged content does not invalidate its delivery fingerprint.

Read failures marked `error.domain=gmail` retain only allowlisted source codes
and recovery actions. A mailbox reconnect does not invalidate Context Engine
credentials or disable unrelated reads; `get_email_connection` remains available
for its verified connection link. Employee and Context authorization failures
still stop access. Structured read backoff supports up to 86,400 seconds without
shortening the cooldown or exposing provider error prose.

The success reply includes the application-owned fixed link
`https://mail.google.com/mail/#drafts` and tells the user to choose the stated
mailbox. It opens Gmail's Drafts folder, not a particular draft. API draft IDs are
never converted into invented Gmail deep links. Stable per-draft links remain
deferred. No provider-returned URL is used by this presentation path.

Focused deterministic tests cover scope admission, read/write separation, receipt
validation, replay wording, the typed confirmation boundary, frozen connection
arguments, delivery authorization and closed history. They use synthetic ports and
make no Google, model or WhatsApp requests.
