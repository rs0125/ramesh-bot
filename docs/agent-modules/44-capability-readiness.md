# Model-free capability readiness

Status: implemented; initially verified with synthetic offline fixtures. The CLI
is available after deployment, but probes remain explicitly initiated operator
checks and do not automatically run during normal conversation or deployment.

Process health and business capability readiness answer different questions.
`/healthz` can report a running worker even when the business-read feature is off,
the roster is inaccessible or the Context Engine excludes its tools. The operator
probe checks the actual worker configuration and employee-bound read path without
constructing a model, starting the application or opening a WhatsApp session.

## Operator configuration

Run from the release directory under the worker's operating-system account:

```sh
npm run capability:preflight -- --env-file /path/to/private/worker.env
```

The supplied file must be private (no group/other permissions) and at most 64 KiB.
It replaces inherited environment values. This prevents local credentials from
masking missing production settings. Without `--env-file`, the command consumes
only its inherited environment; it does not automatically load a local `.env`.

Use the same environment as the worker, including the dedicated `ramesh_worker`
PostgreSQL login, signed Context Engine configuration, release SHA, assistant
configuration and normal worker validation requirements. The OpenAI key's presence
is validated because the worker requires an assistant for business reads; it is
never used by this command.

| Setting                        | Meaning                                                              | Default                        |
| ------------------------------ | -------------------------------------------------------------------- | ------------------------------ |
| `CAPABILITY_PROBE_EMPLOYEE_ID` | Explicit active VerifiedNumber employee to probe                     | Required; no implicit employee |
| `CAPABILITY_PROBE_REQUIRED`    | Comma-separated capabilities whose failure fails readiness           | `crm,warehouses`               |
| `CAPABILITY_PROBE_OPTIONAL`    | Comma-separated capabilities whose source failure degrades readiness | `knowledge,ga4,search_console` |
| `CAPABILITY_PROBE_TIMEOUT_MS`  | Whole-probe work deadline, 1,000–60,000 ms                           | `45000`                        |

Capability names are a closed set: `crm`, `warehouses`, `knowledge`, `ga4` and
`search_console`. Required and optional lists cannot overlap or contain duplicates.
At least one required capability is necessary; an empty optional value disables
optional checks. Changing the required list also requires adjusting the optional
list if a capability moves between them. These settings select checks; they never
grant business access or widen employee scopes.

The probe employee is selected by an operator. The resolver requires an active,
unambiguous roster binding and applies the worker's employee enablement setting.
The resulting roster phone supplies a synthetic direct-message key to the **same
business-access resolver used by the worker**. No phone, employee or message input
comes from an agent or browser. This proves that configured identity's phone path;
it does not prove a real incoming WhatsApp event, reciprocal LID mapping or device
delivery. Those remain separate transport checks.

## Execution and bounds

1. Validate the complete worker environment and explicit probe settings.
2. Resolve the live roster employee through the configured Supabase connection.
3. Use `createBusinessAccessResolver`, `ContextToolRun` and the existing signed MCP
   adapter to discover the worker's current platform-selected, scoped tools.
4. Read `get_context` and distinguish the locally requested scopes, effective
   remote scopes and tool availability.
5. Execute one fixed query per selected capability through the existing executor.
   Queries fetch at most one item: accessible CRM leads, warehouse listings,
   knowledge pages, GA4 overview for yesterday and Search Console summary for the
   last seven days. Empty authorized results are successful evidence.
6. Construct an in-memory business receipt and call the existing
   `BusinessReadService.canDeliver` to reauthorize and reread that same query.
   Current source checks, freshness, field fingerprints and revocation behavior
   remain the production checks. No outbound row or transport send is created.

There is one catalogue opening, one explicit context read, and at most two source
reads for each of five selected capabilities. The current MCP adapter performs
its own fresh authentication, catalogue and context exchange for each call; these
are additional protocol requests, not a claim of one HTTP request per read.
The probe performs no retries or pagination. Existing MCP response-size and tool
evidence limits remain in force. The shared work deadline aborts later reads;
database shutdown can additionally wait for the existing bounded PostgreSQL query
timeout. Invoke the probe once per approved rollout/check, not in a tight polling
loop. Although it makes zero model calls, source and database requests have cost.

## Output and release handling

The single JSON report contains only schema version, sanitized release version,
overall status, stages, capability names, required/optional flags, elapsed times
and allowlisted error classes. It contains no roster phone/email/ID, data rows,
source paths, receipt payloads, tokens, exception messages or database details.
Evidence remains in memory and is not written to an agent journal.

| Overall result            | Exit | Meaning                                                        |
| ------------------------- | ---- | -------------------------------------------------------------- |
| `ready`                   | 0    | Every selected capability passed its source and receipt checks |
| `degraded`                | 0    | Required capabilities passed; an optional capability failed    |
| `failed`                  | 1    | Identity, catalogue or a required capability failed            |
| `failed` at configuration | 2    | Runtime or operator configuration is invalid/incomplete        |

Revoked/changed identity is a required failure even if detected while checking an
optional source. A GA4 outage is reported under GA4's source stage, not silently
turned into a denied employee or empty traffic result. A changed source fingerprint
is reported as `SOURCE_CHANGED`; it can reflect legitimate concurrent data updates
and should be investigated before treating it as a permanent outage.

Roster SQL permission denial is `ROSTER_ACCESS_DENIED`. Other failed roster reads
are `ROSTER_UNAVAILABLE`. A policy that filters out every row looks the same as an
unknown/inactive/ambiguous employee to this least-privileged connection and is
reported as `IDENTITY_DENIED`. The probe detects unusable roster access without
claiming it can infer the exact missing RLS policy. An operator must inspect the
policy using the established database-management workflow.

Keep existing release SHA/process health/authentication checks. This command is a
separate bounded readiness signal; it is not wired into deployment or public
`/healthz` automatically. Configure the chosen employee and requirements before
adding an explicit rollout invocation. No hardcoded test identity is introduced.

## Code and verification

- `src/modules/operations/capability-preflight.ts`: reporting, bounded source checks,
  capability policy and receipt validation orchestration.
- `scripts/capability-preflight.ts`: private environment handling, actual worker
  configuration, dedicated database and shared worker resolver composition.
- `src/app/business-reads.ts`: additive shared resolver export; worker behavior is
  unchanged.
- `tests/unit/capability-preflight.test.ts`: synthetic outcomes for empty data,
  identity denial, roster permission/outage, pilot exclusion, local/remote scope,
  platform selection, source outage, optional degradation, source changes,
  revocation, cancellation/deadline, privacy and transport/model-free imports.

Focused offline check:

```sh
node --import tsx tests/unit/capability-preflight.test.ts
```

No paid graph evaluation is necessary for this deterministic capability boundary.
An actual deployment probe is a separately initiated read of real employee-scoped
sources. It neither substitutes for an outcome evaluation nor authorizes Sol tests.
