# EC2 operations

Scheduling review rollout, 3 October 2026: production migration `202610030008_personal_context.sql` is applied and verified, including checksum, restricted-worker schema health, role grants and RLS. This release includes the review fixes and requires schema `202610030008`, even with scheduling disabled. Both personal tools and the scheduler remain enabled. Worker rollout uses CI/CD after pushing `main`; verify the exact release, database readiness, scheduler tick health and WhatsApp connection before declaring completion. Preserve existing worker credentials, TLS settings and runtime flags; see [personal scheduling operations](personal-scheduling.md). Disabling new scheduling leaves existing reminder delivery checks active. Authenticated `/v1/status` exposes scheduler tick health separately from WhatsApp connectivity. The real-data capture role has no production scheduling access.

Current implementation (2 October 2026): separate converser → planner → worker/tool-executor → formatter → verifier roles; ordinary chat skips planning. Images, PDFs and voice notes use encrypted owner-scoped media records with 24-hour expiry. Forwarded messages and media use durable sliding inbound batching (1-second ordinary text, 3-second burst window, 8-second cap). The capture GUI accepts attachments and overlapping messages, with one response per batch. See [module specifications](agent-modules/README.md) for current contracts and deployment prerequisites. Real-data private outcome cases and transcripts remain only under gitignored `.local/private-evals/`; `npm run eval:private` refuses CI.

The optional business-read flag in this checkout now enables the full employee-permitted CRM, supply, knowledge and shortlist catalogue through the [sales loop](sales-manager-agent.md). Validate production migration `202610010004`, roster RLS, signed scopes and model limits before enabling it. Local Supabase capture tests do not change that production configuration.

Reviewed **2 October 2026** through release `cdd9881`. Production runs Sol with the
LangGraph agent, separate Supabase queues, media and debouncing, active employee
business reads, and the employee-permitted signed Context Engine catalogue. Roster RLS is provisioned.
Concurrent LID resolution and delivery acknowledgements are corrected; see
[the delivery incident](agent-modules/40-delivery-acknowledgements.md). Analytics signing scopes were enabled on 3 October; the actual production probe passed GA4 and Search Console. Personal scheduling was subsequently enabled in `2bf91be`; conditional CRM/SLA reminders and CRM writes remain separate work.

The `ramesh-bot-production` CloudFormation stack in Mumbai (`ap-south-1`) owns a dedicated Ubuntu 24.04 `t3.micro`, its security group, instance profile, fixed SSM deployment document, GitHub deployment role, and private backup bucket. The instance uses an automatically assigned public IPv4 address. The application listens only on `127.0.0.1:3011`.

Public HTTPS was enabled on **3 October 2026** at **`https://wareongo-ramesh.duckdns.org`**. Set the separate Next.js admin's server-side `WORKER_API_URL` to that origin and configure its matching production `WORKER_API_TOKEN` privately. Caddy 2.11.6 runs on this same EC2 instance and automatically renews its TLS certificate. CloudFormation `EnablePublicHttps=true` adds only TCP 80/443; port 3011 and SSH remain closed at the security group. The geocoder's hostname, proxy and instance remain independent.

External checks verified public TLS, HTTP-to-HTTPS redirection, authenticated status 200, anonymous 401 on all seven allowlisted API routes, and 404 on `/healthz` and unknown paths. The worker remained healthy without a proxy-related restart. This verifies API connectivity and access control, not WhatsApp message delivery or a Vercel deployment. The SSM tunnel remains available for local administration.

`wareongo-duckdns.timer` updates only `wareongo-ramesh` every five minutes and after boot, using the instance's outbound public IPv4 address. Its first update succeeded. `/etc/wareongo-sales-bot/duckdns.json` holds the registered label and account token with root ownership and mode `0600`; the updater never prints credentials. The token was copied encrypted from the geocoder's existing updater without changing that host. Because both names use the same DuckDNS account token, rotate the protected credentials on both hosts together. This remains a single-server deployment with an external DNS dependency.

## Infrastructure and deployment

