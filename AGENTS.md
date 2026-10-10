# Evaluation spending

- Prefer existing traces and focused deterministic checks. Do not habitually rerun broad paid suites after edits.
- Use `gpt-6-luna` for routine low-level model checks, including their grader. Production's Sol setting is not authorization to use Sol for tests.
- Get explicit user approval **before any Sol evaluation**, including graders, private capture tests, calibration, model comparisons and ad hoc smoke scripts. Present models, case scope, repetitions and estimated spend/limits first. Never supply `--sol-approval` on your own; record the approval actually received.
- Keep paid runs narrowly scoped. The default three-trial allowance counts scenario executions, not dollars or requests. A larger run needs an agreed scope; do not raise the limit merely to bypass the guard.
- Preserve failed and interrupted runs. Do not restart them just to produce a green report. No paid tests are required for documentation-only edits.
- Production inference and intentional interactive playground chats are separate from evaluation policy. Never send test messages to real WhatsApp recipients.

See [the spending contract](docs/agent-modules/42-evaluation-spend-controls.md).

# Working rules

- One AI session per repository at a time. Parallel work uses `git worktree`; never share a working tree.
- One change per commit, under about 500 changed lines excluding tests. Merging to `main` deploys.
- Prefer removing or softening a check over adding one. "Make sure X never happens" is not a fix:
  fix the cause, make the check fail soft, or move the rule into a schema or code.
- New prompt text must replace existing text. `tests/unit/prompt-budget.test.ts` fails when a prompt
  grows; lower its budgets when prompts shrink, never raise them.
- A rejection in `src/modules/assistant` or `src/infrastructure/openai` throws `GateRejection` with a
  stable UPPER_SNAKE code (enforced by `tests/unit/failure-classification.test.ts`). A degradation that
  does not end the turn emits a gate event (`options.onGate`). Never keep free-text error messages in
  traces: they can carry provider bodies.

# Tracing decision (R&D)

- LangSmith tracing (`LANGSMITH_TRACING=true`) records full content: prompts, tool inputs and
  outputs, and replies, with no redaction. This is intentional during R&D. Owner: Raghav.
  Revisit before tracing production traffic beyond R&D.
- Do not change traces back to metadata-only without a new decision here. Redaction, when needed,
  belongs in one place: `src/infrastructure/observability/tracing.ts` or the LangSmith client options.
- Secrets (signing keys, Context Engine grants, OAuth tokens, API keys) must never enter graph state,
  `ModelRequest`, or traced arguments.
- Tracing must never block or fail a reply (`tests/unit/tracing.test.ts` covers an unreachable endpoint).
- `AgentTrace` (pino logs) still keeps only fixed codes and counts; full content goes to LangSmith only.
