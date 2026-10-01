# Private EC2 operations

Reviewed **1 October 2026** through release `5eb14d0`. The Terra conversational flow and split Supabase queues are deployed. MCP services are scaffolded but disconnected from the active bot; this scaffold requires no additional production environment setting.

The `ramesh-bot-production` CloudFormation stack in Mumbai (`ap-south-1`) owns a dedicated Ubuntu 24.04 `t3.micro`, a security group with **no inbound rules**, its instance profile, a fixed SSM deployment document, the GitHub deployment role, and a private backup bucket. The instance uses an automatically assigned public IPv4 address for outbound traffic. The application listens only on `127.0.0.1:3011`.

The Next.js admin remains a separate application. A Vercel deployment cannot directly reach this private API; HTTPS or another authenticated network path must be configured before connecting Vercel. Local administration uses an SSM tunnel.

## Infrastructure and deployment

`deploy/aws/infrastructure.yml` describes the resources. `deploy/ec2/bootstrap.sh` installs the reviewed host helpers from a pinned commit, creates separate runtime/build accounts, configures 2 GiB swap and bounded logs, and generates fresh production secrets. It does not copy a local WhatsApp session. Bootstrap changes require a deliberate host installation; ordinary app deployments cannot replace the privileged helpers.

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

The tunneled API is `http://127.0.0.1:3013`. Point a local admin instance's `WORKER_API_URL` there and set its `WORKER_API_TOKEN` to the production token from the protected `/ramesh-bot/production/runtime` SecureString parameter. Do not reuse the development token or commit credentials. Keep the tunnel running while using that admin instance. Port **3012** is reserved for the worker's independent fake chat playground, which never opens WhatsApp or Supabase.

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
```

New-host bootstrap disables WhatsApp auto-connect until an operator pairs an account through the admin. The production account is already linked on EC2; its persisted operator preference controls reconnection after deployment. The earlier local pairing is retired. Never copy a running account's database onto another active worker. Session migration needs a controlled stop and consistent snapshot; it is separate from provisioning.

Readiness checks validate the process, release, and configured databases without sending messages. They do not assert WhatsApp connectivity or model quality; authenticated status reports connection state. Use the local fake chat/evaluation harness for conversational testing rather than sending production test messages.

## Runtime configuration

`/etc/wareongo-sales-bot/worker.env` is root-owned mode `0600`. Parameter Store `/ramesh-bot/production/runtime` is a `SecureString` containing the encrypted JSON backup of runtime values. The process reads the host environment on startup; changing Parameter Store alone does not update or restart the worker. Bootstrap preserves an existing host environment, and ordinary releases do not replace it.

| Setting                                       | Production role                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `DATABASE_URL`                                | Persistent SQLite auth/admin database                                               |
| `AUTH_ENCRYPTION_KEY`, `WORKER_API_TOKEN`     | Existing encryption and private API credentials; preserve across updates            |
| `MESSAGE_DATABASE_URL`, `MESSAGE_DB_SSL_CA`   | Dedicated Supabase login and verified TLS                                           |
| `MESSAGE_ACCOUNT_ID`                          | Stable message/deduplication namespace                                              |
| `OPENAI_API_KEY`                              | Server-side model key; configured without copying it into Git or the admin          |
| `OPENAI_MODEL`                                | `gpt-5.6-terra`                                                                     |
| `AGENT_TIMEOUT_MS`, `AGENT_MAX_OUTPUT_TOKENS` | `45000` and `800`                                                                   |
| `CONTEXT_MCP_*`                               | Not required by the inactive service scaffold; no shared employee token             |
| `CONTEXT_RAMESH_SIGNING_KEY_JSON`             | Protected service private-key JSON, used by the future signed factory               |
| `CONTEXT_OAUTH_REDIRECT_URI`                  | Optional legacy OAuth enrollment only; owned callback allowlisted by Context Engine |

For an authorized AWS CLI environment update, read the current SecureString into protected memory/a private temporary file, merge only the intended fields, and preserve all other values. Write the complete merged JSON through `aws ssm put-parameter --cli-input-json file://...` as `SecureString`; avoid secret values in command arguments, logs, or terminal output. Check the expected parameter version before overwriting. Then install the matching host environment atomically with root ownership/mode `0600`, keeping a protected backup. Verify field presence and nonsecret settings, and restart through the normal release process or a controlled service restart. Do not print the decrypted parameter or `worker.env`.