`deploy/aws/infrastructure.yml` describes the resources. `deploy/ec2/bootstrap.sh` installs the reviewed host helpers from a pinned commit, creates separate runtime/build accounts, configures 2 GiB swap and bounded logs, and generates fresh production secrets. It does not copy a local WhatsApp session. Bootstrap changes require a deliberate host installation; ordinary app deployments cannot replace the privileged helpers. Caddy and DNS maintenance are installed separately using the [HTTPS procedure](deployment-vercel-ec2.md#https-boundary). The public address can change after an EC2 stop/start; keep DNS updates working before doing so.

GitHub `production` is limited to `main`. Its OIDC subject includes the owner/repository IDs. Successful CI invokes only the pinned version of `ramesh-bot-deploy` on this instance. No long-lived AWS credential is stored in GitHub. The EC2 repository deploy key is read-only.

Retrieve the live instance ID:

```sh
aws cloudformation describe-stacks \
  --stack-name ramesh-bot-production --region ap-south-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' --output text
```

With AWS CLI credentials and the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) installed, open a tunnel in one terminal (replace `INSTANCE_ID` with that output):

```sh
aws ssm start-session --region ap-south-1 --target INSTANCE_ID \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3011"],"localPortNumber":["3013"]}'
```

The tunneled API is `http://127.0.0.1:3013`. Point a local admin instance's `WORKER_API_URL` there and set its `WORKER_API_TOKEN` to the production token from the protected `/ramesh-bot/production/runtime` SecureString parameter. Do not reuse the development token or commit credentials. Keep the tunnel running while using that admin instance. Port **3012** is reserved for the independent chat playground, which never opens WhatsApp. `dev:chat:live` reads real Supabase/Context Engine using separate capture queues; `dev:chat` retains isolated SQLite fixtures. See the [live harness runbook](live-data-playground.md). Its private configuration belongs on the operator machine, not in the EC2 worker environment.

Open an operator shell with:

```sh
aws ssm start-session --region ap-south-1 --target INSTANCE_ID
```

On the host:

```sh
sudo systemctl status wareongo-bot --no-pager
sudo journalctl -u wareongo-bot -n 50 --no-pager
curl --fail http://127.0.0.1:3011/healthz
sudo systemctl status wareongo-bot-backup.timer --no-pager
sudo journalctl -u wareongo-bot-backup.service -n 20 --no-pager
sudo systemctl status caddy wareongo-duckdns.timer --no-pager
sudo journalctl -u wareongo-duckdns.service -n 10 --no-pager
```

New-host bootstrap disables WhatsApp auto-connect until an operator pairs an account through the admin. The production account is already linked on EC2; its persisted operator preference controls reconnection after deployment. The earlier local pairing is retired. Never copy a running account's database onto another active worker. Session migration needs a controlled stop and consistent snapshot; it is separate from provisioning.

Readiness checks validate the process, release, and configured databases without sending messages. They do not assert WhatsApp connectivity or model quality; authenticated status reports connection state. Use the local fake chat/evaluation harness for conversational testing rather than sending production test messages.

## Runtime configuration

The separate [outbound automation API](outbound-automation.md) uses `RAMESH_AUTOMATION_API_KEY` and `/v1/outbound-messages` plus its per-message status route. Supabase migration `202610030006` is applied; its dedicated key is installed in the protected host environment and SSM runtime version 11. The extended Caddy allowlist has been validated and reloaded. Code is deployed in `3ad3408`; WhatsApp is connected and HTTPS authorization probes pass. Normal app deployments do not replace the Caddyfile or these credentials.

`/etc/wareongo-sales-bot/worker.env` is root-owned mode `0600`. Parameter Store `/ramesh-bot/production/runtime` is a `SecureString` containing the encrypted JSON backup of runtime values. The process reads the host environment on startup; changing Parameter Store alone does not update or restart the worker. Bootstrap preserves an existing host environment, and ordinary releases do not replace it.

