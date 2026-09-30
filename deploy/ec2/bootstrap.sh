#!/bin/bash
# One-time, root-reviewed host provisioning. No application build runs as root.
set -euo pipefail
umask 077
sha=${1:?Expected reviewed bootstrap commit}
region=${2:?Expected AWS region}
bucket=${3:?Expected private backup bucket}
[[ "$sha" =~ ^[a-f0-9]{40}$ ]]
[[ "$region" =~ ^[a-z]{2}-[a-z]+-[0-9]$ ]]
[[ "$bucket" =~ ^[a-z0-9-]{3,63}$ ]]
[[ $(id -u) == 0 ]]

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git openssh-client tar util-linux awscli sqlite3
install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --retry 5 https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /tmp/wareongo-nodesource.asc
gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg /tmp/wareongo-nodesource.asc
chmod 0644 /etc/apt/keyrings/nodesource.gpg
printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get install -y -qq nodejs
/usr/bin/node -e 'if (process.versions.node.split(".")[0] !== "22") process.exit(1)'

# Swap bounds memory pressure during dependency installation on a 1 GiB instance.
if [[ ! -e /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 0600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab
fi
printf '%s\n' 'vm.swappiness=10' > /etc/sysctl.d/90-wareongo-bot.conf
sysctl -p /etc/sysctl.d/90-wareongo-bot.conf
install -d -m 0755 /etc/systemd/journald.conf.d
printf '%s\n' '[Journal]' 'SystemMaxUse=100M' 'MaxRetentionSec=7day' > /etc/systemd/journald.conf.d/wareongo-bot.conf
systemctl restart systemd-journald

id wareongo-bot >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/wareongo-sales-bot --no-create-home --shell /usr/sbin/nologin wareongo-bot
id wareongo-build >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/cache/wareongo-bot-build --no-create-home --shell /usr/sbin/nologin wareongo-build
install -d -o root -g root -m 0755 /opt/wareongo-sales-bot /opt/wareongo-sales-bot/releases /usr/local/lib/wareongo-bot-deploy/ec2
install -d -o root -g root -m 0700 /etc/wareongo-sales-bot /var/backups/wareongo-sales-bot
install -d -o wareongo-bot -g wareongo-bot -m 0700 /var/lib/wareongo-sales-bot
install -d -o wareongo-build -g wareongo-build -m 0700 /var/cache/wareongo-bot-build

bootstrap_dir=$(mktemp -d /var/tmp/wareongo-bootstrap.XXXXXXXX)
trap 'rm -rf "$bootstrap_dir"' EXIT
curl --fail --silent --show-error --location --retry 5 "https://codeload.github.com/rs0125/ramesh-bot/tar.gz/$sha" -o "$bootstrap_dir/source.tar.gz"
tar --extract --gzip --no-same-owner --file="$bootstrap_dir/source.tar.gz" --directory="$bootstrap_dir"
source_dir="$bootstrap_dir/ramesh-bot-$sha"
install -o root -g root -m 0644 "$source_dir"/deploy/{ec2-release,release-core,sqlite-backup}.ts /usr/local/lib/wareongo-bot-deploy/
install -o root -g root -m 0644 "$source_dir/deploy/ec2/backup.ts" /usr/local/lib/wareongo-bot-deploy/ec2/
install -o root -g root -m 0755 "$source_dir/deploy/ec2/wareongo-bot-deploy" /usr/local/sbin/wareongo-bot-deploy
install -o root -g root -m 0644 "$source_dir"/deploy/ec2/wareongo-bot*.service "$source_dir/deploy/ec2/wareongo-bot-backup.timer" /etc/systemd/system/
printf '%s\n' '{"repository":"git@github.com:rs0125/ramesh-bot.git"}' > /etc/wareongo-sales-bot/deploy.json
printf 'AWS_REGION=%s\nBACKUP_BUCKET=%s\n' "$region" "$bucket" > /etc/wareongo-sales-bot/backup.env

# Preserve secrets on retries/replacements. No values are printed or put in user data.
REGION_FOR_BOOTSTRAP="$region" python3 - <<'PY'
import json, os, pathlib, secrets, subprocess
parameter = '/ramesh-bot/production/runtime'
region = os.environ['REGION_FOR_BOOTSTRAP']
def aws(*args):
    return subprocess.run(['aws', *args, '--region', region, '--output', 'json', '--no-cli-pager'], text=True, capture_output=True)
read = aws('ssm', 'get-parameter', '--name', parameter, '--with-decryption')
if read.returncode == 0:
    values = json.loads(json.loads(read.stdout)['Parameter']['Value'])
elif 'ParameterNotFound' in read.stderr:
    values = {'AUTH_ENCRYPTION_KEY': secrets.token_urlsafe(32), 'WORKER_API_TOKEN': secrets.token_urlsafe(48)}
    payload = pathlib.Path('/etc/wareongo-sales-bot/.parameter-upload.json')
    payload.write_text(json.dumps({'Name': parameter, 'Type': 'SecureString', 'Tier': 'Standard', 'Value': json.dumps(values), 'Description': 'Ramesh bot production runtime secrets; separate from database backups'}))
    payload.chmod(0o600)
    try:
        result = aws('ssm', 'put-parameter', '--cli-input-json', 'file://' + str(payload))
        if result.returncode: raise RuntimeError('Could not back up runtime secrets')
    finally:
        payload.unlink(missing_ok=True)
else:
    raise RuntimeError('Could not read runtime secrets')
path = pathlib.Path('/etc/wareongo-sales-bot/worker.env')
if not path.exists():
    settings = {'DATABASE_URL':'file:/var/lib/wareongo-sales-bot/bot.db', **values, 'LOG_LEVEL':'info', 'WORKER_HOST':'127.0.0.1', 'WORKER_PORT':'3011', 'WHATSAPP_AUTO_CONNECT':'false', 'PRINT_QR':'false'}
    path.write_text(''.join(k + '=' + json.dumps(v) + '\n' for k,v in settings.items()))
    path.chmod(0o600)
PY

# Fetch published GitHub host keys over authenticated HTTPS, then pin the official Ed25519 fingerprint.
curl --fail --silent --show-error --retry 5 https://api.github.com/meta -o "$bootstrap_dir/github-meta.json"
python3 - "$bootstrap_dir/github-meta.json" <<'PY'
import base64, hashlib, json, pathlib, sys
keys = json.loads(pathlib.Path(sys.argv[1]).read_text())['ssh_keys']
key = next(k for k in keys if k.startswith('ssh-ed25519 '))
fingerprint = base64.b64encode(hashlib.sha256(base64.b64decode(key.split()[1])).digest()).decode().rstrip('=')
if fingerprint != '+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU':
    raise RuntimeError('GitHub host key changed; review official fingerprints')
pathlib.Path('/etc/wareongo-sales-bot/known_hosts').write_text('github.com ' + key + '\n')
PY
if [[ ! -f /etc/wareongo-sales-bot/github-deploy-key ]]; then
  ssh-keygen -q -t ed25519 -N '' -C 'ramesh-bot-ec2-readonly' -f /etc/wareongo-sales-bot/github-deploy-key
fi
chmod 0600 /etc/wareongo-sales-bot/*
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/wareongo-bot.service /etc/systemd/system/wareongo-bot-backup.service /etc/systemd/system/wareongo-bot-backup.timer
systemctl enable wareongo-bot.service
# The timer is enabled after the first successful deployment and backup verification.
printf '%s\n' "$sha" > /etc/wareongo-sales-bot/bootstrap-commit
printf '%s\n' 'Bootstrap complete; register the read-only deploy key before the first release.'
