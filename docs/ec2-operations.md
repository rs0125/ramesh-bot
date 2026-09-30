# Private EC2 operations

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
  --parameters '{"portNumber":["3011"],"localPortNumber":["3012"]}'
```

The tunneled API is `http://127.0.0.1:3012`. Point a local admin instance's `WORKER_API_URL` there and set its `WORKER_API_TOKEN` to the production token from the protected `/ramesh-bot/production/runtime` SecureString parameter. Do not reuse the development token or commit credentials. Keep the tunnel running while using that admin instance.

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

The service starts with WhatsApp auto-connect disabled until an operator pairs an account through the admin. Never copy a running local account's database onto EC2 while both processes can use the same credentials. A migration of an existing session needs a controlled stop and consistent snapshot; it is separate from provisioning.

## State and recovery

- Live SQLite database: `/var/lib/wareongo-sales-bot/bot.db`, private to `wareongo-bot`.
- Runtime secrets: `/etc/wareongo-sales-bot/worker.env`, root-only; a separate encrypted copy lives in Parameter Store at `/ramesh-bot/production/runtime`.
- Daily consistent database snapshots: the stack's private S3 bucket, `daily/`, encrypted with SSE-S3, expiring after 14 days.
- Local pre-deployment snapshots: `/var/backups/wareongo-sales-bot`; snapshots older than seven days are removed only after a successful S3 upload.
- Daily timer: 02:30 UTC plus up to 15 minutes of jitter. Failed backups remain visible as a failed systemd unit; external alert delivery is not configured.

For restoration, stop the original worker first, retrieve the database snapshot and its matching encryption key using an authorized operator, verify SQLite integrity, install the DB with `wareongo-bot` ownership and mode `0600`, and start a compatible release. A stale WhatsApp session may require relinking. Never rewind Signal state as part of an ordinary code rollback.

Stack termination protection is enabled. The instance and backup bucket are retained on deletion/replacement. Removing the stack therefore does **not** stop billing for retained resources; inventory and explicitly retire them during decommissioning. Do not replace a paired instance without stopping its old worker.

## Cost

The AWS Price List API on September 30, 2026 returned $0.0112/hour for Linux `t3.micro` in Mumbai and $0.0912/GB-month for gp3. At 730 hours, compute is $8.18, 20 GiB storage is $1.82, and the public IPv4 address is $3.65: **$13.65/month before tax, credits, backup storage, and billable transfer**. CPU credits use `standard` mode, so sustained CPU load is throttled instead of incurring unlimited-mode credit charges. Resize only after observing resource use.

[EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/), [EBS pricing](https://aws.amazon.com/ebs/pricing/), [IPv4 pricing](https://aws.amazon.com/vpc/pricing/), and [SSM pricing](https://aws.amazon.com/systems-manager/pricing/) are the pricing references. No NAT gateway, load balancer, RDS database, or public HTTPS endpoint is provisioned by this stack.
