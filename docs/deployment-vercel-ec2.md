# Independent Vercel and EC2 deployments

The worker repository is `baileys-ramesh`; the admin repository is `baileys-ramesh-admin`. Each installs, builds, tests and deploys independently. Only their versioned HTTP contract and matching API token connect them. The current EC2 installation uses private SSM access; see [EC2 operations](ec2-operations.md). The public HTTPS and Vercel sections below describe a later rollout.

The EC2 workflow follows the existing `../../warehouse-enricher` pattern: trusted successful main CI, exact commit selection, GitHub OIDC, a narrowly scoped SSM document, unprivileged builds, health checks, and rollback. Account/instance/repository identifiers are placeholders, not copies of another service's credentials.

## Hosting and network

Use Ubuntu 24.04 x86-64, system-wide Node.js 22.16+ in the 22 release line, npm, Git, OpenSSH, tar, util-linux, a current SSM agent and Caddy. Executable paths in the templates assume `/usr/bin/node`, `/usr/bin/systemd-run`, and `/usr/sbin/runuser`.

A `t3.micro` (1 GiB RAM) is a starting trial size for one lightly used account, not a measured capacity guarantee. Provision swap for on-instance builds and watch pairing/sync memory; use `t3.small` (2 GiB) if the small instance is constrained. The admin never builds on EC2. See [AWS T3 specifications](https://aws.amazon.com/ec2/instance-types/t3/). Use encrypted persistent EBS with enough space for three dependency installations, deployment backups and swap; 16–20 GiB is a reasonable initial allocation.

Point a stable DNS name at the instance. Allow inbound 80/443 for Caddy; leave 3011 closed. SSM avoids an inbound SSH requirement. Outbound access is needed for GitHub/npm, SSM, WhatsApp and certificate issuance. Include public IPv4, disk and CPU-credit costs when estimating hosting. Require IMDSv2 and give the instance only its SSM-managed-instance permissions.

## One-time host setup

Review the deployment helper and unit before installing them. Run the following from a reviewed worker checkout on the future host, as an administrator. Do not copy local `.env`, databases or auth state into the checkout.

```sh
sudo useradd --system --user-group --home-dir /var/lib/wareongo-sales-bot --no-create-home --shell /usr/sbin/nologin wareongo-bot
sudo useradd --system --user-group --home-dir /var/cache/wareongo-bot-build --no-create-home --shell /usr/sbin/nologin wareongo-build
sudo install -d -o root -g root -m 0755 /opt/wareongo-sales-bot /opt/wareongo-sales-bot/releases /usr/local/lib/wareongo-bot-deploy
sudo install -d -o root -g root -m 0700 /etc/wareongo-sales-bot /var/backups/wareongo-sales-bot
sudo install -d -o wareongo-bot -g wareongo-bot -m 0700 /var/lib/wareongo-sales-bot
sudo install -d -o wareongo-build -g wareongo-build -m 0700 /var/cache/wareongo-bot-build
sudo install -o root -g root -m 0600 deploy/ec2/worker.env.example /etc/wareongo-sales-bot/worker.env
sudo install -o root -g root -m 0600 deploy/ec2/deploy.json.example /etc/wareongo-sales-bot/deploy.json
sudo install -o root -g root -m 0644 deploy/ec2-release.ts deploy/release-core.ts deploy/sqlite-backup.ts /usr/local/lib/wareongo-bot-deploy/
sudo install -o root -g root -m 0755 deploy/ec2/wareongo-bot-deploy /usr/local/sbin/wareongo-bot-deploy
sudo install -o root -g root -m 0644 deploy/ec2/wareongo-bot.service /etc/systemd/system/wareongo-bot.service
sudo systemctl daemon-reload
sudo systemctl enable wareongo-bot
```

Do not start the service before its first release creates `current`. Edit `/etc/wareongo-sales-bot/deploy.json` with the worker's GitHub SSH URL. Configure a **read-only deploy key** for that repository at `/etc/wareongo-sales-bot/github-deploy-key` (root:root, 0600). Create the accompanying `known_hosts` using GitHub's published host keys, verifying their [official fingerprints](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints); do not blindly trust a network key scan.

Use `sudoedit /etc/wareongo-sales-bot/worker.env` to set the worker token and a separate 32-byte random base64url `AUTH_ENCRYPTION_KEY` from your secrets manager. Preserve the absolute SQLite path and loopback listener. Back up the key separately; rotating it without re-encrypting stored rows makes the session unreadable. QR logging is off by default. `WHATSAPP_AUTO_CONNECT=true` connects on first startup; a later admin disconnect persists across restarts and takes precedence.

The service runs as `wareongo-bot`, with read-only code and its private state directory writable. Builds run as a different account, with a read-only filesystem except the staging/cache directories, no runtime environment file, and IMDS blocked. Root deployment helpers are installed independently of application releases: **changes to these privileged helpers require a reviewed manual installation**. CI cannot replace them by updating application code.

## HTTPS boundary

Install [Caddy's official package](https://caddyserver.com/docs/install#debian-ubuntu-raspbian), then merge `deploy/ec2/Caddyfile` into the instance's Caddy configuration. Replace the example hostname, validate the file and reload Caddy. On a dedicated instance the template can be the entire Caddyfile; preserve existing sites on a shared instance.

Caddy forwards only `/v1/status`, `/v1/control`, `/v1/admin/attempt`, and `/v1/admin/session`. All require the worker token. It does not expose `/healthz`, which is for local deployment checks. Access logging is not enabled; QR/session data must not be copied into logs. Certificate provisioning requires correct DNS and reachable 80/443. See [automatic HTTPS](https://caddyserver.com/docs/automatic-https).

Verify that anonymous `https://WORKER_HOSTNAME/v1/status` returns 401 and `/healthz` returns 404. The worker itself remains bound to `127.0.0.1:3011`.

## GitHub OIDC and SSM

Create a GitHub `production` environment limited to `main`. Protect main with the worker CI check and review for workflow/deployment changes. The workflow trusts only successful push/manual CI runs from this same repository; PR workflows cannot trigger deployment. It checks out the tested SHA and the host rejects a SHA that is no longer main.

Create an AWS OIDC provider for `token.actions.githubusercontent.com` with audience `sts.amazonaws.com`, and a deployment role using the templates in `deploy/aws/`. Replace every placeholder. The trust policy must match this worker repository's **exact production environment subject**, with no repository wildcard. GitHub's subject format can include immutable organization/repository IDs for newer repositories; older repositories may use the name-only form. Verify the actual configured subject instead of copying one from another repo. See the [AWS action's OIDC guidance](https://github.com/aws-actions/configure-aws-credentials#oidc) and [GitHub AWS OIDC guide](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).

Create the `wareongo-bot-deploy` SSM Command document from `deploy/aws/ssm-document.json`. It accepts only a full lowercase SHA, interpolated through an environment variable, and runs the root-installed fixed helper. Use a current SSM agent supporting `interpolationType: ENV_VAR`. Pin the document's numeric version in GitHub; do not use `$LATEST`. Limit `ssm:SendCommand` to this document and this instance, with only `GetCommandInvocation` for polling. Do not grant generic `AWS-RunShellScript`, document mutation, or SSH access to CI.

Configure these GitHub variables:

| Location               | Variable                                    | Purpose                                                                                    |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Repository             | `EC2_DEPLOY_ENABLED`                        | Leave absent/false until the host, permissions, backup policy and rollout checks are ready |
| Production environment | `AWS_REGION`                                | For example `ap-south-1`                                                                   |
| Production environment | `AWS_ACCOUNT_ID`, `AWS_ROLE_ARN`            | Expected account and OIDC role                                                             |
| Production environment | `EC2_INSTANCE_ID`                           | Single managed worker instance                                                             |
| Production environment | `SSM_DOCUMENT_NAME`, `SSM_DOCUMENT_VERSION` | Fixed command document and reviewed numeric version                                        |

No long-lived AWS keys belong in GitHub secrets. Once ready, set `EC2_DEPLOY_ENABLED=true` and run CI on current main to trigger the first release. Deployment jobs are serialized and do not cancel an active deployment. The runner polls SSM without dumping remote output. On timeout, inspect SSM and the service before retrying; a runner failure alone does not prove the host stopped executing.

## Release and recovery behavior

The helper downloads the exact tested main commit, installs locked dependencies and compiles the worker in a separate staging directory while the old service runs. Builds have resource/time limits. Immutable releases live under `/opt/wareongo-sales-bot/releases/<SHA>-<ID>`, selected by atomic `current` and `previous` links.

Before stopping the worker, it verifies migration history is unchanged and new migrations are conservative additions. Table rewrites, data migrations, triggers, new unique constraints and destructive SQL are rejected and need an explicit maintenance plan. This restriction makes automatic binary rollback possible. CI separately verifies migrations match the Prisma schema.

The helper then stops the old worker, creates a private SQLite backup (including committed WAL state), applies migrations as the runtime user, switches `current`, and starts the new worker. It requires stable local readiness for the expected SHA, the correct process working directory, and a 401 from unauthenticated status requests. These checks verify process/database/API health; actual WhatsApp connectivity is shown in the admin and still needs live-account validation.

- Failure before stopping leaves the existing release running.
- Migration failure before a new worker starts restores the consistent snapshot and restarts the old release.
- Once a new worker may have run, rollback restores **only the previous code**, keeping the additive DB changes. Never rewind Signal keys or dedupe state after a live process might have advanced them.
- A failed first deployment leaves the worker stopped. A failed rollback requires operator recovery; CI reports failure.

Current/previous plus one older code release are retained. Pre-migration snapshots stay under `/var/backups/wareongo-sales-bot`; set monitored retention and off-instance encrypted backups before enabling production CD. A deployment snapshot alone is not a disaster-recovery policy. Back up the environment/encryption key separately and rehearse restoration with the original instance stopped. Never run two restored workers for the same account. Restoring stale Signal state may require relinking the account.

Inspect with `systemctl status wareongo-bot`, `journalctl -u wareongo-bot`, and the `wareongo-bot-build-*` / `wareongo-bot-migrate-*` journals. Monitor disk space, RSS, restarts and admin error/drop counters. Root backups and logs need restricted access. After fixing a repeated startup failure, reset the systemd start limit. Keep source releases and state on separate paths; never run `prisma migrate reset` in production.

For an operator-led binary rollback, stop the service, verify the target release/schema compatibility, atomically point `current` to the reviewed previous release, and start/check it. Keep the current database. Future non-additive schema changes need their own recovery plan; the automatic helper intentionally refuses them.

## Vercel admin

Import the **admin repository**, with root directory `.` and the Next.js preset. Its own README lists all five private environment variables and the separate CI-gated Vercel workflow. Set `WORKER_API_URL` to the EC2 HTTPS origin and use the same `WORKER_API_TOKEN`. Use a stable `ADMIN_ORIGIN`; previews need their own test worker and secrets. The admin does not need worker source, Prisma, SQLite or Baileys.

The admin's CD remains disabled until `VERCEL_DEPLOY_ENABLED=true`. Its `vercel.json` disables automatic Git deployment so CI cannot be bypassed; [Vercel documents that setting here](https://vercel.com/docs/project-configuration/git-configuration#git.deploymentenabled). Deployments use the pinned CLI and tested source revision. Maintain `/v1` compatibility when either repository deploys independently.

## Local evidence and remaining rollout checks

Local checks cover real SQLite migrations, encrypted credentials/key batches, dedupe, HTTP controls, persistent pause, shared limits, copied-cookie revocation, queue bounds, failure recovery, rollback ordering and WAL backups. Browser tests run both against an independent API fixture and against the separately installed real worker with a simulated WhatsApp transport.

Before production use, validate the actual EC2/SSM/IAM/Caddy path, memory under initial sync, off-instance recovery, and QR pairing/DM/group behavior with a dedicated test account. These external checks are not represented as completed by the local simulations. Conversational replies use the two-stage LangGraph flow when `OPENAI_API_KEY` is configured; see the [README](../README.md) for model settings and the isolated local playground. Sender-scoped CRM authorization and reminders remain future work.