| Setting                                                | Production role                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `DATABASE_URL`                                         | Persistent SQLite auth/admin database                                               |
| `AUTH_ENCRYPTION_KEY`, `WORKER_API_TOKEN`              | Existing encryption and private API credentials; preserve across updates            |
| `MESSAGE_DATABASE_URL`, `MESSAGE_DB_SSL_CA`            | Dedicated Supabase login and verified TLS                                           |
| `MESSAGE_ACCOUNT_ID`                                   | Stable message/deduplication namespace                                              |
| `OPENAI_API_KEY`                                       | Server-side model key; configured without copying it into Git or the admin          |
| `OPENAI_MODEL`, `AGENT_TOOL_REASONING_EFFORT`          | `gpt-6.1-sol`, `medium`                                                             |
| `AGENT_TIMEOUT_MS`, `AGENT_MAX_OUTPUT_TOKENS`          | `240000` and `6000`                                                                 |
| `BUSINESS_READS_ENABLED`, `BUSINESS_READ_EMPLOYEE_IDS` | `true`, `all`; current employee permissions still apply                             |
| `CONTEXT_MCP_URL`                                      | Production Context Engine `/mcp/ramesh` endpoint                                    |
| `CONTEXT_RAMESH_SIGNING_KEY_JSON`                      | Protected private signing key; four registered read scopes, including analytics     |
| `CONTEXT_OAUTH_REDIRECT_URI`                           | Optional legacy OAuth enrollment only; owned callback allowlisted by Context Engine |

For an authorized AWS CLI environment update, read the current SecureString into protected memory/a private temporary file, merge only the intended fields, and preserve all other values. Write the complete merged JSON through `aws ssm put-parameter --cli-input-json file://...` as `SecureString`; avoid secret values in command arguments, logs, or terminal output. Check the expected parameter version before overwriting. Then install the matching host environment atomically with root ownership/mode `0600`, keeping a protected backup. Verify field presence and nonsecret settings, and restart through the normal release process or a controlled service restart. Do not print the decrypted parameter or `worker.env`.

