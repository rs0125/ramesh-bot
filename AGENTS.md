# Evaluation spending

- Prefer existing traces and focused deterministic checks. Do not habitually rerun broad paid suites after edits.
- Use `gpt-6-luna` for routine low-level model checks, including their grader. Production's Sol setting is not authorization to use Sol for tests.
- Get explicit user approval **before any Sol evaluation**, including graders, private capture tests, calibration, model comparisons and ad hoc smoke scripts. Present models, case scope, repetitions and estimated spend/limits first. Never supply `--sol-approval` on your own; record the approval actually received.
- Keep paid runs narrowly scoped. The default three-trial allowance counts scenario executions, not dollars or requests. A larger run needs an agreed scope; do not raise the limit merely to bypass the guard.
- Preserve failed and interrupted runs. Do not restart them just to produce a green report. No paid tests are required for documentation-only edits.
- Production inference and intentional interactive playground chats are separate from evaluation policy. Never send test messages to real WhatsApp recipients.

See [the spending contract](docs/agent-modules/42-evaluation-spend-controls.md).
