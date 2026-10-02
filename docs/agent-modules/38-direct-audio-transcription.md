# Direct audio transcription

## Decision and evidence

Send accepted audio bytes directly to OpenAI's transcription endpoint, preserving
their MIME and using an application-generated filename with the matching extension.
Remove mandatory runtime ffmpeg conversion and its CI/bootstrap dependency.

The old logistics bot's `src/services/voiceService.js` uploads the original bytes
as `voice.<extension>` through multipart FormData. It has no ffmpeg step. A direct
API smoke on 2 October 2026 sent one fictional Ogg/Opus voice note unchanged to
both `gpt-4o-transcribe` and `gpt-transcribe`; both succeeded and retained the visit
day and gate identifier. The private result is
`.local/media-smoke/direct-ogg-check.json`.

The current [OpenAI file-transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text)
lists MP3, MP4, MPEG, MPGA, M4A, WAV and WebM and a 25 MB upload limit; it does not
list Ogg. Ogg acceptance here is observed API behavior, not a claim that this guide
documents it. Recheck the compatibility smoke when changing provider/model.

## Boundary

- Keep the existing allowed media MIME/signature checks, 8 MiB input limit,
  encrypted ownership, 24-hour retention, extraction concurrency and cancellation.
- The processor also rejects empty/oversized audio and unknown audio MIME types
  before calling the API. Generated filenames cannot contain user paths.
- Preserve the separate STT key/model, bounded provider timeout and existing error
  handling. A provider decode rejection is a failed extraction, not an empty or
  invented successful transcript. Do not silently call a second model.
- No subprocess, transcoding or decompression runs in the worker. Media lifecycle,
  debounce, exact transcript quotation and the common batch answer are unchanged.
- ffmpeg may remain an operator tool for creating fictional benchmark audio in
  `eval:stt`; it is not required to run the bot or ordinary CI tests. The already
  installed EC2 package can remain unused; no unrelated host packages are removed.

## Verification

Check that the real OpenAI SDK sends the original bytes/MIME and independent STT
credential for each admitted audio format. Reject unsupported, oversized, empty
and already-cancelled input before network calls. Preserve explicit API errors.
Run the real API voice batch through Supabase capture queues again. Keep earlier
normalized-audio benchmarks historical and identify new direct-upload results
separately. Commit and push the follow-up through the same CI/CD pipeline.

The final local check passed 224 deterministic tests with a disposable PostgreSQL
database, plus schema validation, type checking, build and formatting. The real
API/Supabase capture smoke passed all 10 checks: three forwarded voice notes and
one summary request became one batch, with ordered exact quotes, one common
answer and a later media-aware follow-up without repeated transcript metadata.
WhatsApp delivery stayed disabled. The initial smoke's order matcher rejected
the spelling `floorplan`; its output was correctly ordered. Both that result and
the successful rerun after accepting either spelling remain private under
`.local/media-smoke/direct-stt-quotes*.json`.
