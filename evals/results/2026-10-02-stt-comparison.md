# Transcription model check, 2 October 2026

`gpt-transcribe` is the strongest next candidate to evaluate for Ramesh: it works
with the existing OpenAI STT credential, supports multiple-language and terminology
hints, and lists a lower per-minute price than the legacy model. This is a
recommendation based on integration fit and published features, not a claim of
superior accuracy on real WareOnGo audio. The local runtime remains configured as
`gpt-4o-transcribe`; changing `OPENAI_TRANSCRIBE_MODEL` selects another supported
OpenAI transcription model without changing the chat model.

| Model                                          | Published base price per minute | Integration                               |
| ---------------------------------------------- | ------------------------------- | ----------------------------------------- |
| GPT-Transcribe                                 | $0.0045                         | Existing key and endpoint; tested         |
| GPT-4o Transcribe                              | ~$0.006                         | Current configuration; tested             |
| GPT-4o Mini Transcribe                         | ~$0.003                         | Existing key and endpoint; tested         |
| ElevenLabs Scribe v2                           | ~$0.00367 ($0.22/hour)          | Separate provider/key/adapter; not tested |
| Deepgram Nova-3 Multilingual, prerecorded PAYG | $0.0052                         | Separate provider/key/adapter; not tested |

Prices are base API rates, before applicable plan conditions, add-ons and taxes.
OpenAI's legacy per-minute figures are estimates from token-based pricing.
Sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing),
[GPT-Transcribe features](https://developers.openai.com/api/docs/models/gpt-transcribe),
[Scribe API pricing](https://elevenlabs.io/pricing/api),
[Deepgram prerecorded pricing](https://deepgram.com/pricing).

## Actual API comparison

Command: `npm run eval:stt`. Four fictional scripts, two trials, three models:
**24 API trials, all retained**. Local espeak-ng speech was compressed to 16 kbps
mono Ogg/Opus and passed through the same bounded ffmpeg normalization and OpenAI
adapter used by the application. No real voices, CRM data or WhatsApp transport.

| Model                  | English semantic checks | Hindi/mixed-script checks | Median elapsed |
| ---------------------- | ----------------------- | ------------------------- | -------------- |
| gpt-4o-transcribe      | 4/4                     | 0/4                       | 1.42 s         |
| gpt-4o-mini-transcribe | 4/4                     | 0/4                       | 1.63 s         |
| gpt-transcribe         | 4/4                     | 0/4                       | 1.35 s         |

English checks cover visits, dates, gate identifiers, required items, corrected
area numbers and negation. The synthetic Hindi segments were poorly recognized
by every model, sometimes as the wrong language/script or with omitted segments.
These results do not establish an accuracy ranking for natural Hindi/Hinglish.
The small latency sample includes network and normalization and is not a reliable
performance ranking. No language/keyword hints were supplied in this baseline.

Run: `.local/stt-evals/2026-10-02T11-15-33.924Z-e5588561`.
The raw failure results remain intact. Before changing the runtime for multilingual
accuracy, use representative consented recordings with human-checked references,
including background noise, numbers, names, negation and code-switching. Compare
optional language/term hints separately rather than quietly changing one model's
input. The repeatable runner is opt-in and does not make the ordinary CI suite
fail because synthetic multilingual speech is not representative.
