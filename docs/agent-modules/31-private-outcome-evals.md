# Private outcome evaluations

Status: implemented locally; validation results are in the [dated record](../../evals/results/2026-10-02-sol-graph-media.md). Never push the private cases, reference data or transcripts.

## Purpose

Evaluate whether an employee can accomplish real work, rather than whether the model chooses a preselected tool. Author the business question and acceptance criteria before retrieving reference facts. Examples are preparing for a follow-up, assessing a real requirement against available supply, understanding website performance and drafting a useful next action.

## Separation

The reusable runner and schema may be tracked. Cases, source snapshots, answers, judge reports and raw traces live only under gitignored `.local/private-evals/`, with private filesystem permissions. No private dataset is bundled into the generic fixtures or uploaded by the CI workflow. Reject execution in CI. Verify ignore rules before writing. Public result summaries contain only aggregate counts and generic failure categories.

## Case contract

Each case has a stable opaque ID, a realistic multi-turn request, an as-of time/window, source-backed reference facts and explicit observable outcomes. References distinguish recorded facts, requirements, recommendations and unknowns. They may contain confidential business data. Do not include expected tool names, call ordering or internal implementation hints in the pass criteria. Tool traces are diagnostics only.

Use the configured server-side Raghav identity, actual Supabase and actual Context Engine. Requests go exclusively to the loopback capture playground. The runner verifies capture mode and every response's captured delivery outcome. It must not import Baileys, write CRM or send messages. A private review/judge compares responses with source references and evaluates groundedness, completeness, continuity, usefulness and WhatsApp readability. A source outage is not an empty dataset. Preserve failed runs.

## Execution and reporting

Snapshot reference evidence close to execution and declare time-sensitive facts. Dynamic questions use explicit windows or record identifiers only in private setup; avoid brittle exact prose matching. Run all authored cases and retain raw local evidence. Summarize failures without printing customer or employee data. Keep generic CI regressions separate from this operator-run real-data suite.

## First live finding

The first private shortlist run generated a complete candidate answer but its final freshness check suppressed delivery. A private comparison found its CRM, warehouse candidates and assessment unchanged; a supply filter vocabulary gained one value. The current receipt deliberately rechecks all reads, including discovery metadata. The original failed trial is retained. This is conservative suppression, not evidence of an unauthorized send or incorrect candidate facts. Do not weaken record/identity revalidation to improve an eval score. A fresh rerun is recorded separately, and finer discovery/evidence dependencies remain a follow-up design concern.
