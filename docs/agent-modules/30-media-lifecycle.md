# Private media and next-day context

Status: implemented locally; validation results are in the [dated record](../../evals/results/2026-10-02-sol-graph-media.md). User-selected retention: 24 hours.

## Outcome and boundary

Read images, PDFs and voice notes supplied by the current sender. Three forwarded notes and a summary request can become one ordered turn. Original WhatsApp messages are untouched. Unknown users may discuss their own attachments but cannot read business sources. Media content is untrusted evidence, including any instructions printed or spoken inside it.

## Storage contract

Store each attachment under an opaque ID bound to deployment/account, conversation and sender. Use a new explicitly named Ramesh media namespace. Retain encrypted bytes and encrypted extracted text in Supabase/Postgres for this first implementation, with a hard per-file bound; avoid adding public object URLs. A storage port allows later migration to a private object bucket. The encryption envelope binds each field to its attachment ID. No bytes, transcript, filenames or credentials go into traces.

Keep original MIME and a sanitized filename as encrypted metadata. Validate supported MIME against file signatures, byte limits and audio/container support. Reject arbitrary URLs and model-supplied download locations. WhatsApp downloads use the decoded trusted Baileys message; playground uploads use a size-bounded authenticated loopback endpoint. Never expose a media download endpoint to the browser.

## Processing and context

Create durable pending metadata before analysis; use leases to recover crashes. Deduplicate by trusted source message and content hash. Download/transcribe concurrently with burst collection where the transport supports it. Voice notes use transcription; images and PDFs use Responses inputs with store:false and bounded extraction instructions. Do not claim unread files were understood. Store an explicit ready/failed state and a safe failure code. Failed attachments remain visible as failures to the assistant so a summary cannot silently omit them.

Current-turn attachments are always included. Recent attachments can be referred to in a later turn for up to 24 hours; do not repeatedly attach all previous media to unrelated questions. Keep an ordered manifest with opaque IDs, type, arrival time, processing status and bounded extracted content. Explicit references select recent same-owner media; ambiguity should be clarified rather than borrowing another person's file. Derived extracts expire with their original media. Conversation history stores attachment references, not permanent copies of full transcripts.

## Expiry and deletion

Expiry is checked on every read, not only by a cleanup timer. At 24 hours the bytes/extract are inaccessible even if cleanup is delayed. A periodic bounded purge removes expired rows only from this new namespace. Reset/forget removes the conversation's media and clears context. Cleanup is idempotent and safe across restarts, and does not touch warehouse assets or legacy bot media. Synthesized chat replies may contain user-requested summaries under the normal chat retention policy; the 24-hour rule covers bot copies and derived extraction records, not deletion of the original WhatsApp thread.

## Validation

Tests cover spoofed MIME, oversize data, cross-sender/group/session isolation, duplicate ingestion, encrypted storage, expiry before cleanup, failed extraction, cancelled requests, cleanup retry, no public URL and three ordered audio notes. Live tests use generated non-private media and real API processing in capture mode. Test files containing business data stay under .local/private-evals.

API references: https://developers.openai.com/api/docs/guides/file-inputs, https://developers.openai.com/api/docs/guides/images-vision, https://developers.openai.com/api/docs/guides/speech-to-text.

## Implemented limits and transport details

Supported inputs are JPEG/PNG/WebP, PDF and Ogg/WAV/MP3/MP4/WebM audio with matching signatures. Files are at most 8 MiB, with eight per batch, 24 retained files per owner, and 500 files/512 MiB per namespace. Up to three extraction jobs run concurrently. Images/PDFs use bounded model extraction; this is a potentially lossy derived representation, not an exhaustive document index. Audio is normalized in a pipe-only ffmpeg child with a scrubbed environment, fixed demuxer, bounded output and deadline, then transcribed. No public file URL or provider Files upload is created.

The GUI accepts one file per message and up to eight separate messages in a batch. Production supports up to sixteen messages and eight attachments per batch. Group reply admission still requires a real bot mention; media forwarded to an unmentioned group is not automatically downloaded. Later explicit media references retrieve at most eight unexpired files owned by that conversation/sender. Raw extracts never enter ordinary durable chat history. The 32-message history and 24-hour media retention are separate policies.

Production uses `ramesh-media`; capture uses `ramesh-test-media`. The separate database roles deny cross-reading. Cleanup runs every minute and processes bounded pages; reads deny expired rows immediately even during a cleanup backlog.

Concurrent download completion never sets the current burst order: attachment references are joined to their original message positions. Retained media creation/expiry uses the trusted server receipt time, including queue recovery, so subsequent ordinal references preserve chronology after out-of-order downloads.
