# Voice transcripts before the answer

Spec written before implementation, 2 October 2026. This extends [media lifecycle](30-media-lifecycle.md) and [durable debounce](32-inbound-debounce.md).

## User outcome

A voice message produces its transcription in quotation marks and italics, then the assistant's answer. A burst of forwarded audio produces all of that turn's transcriptions in receipt order, then one common answer. Use the exact STT text, not a model rewrite, translation or summary. “Exact” refers to the transcription result; it does not guarantee perfect speech recognition. The response can explain uncertainty without modifying the quoted text.

Use WhatsApp underscore emphasis, for example `_"Please check tomorrow's visits."_`. For multiple notes, label Voice note 1, Voice note 2 and so on. The playground displays the same quoted text with an `em` element using text nodes, never HTML from a transcript. Do not apply assistant style rewrites to quoted source text. Failed or expired audio gets an explicit notice instead of invented or silently missing words. Exceptionally long extracts must be labelled as excerpts outside the quotation; preserve the existing message-size bound and never call a truncated extract complete.

## Key and provider configuration

The reference logistics bot uses OpenAI audio transcriptions, `OPENAI_API_KEY` and `OPENAI_TRANSCRIBE_MODEL` (configured as `gpt-4o-transcribe`). Reuse that existing authorized credential through `OPENAI_STT_API_KEY`, independently of the Responses model key. Fall back to `OPENAI_API_KEY` when the STT setting is absent. Default the transcription model to `gpt-4o-transcribe`; allow the same explicit model setting as the old bot. Keep secrets in ignored local environment files, never fixtures, reports, command arguments or logs. Runtime configuration takes values, never a hard-coded sibling repository dependency.

Transcription continues to use `/v1/audio/transcriptions` after bounded pipe-only audio normalization. It works for voice notes and forwarded audio. No Twilio credential is needed: Baileys or the capture upload adapter supplies the bytes. The current [OpenAI transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text) documents this API. The provider model, audio bounds, failures and cancellation remain separate from the graph's reasoning settings.

## Delivery and retention

Render quotes deterministically after the graph verifies its answer and after business delivery authorization. The graph receives untrusted extraction context, not permission to rewrite the delivery transcript or change its owner. Save only ordered media references alongside the generated answer in the encrypted outbound payload. Resolve transcripts through the owner-scoped media service at delivery, including restart/retry. Do not place duplicate transcripts in the 30-day inbox, conversation history or run traces. A later ordinary question must not echo old voice notes.

Store media kind and truncation status with the encrypted extraction envelope, supporting old text-only extracts. No schema migration is required. Capture and production keep their separate media tables and queues. The capture sink exposes only the quoted display data and answer, never storage owner keys or encrypted payloads. Expired/reset media cannot be recovered by replaying a saved outbound reference. Business answers retain their existing freshness/identity preflight; transcripts cannot bypass it.

## Burst behavior

Keep the existing receipt-time sliding policy: text 1 second, audio/forward 3 seconds, maximum collection 8 seconds. Forward markers remain untrusted provenance, not employee identity. Store every incoming original and close membership atomically before generation. Downloads and STT may finish out of order; quote order must use the original batch order. Duplicate redelivery cannot add a repeated transcript or extend the debounce. One batch generates one answer and one outbound item.

## Validation

Cover single and multiple audio, forwarded voice plus typed summary, out-of-order extraction, duplicate delivery, restart, owner isolation, failed/expired media, transcript punctuation/markup, response size, excerpt labels and no raw transcript in stored history. Verify the configured STT key is used only by audio requests and the Responses key remains separate. Use generic generated audio with the real reused key; use Supabase capture queues and the real Context Engine for end-to-end testing. No test may establish a WhatsApp session or send to a person.