Supabase migrations are separate from release automation. Migrations `202610010001` and `202610010002` have been provisioned; new code requires the split-queue schema before it becomes ready. The old `ramesh-message-jobs` name is a compatibility view, not another queue. See [migration and rollback rules](supabase-message-queue.md#authentication-and-configuration).

## State and recovery

- Live SQLite database: `/var/lib/wareongo-sales-bot/bot.db`, private to `wareongo-bot`.
- The retained optional OAuth adapter has encrypted `ContextOAuthGrant`, `ContextOAuthEnrollment`, and `ContextOAuthRevocation` tables through the normal additive Prisma migration. Preserve the existing encryption key and account namespace. After restoring an old grant snapshot, revoke/re-enroll instead of replaying potentially consumed refresh tokens.
- Supabase: `ramesh-messages`, `ramesh-inbound-queue`, `ramesh-outbound-queue`, `ramesh-message-events`, and `ramesh-schema-migrations`; these are outside the EC2 SQLite snapshots.
- Runtime secrets: `/etc/wareongo-sales-bot/worker.env`, root-only; a separate encrypted copy lives in Parameter Store at `/ramesh-bot/production/runtime`.
- Daily consistent database snapshots: the stack's private S3 bucket, `daily/`, encrypted with SSE-S3, expiring after 14 days.
- Local pre-deployment snapshots: `/var/backups/wareongo-sales-bot`; snapshots older than seven days are removed only after a successful S3 upload.
- Daily timer: 02:30 UTC plus up to 15 minutes of jitter. Failed backups remain visible as a failed systemd unit; external alert delivery is not configured.

For restoration, stop the original worker first, retrieve the database snapshot and its matching encryption key using an authorized operator, verify SQLite integrity, install the DB with `wareongo-bot` ownership and mode `0600`, and start a compatible release. A stale WhatsApp session may require relinking. Never rewind Signal state as part of an ordinary code rollback.

Supabase backup/PITR settings were not changed or verified by the queue feature. Preserve pending message/final-reply encryption keys and the current message ledger across recovery. Never automatically resend `UNCERTAIN` rows. Rolling back to a pre-split worker preserves existing outbound rows but cannot deliver them; a split-aware release is needed to drain them.

Signed identity services are ready for explicit composition through `createSignedEmployeeContextAccess`; the conversational graph does not invoke them. Configure the protected service signing key and `/mcp/ramesh` endpoint after the Context Engine rollout. Four-column roster SELECT is required; employee OAuth enrollment is not. See [signed operations](signed-context-auth.md). The optional old OAuth CLI and its recovery commands remain documented separately.

Stack termination protection is enabled. The instance and backup bucket are retained on deletion/replacement. Removing the stack therefore does **not** stop billing for retained resources; inventory and explicitly retire them during decommissioning. Do not replace a paired instance without stopping its old worker.

## Cost

Historical infrastructure estimate: the AWS Price List API on September 30, 2026 returned $0.0112/hour for Linux `t3.micro` in Mumbai and $0.0912/GB-month for gp3. At 730 hours, compute is $8.18, 20 GiB storage is $1.82, and the public IPv4 address is $3.65: **$13.65/month before tax, credits, backup storage, and billable transfer**. OpenAI usage and Supabase costs are separate. CPU credits use `standard` mode, so sustained CPU load is throttled instead of incurring unlimited-mode credit charges. Resize only after observing resource use.

[EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/), [EBS pricing](https://aws.amazon.com/ebs/pricing/), [IPv4 pricing](https://aws.amazon.com/vpc/pricing/), and [SSM pricing](https://aws.amazon.com/systems-manager/pricing/) are the pricing references. No NAT gateway, load balancer, RDS database, or public HTTPS endpoint is provisioned by this stack.
