# Business follow-up recovery

Release status, 3 October 2026: this release includes the follow-up recovery changes below. They need no new migration or credential themselves. The accompanying scheduling migration `202610030008` is applied and verified in production. Worker rollout uses CI/CD after pushing `main`; verify the exact deployed release and runtime health before declaring completion.

## Incident and evidence

A warehouse shortlist was followed by requests for per-ID pros/cons and an explanation of locality labels. Both failed with the generic verifier-exhaustion reply. Read-only inspection of encrypted production messages and tool events established:

- The first failed comparison fetched all five requested warehouse details successfully. This was not a missing employee grant or unavailable warehouse API.
- Its initial recall refreshed all 13 saved source checks with matching fingerprints. Later, refreshing a CRM source replaced its internal evidence ID. The graph discarded the entire recalled answer whenever any old evidence ID disappeared, even if the replacement had identical business content.
- A later locality follow-up consumed all 24 business calls. Its saved receipt included earlier unrelated research, so replaying every previous check carried that work into subsequent turns.
- After two rejected semantic reviews the graph discarded the draft and told the user to narrow the request. Production did not retain the review reason: completed model checkpoints are deleted and tool events do not contain reviewer feedback. The exact rejected claim cannot be reconstructed from this incident's surviving records.

An additional latent issue was confirmed in code: any changed query fingerprint hid the whole old answer, while receipts stored source queries and recordset hashes rather than the subset and order actually displayed.

The incident's private plaintext diagnostic stays under ignored `.local/`; committed tests contain synthetic records only. No paid model calls or WhatsApp test sends were used.

## Recall contract

Accepted business replies can add `displayedRecords` to their existing encrypted delivery receipt. The initial supported presentation type is an explicit numeric warehouse `ID 123` or `ID: 123` label. Numbered warehouse entries take precedence over surrounding mentions; otherwise capture follows first displayed occurrence. Capture preserves original positions and requires that the ID exists as an actual entity in successful warehouse search, detail or assessment evidence. Arguments, arbitrary numbers and assessment input lists alone do not establish a displayed record. This does not yet persist named CRM or knowledge selections.

On follow-up, recall resolves those exact warehouse IDs through the employee's current `read_warehouse` permission. It returns:

- `displayed_selection`: freshly authorized IDs, original positions and current evidence references;
- `selection_status`: complete, partial or unavailable;
- `fresh_evidence`: current detail records, bounded by the tool-output size limit;
- no historical factual prose from the selection path.

Unavailable IDs are not returned, remaining entries keep their original positions, and another warehouse is never substituted. A partial detail recall permits one bounded retry, reusing successful current reads and replacing the earlier same-turn recall projection after recovery. An old receipt with explicit ID labels can take the same path: historical labels are lookup targets, not permission. Each ID must resolve to its matching freshly authorized entity before it reaches the model. CRM requirements, assessments and public research require their own relevant current reads; warehouse detail reads do not refresh those sources.

Targeted recall accepts a stored `group-N` with original `positions`, or stored `warehouse_ids`. It preserves grouping and ordinal metadata, never old factual prose. A source-backed CRM subject is returned only after its own current read succeeds; a failed subject read leaves an anonymous structural group with independently authorized warehouses, not a client label or requirement. Ambiguous ordinals return guidance to recall without a selector and resolve the authorized group context before targeting a group, without asking the user to resupply IDs. Compact evidence keeps its full-source `evidence_id` and original array indices, with explicit omissions; references resolve against the accepted full evidence ledger.

Receipts without explicit selections retain general source replay. During a run, a refreshed source can replace its old evidence reference when tool, arguments and business fingerprint match. A changed or absent source withdraws historical prose. Independently authorized displayed references can survive with current facts. The graph never authorizes an old answer merely because record IDs match.

## Review and observability

Router, planner, worker, formatter and verifier instructions follow the current question. A locality-label explanation does not inherit a five-option shortlist requirement. Recorded labels and general advice can be useful without inventing geographic boundaries, rents, distance or access advantages. Partial answers should preserve supported work and name the specific gap.

Each verifier stage now includes a bounded `review` diagnostic in the existing run trace: approval, repair category, fixed reason code and deterministic presentation-issue count. It excludes raw reviewer feedback, source text and answer bodies. Reasons are `none`, `unsupported_claim`, `missing_evidence`, `incomplete_answer`, `presentation`, `access` and `other`.

Failed reviews still cannot send their rejected drafts. The fallback distinguishes retrieved information from unavailable evidence and no longer assumes that the user must narrow an otherwise valid request. This does not guarantee that every model-written answer will pass review.

## Validation

The focused run passed **78 deterministic cases**, plus typechecking and the production build. Regressions cover approved subset capture, original ordering, legacy receipts, changed source fields, partial access loss, source-ID replacement with identical data, stale-prose withdrawal, current selection retention, two-turn graph integration and sanitized review failures. An offline replay of the saved incident also recovered all five displayed references and retained recall across the observed identical source replacement. These checks verify code contracts with scripted model responses, not live Sol answer quality. A paid model evaluation remains separately subject to the repository's spending policy.
