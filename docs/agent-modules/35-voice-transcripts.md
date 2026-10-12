# Voice transcripts before the answer

Spec written before implementation, 2 October 2026; input and retention behavior revised at the user's request on 13 October 2026. This extends [media lifecycle](30-media-lifecycle.md) and [durable debounce](32-inbound-debounce.md).

## User outcome

A voice message produces its transcription in quotation marks and italics before reasoning starts, then the assistant's answer. The same exact text becomes the agent's ordinary input for any request: questions, research, scheduling, writes or conversation. A burst of audio produces separate transcript replies to the original notes in receipt order, then one common answer. Use the exact STT text, not a model rewrite, translation or summary. “Exact” refers to the transcription result; it does not guarantee perfect speech recognition.

Use WhatsApp underscore emphasis, for example `_"Please check tomorrow's visits."_`. Long complete transcripts split into numbered text messages without dropping characters; the agent still receives the complete input, subject to the existing 32,000-character turn limit. Failed, empty or truncated speech grants no command authority. When it is the only input, send an explicit resend/type notice. In a mixed turn, mark that note unavailable and let the agent handle the other complete messages. Forwarded and quoted provenance remains attached to the original message; an echo does not turn someone else's speech into a new authorized user instruction.

The final answer remains limited to 16,000 characters and no longer repeats the transcript. Existing queued replies and capture adapters retain their legacy media-reference renderer, including its bounded excerpt behavior. No additional model call is needed for echoing or saving a transcript.

## Key and provider configuration

The reference logistics bot uses OpenAI audio transcriptions, `OPENAI_API_KEY` and `OPENAI_TRANSCRIBE_MODEL` (configured as `gpt-4o-transcribe`). Reuse that existing authorized credential through `OPENAI_STT_API_KEY`, independently of the Responses model key. Fall back to `OPENAI_API_KEY` when the STT setting is absent. Default the transcription model to `gpt-4o-transcribe`; allow the same explicit model setting as the old bot. Keep secrets in ignored local environment files, never fixtures, reports, command arguments or logs. Runtime configuration takes values, never a hard-coded sibling repository dependency.

Transcription uses `/v1/audio/transcriptions` with the original accepted audio bytes. It works for voice notes and forwarded audio without a runtime ffmpeg dependency; [module 38](38-direct-audio-transcription.md) records the direct Ogg compatibility checks. No Twilio credential is needed: Baileys or the capture upload adapter supplies the bytes. The current [OpenAI transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text) documents this API. The provider model, audio bounds, failures and cancellation remain separate from the graph's reasoning settings.

## Delivery and retention

Persist the complete transcription in the original encrypted inbox message before echoing or reasoning. It follows ordinary message retention (30 days), independently of the audio/extraction store's 24-hour lifetime. Conversation history and summaries can use this normal input; all source-reading tools receive the same text. Keep the original audio kind, sender, forwarding and quote metadata. Previously stored audio without a transcript continues to use the legacy temporary hydration path.

Persist echo status separately from the eventual answer under the original message's encryption envelope. Updates require the current unexpired inbound lease and exact batch membership. Claim the echo before the transport call; after an ambiguous send or process interruption, do not automatically repeat it. Show unconfirmed echoes as uncertain in the inbox. A feedback failure cannot erase a valid input or prevent the agent from using it. A recovered turn reuses the saved input even after media deletion. The assistant sees the user's transcript once in history, not a second assistant copy of its own echo.

No schema migration is required. Saving input is a required durable-repository capability; tests cannot silently select the old path by omitting it. Media bytes and temporary extracts still expire normally. Business answers retain their existing freshness/identity preflight; sending the user's own transcript grants no business access. Echoes use best-effort progress delivery, separately from the final-answer outbox: a crash after claiming an echo can leave it unsent and uncertain. The echo can be delivered even if a later answer or business operation fails.

## Burst behavior

Keep the existing receipt-time sliding policy: text 1 second, audio/forward 3 seconds, maximum collection 8 seconds. Store every incoming original and close membership atomically before generation. Downloads and STT may finish out of order; echo order uses the original batch order. Duplicate redelivery cannot add a repeated transcript or extend the debounce. One batch generates one common final answer after its transcript echoes.

## Validation

Local deterministic tests cover ordinary spoken questions, later references after media deletion, shared tool-source reads, multiple forwarded notes, out-of-order extraction, duplicate admission, restarts before and during echo delivery, owner/lease isolation, uncertain partial echo delivery, failed/empty/truncated STT, usable mixed turns, exact punctuation and Unicode-safe long-transcript splitting. Use the real durable consumer with isolated PostgreSQL through Podman and a capture-only WhatsApp session. The legacy playground adapter is not an end-to-end test of this path. STT provider/key configuration is unchanged; real speech-recognition smoke tests need the original audio, not a transcript replay.