Supabase migrations are separate from release automation. Migrations `202610010001` and `202610010002` have been provisioned; new code requires the split-queue schema before it becomes ready. The old `ramesh-message-jobs` name is a compatibility view, not another queue. See [migration and rollback rules](supabase-message-queue.md#authentication-and-configuration).

## State and recovery

- Live SQLite database: `/var/lib/wareongo-sales-bot/bot.db`, private to `wareongo-bot`.
- The retained optional OAuth adapter has encrypted `ContextOAuthGrant`, `ContextOAuthEnrollment`, and `ContextOAuthRevocation` tables through the normal additive Prisma migration. Preserve the existing encryption key and account namespace. After restoring an old grant snapshot, revoke/re-enroll instead of replaying potentially consumed refresh tokens.
- Supabase: `ramesh-messages`, `ramesh-inbound-queue`, `ramesh-outbound-queue`, `ramesh-message-events`, `ramesh-schema-migrations`, and migration 004’s `ramesh-agent-runs` / `ramesh-agent-events`; these are outside the EC2 SQLite snapshots.
- Runtime secrets: `/etc/wareongo-sales-bot/worker.env`, root-only; a separate encrypted copy lives in Parameter Store at `/ramesh-bot/production/runtime`.
- Daily consistent database snapshots: the stack's private S3 bucket, `daily/`, encrypted with SSE-S3, expiring after 14 days.
- Local pre-deployment snapshots: `/var/backups/wareongo-sales-bot`; snapshots older than seven days are removed only after a successful S3 upload.
- Daily timer: 02:30 UTC plus up to 15 minutes of jitter. Failed backups remain visible as a failed systemd unit; external alert delivery is not configured.

For restoration, stop the original worker first, retrieve the database snapshot and its matching encryption key using an authorized operator, verify SQLite integrity, install the DB with `wareongo-bot` ownership and mode `0600`, and start a compatible release. A stale WhatsApp session may require relinking. Never rewind Signal state as part of an ordinary code rollback.

Supabase backup/PITR settings were not changed or verified by the queue feature. Preserve pending message/final-reply encryption keys and the current message ledger across recovery. Never automatically resend `UNCERTAIN` rows. Rolling back to a pre-split worker preserves existing outbound rows but cannot deliver them; a split-aware release is needed to drain them.

Signed identity services are composed into the enabled production tool loop. Four-column roster SELECT and the `ramesh_worker_identity_read` SELECT policy are required; `npm run db:identity` now provisions and validates both. Test with the actual worker connection, since owner visibility does not prove worker RLS visibility. Employee OAuth enrollment is unnecessary. See [signed operations](signed-context-auth.md). The optional old OAuth CLI remains documented separately.

Stack termination protection is enabled. The instance and backup bucket are retained on deletion/replacement. Removing the stack therefore does **not** stop billing for retained resources; inventory and explicitly retire them during decommissioning. Do not replace a paired instance without stopping its old worker.

## Cost

Historical infrastructure estimate: the AWS Price List API on September 30, 2026 returned $0.0112/hour for Linux `t3.micro` in Mumbai and $0.0912/GB-month for gp3. At 730 hours, compute is $8.18, 20 GiB storage is $1.82, and the public IPv4 address is $3.65: **$13.65/month before tax, credits, backup storage, and billable transfer**. OpenAI usage and Supabase costs are separate. CPU credits use `standard` mode, so sustained CPU load is throttled instead of incurring unlimited-mode credit charges. Resize only after observing resource use.

[EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/), [EBS pricing](https://aws.amazon.com/ebs/pricing/), [IPv4 pricing](https://aws.amazon.com/vpc/pricing/), and [SSM pricing](https://aws.amazon.com/systems-manager/pricing/) are the pricing references. The HTTPS setup uses the existing instance and public IPv4 address, a free DuckDNS hostname, and Caddy with automatic certificates. It adds no fixed hosting or DNS charge; existing usage and transfer charges still apply. No NAT gateway, load balancer, Elastic IP or RDS database was added.

## Graph/media release prerequisites prepared on 2 October 2026

Production message migrations through `202610020005` are applied and verified through the restricted worker login. The separate capture schema remains isolated. Audio uploads directly to STT; `ffmpeg` is not a runtime/bootstrap prerequisite. Runtime version 6 added independent STT credentials and `gpt-4o-transcribe`; version 7 enabled business reads for all active employees and selected Sol/medium with 240 seconds/6,000 tokens. Both Parameter Store and the root-only host environment were updated with other fields preserved, then the actual process environment was verified after restart. Inbound windows are 1 second for ordinary text, 3 seconds for forwarded/media bursts and an 8-second maximum; outbound pacing is separate.

The production capture proof resolved the actual reciprocal WhatsApp LID mapping, discovered 14 permitted reads, retrieved CRM data through the full graph and passed fresh delivery authorization. It did not instantiate a sender or send a test message. `/healthz` still checks process/databases rather than employee visibility, model access or advertised tools; an automated post-deploy capability smoke remains a follow-up.

## Analytics and dynamic discovery rollout, 3 October 2026

Context Engine release `5b6f41a` accepts the same four read scopes for signed
WhatsApp requests as for its other clients. The existing public registration and
worker signer now include `analytics:read`; key material and expiry were preserved.
The encrypted runtime backup advanced from version 7 to 8, with the matching host
field updated and a controlled restart. Other runtime settings were preserved.
The model-free production probe passed identity, catalogue, CRM, warehouses,
knowledge, GA4 and Search Console, including source receipt checks.

`USAGE_MODE` remains `off`. Dollar caps and reviewed prices are optional operational
controls, not prerequisites for using this internal bot. Existing model-call,
tool-loop, timeout and media bounds remain active; paid evaluation approval rules
are separate. No paid model checks or WhatsApp test sends were used for this rollout.

The [dynamic discovery contract](agent-modules/45-dynamic-tool-discovery.md) lets
Context Engine supply permitted read tools and their guidance without a matching
Ramesh name-list edit. Discovery metadata does not replace live authorization.
