# WhatsApp response formatting

WhatsApp uses `*bold*`, `_italics_` and `~strikethrough~`, with a single marker on
each side. Markdown `**bold**` can leave visible extra asterisks in a WhatsApp
message. See the [official formatting guide](https://faq.whatsapp.com/539178204879377/).

Both formatter prompts specify native WhatsApp syntax, simple lists and plain
URLs. Keep syntax examples inside inline code in the prompt files: Markdown
formatters otherwise rewrite single-asterisk examples into underscores.

The shared `finishReply` guard converts balanced, standalone `**bold**` spans to
`*bold*` before the answer is verified, stored or delivered. It preserves literal
code, URLs, arithmetic, escaped markers and unsupported/unbalanced forms rather
than guessing their meaning. This is a narrow formatting repair, not a general
Markdown parser.

Exact voice transcripts are appended afterward by the existing media delivery
layer and are not passed through this cleanup. Offline regressions use fictional
record details and cover native emphasis, repeated cleanup and transcript
preservation. No model evaluation or real WhatsApp test message is needed.
