/** Root-installed deployment adapter. Never execute a release's deployment helper as root. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { checkMigrations, commitSha, healthyRelease, release } from './release-core.ts';
import { restoreDatabase, snapshotDatabase } from './sqlite-backup.ts';

const exec = promisify(execFile);
const base = '/opt/wareongo-sales-bot';
const releases = join(base, 'releases');
const state = '/var/lib/wareongo-sales-bot';
const database = join(state, 'bot.db');
const backups = '/var/backups/wareongo-sales-bot';
const service = 'wareongo-bot.service';
const safeEnv: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_SSH_COMMAND:
    '/usr/bin/ssh -i /etc/wareongo-sales-bot/github-deploy-key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/wareongo-sales-bot/known_hosts',
};
async function command(file: string, args: string[], timeout = 120_000): Promise<string> {
  try {
    return (await exec(file, args, { env: safeEnv, timeout, maxBuffer: 4_194_304 })).stdout.trim();
  } catch {
    throw new Error(`${file} failed; inspect the protected host journal`);
  }
}
async function ownedConfig(): Promise<{ repository: string }> {
  const path = '/etc/wareongo-sales-bot/deploy.json';
  const info = await lstat(path);
  if (!info.isFile() || info.uid !== 0 || info.mode & 0o022)
    throw new Error('Deployment config must be root-owned and not writable by others');
  const config = JSON.parse(await readFile(path, 'utf8')) as { repository: string };
  if (
    !/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(config.repository) ||
    config.repository.includes('OWNER/')
  )
    throw new Error('Set the worker repository in deploy.json');
  return config;
}
async function currentLink(name: string): Promise<string | null> {
  try {
    if (!(await lstat(join(base, name))).isSymbolicLink())
      throw new Error('Current/previous must be release symlinks');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const path = await realpath(join(base, name));
  if (
    !path.startsWith(`${releases}/`) ||
    !/^[a-f0-9]{40}-[a-f0-9]+$/.test(path.slice(releases.length + 1))
  )
    throw new Error('Invalid release link');
  return path;
}
async function link(name: string, target: string | null) {
  if (!target) {
    await rm(join(base, name), { force: true });
    return;
  }
  const temporary = join(base, `.${name}-${randomBytes(6).toString('hex')}`);
  await symlink(target, temporary);
  await rename(temporary, join(base, name));
}
async function migrations(path: string | null): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!path) return result;
  const directory = join(path, 'prisma/migrations');
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid migrations directory');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Migration symlinks are not allowed');
    if (!entry.isDirectory()) continue;
    const file = join(directory, entry.name, 'migration.sql');
    if (!(await lstat(file)).isFile()) throw new Error('Invalid migration file');
    result.set(entry.name, await readFile(file, 'utf8'));
  }
  return result;
}
async function sandbox(
  unit: string,
  user: string,
  directory: string,
  args: string[],
  build: boolean,
) {
  await command(
    '/usr/bin/systemd-run',
    [
      '--quiet',
      '--wait',
      '--collect',
      `--unit=${unit}`,
      `--uid=${user}`,
      `--gid=${user}`,
      `--working-directory=${directory}`,
      '--property=Type=exec',
      '--property=NoNewPrivileges=true',
      '--property=ProtectSystem=strict',
      '--property=ProtectHome=true',
      '--property=PrivateTmp=true',
      '--property=PrivateDevices=true',
      '--property=RestrictSUIDSGID=true',
      '--property=KillMode=control-group',
      '--property=UMask=0077',
      `--property=RuntimeMaxSec=${build ? 800 : 120}`,
      '--property=MemoryMax=768M',
      '--property=MemorySwapMax=1G',
      '--property=CPUQuota=100%',
      '--property=IPAddressDeny=169.254.169.254/32 fd00:ec2::254/128',
      ...(build
        ? [
            `--property=ReadWritePaths=${directory} /var/cache/wareongo-bot-build`,
            `--property=InaccessiblePaths=/etc/wareongo-sales-bot ${state} ${backups}`,
            '--setenv=npm_config_cache=/var/cache/wareongo-bot-build',
            '--setenv=NODE_OPTIONS=--max-old-space-size=512',
            '--setenv=DATABASE_URL=file:/tmp/build-placeholder.db',
            '--setenv=CI=true',
          ]
        : [`--property=ReadWritePaths=${state}`, `--setenv=DATABASE_URL=file:${database}`]),
      '--',
      ...args,
    ],
    build ? 840_000 : 150_000,
  );
}
async function stop() {
  await command('/usr/bin/systemctl', ['stop', service]);
  if (
    (await command('/usr/bin/systemctl', ['show', '--property=MainPID', '--value', service])) !==
    '0'
  )
    throw new Error('Old worker did not stop');
}
async function start() {
  await command('/usr/bin/systemctl', ['reset-failed', service]);
  await command('/usr/bin/systemctl', ['start', service]);
}
async function verify(path: string) {
  const sha = path.slice(releases.length + 1).split('-')[0]!;
  let stable = 0;
  let previousPid = '';
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const pid = await command(
        '/usr/bin/systemctl',
        ['show', '--property=MainPID', '--value', service],
        5000,
      );
      if (!/^[1-9]\d*$/.test(pid) || (await readlink(`/proc/${pid}/cwd`)) !== path)
        throw new Error('Wrong worker process');
      const response = await fetch('http://127.0.0.1:3011/healthz', {
        signal: AbortSignal.timeout(2000),
        redirect: 'error',
      });
      const body = await response.text();
      if (!response.ok || body.length > 1024 || !healthyRelease(JSON.parse(body), sha))
        throw new Error('Wrong release health');
      if (
        (
          await fetch('http://127.0.0.1:3011/v1/status', {
            signal: AbortSignal.timeout(2000),
            redirect: 'error',
          })
        ).status !== 401
      )
        throw new Error('API authentication check failed');
      stable = pid === previousPid ? stable + 1 : 1;
      previousPid = pid;
      if (stable >= 3) return;
    } catch {
      stable = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Release did not pass stable readiness/authentication checks');
}

async function main() {
  if (process.getuid?.() !== 0)
    throw new Error('Use the root-installed SSM deployment entry point');
  const sha = commitSha(process.argv[2] ?? '');
  if (process.argv.length !== 3) throw new Error('Only one commit argument is accepted');
  const { repository } = await ownedConfig();
  await mkdir(releases, { recursive: true, mode: 0o755 });
  await mkdir(backups, { recursive: true, mode: 0o700 });
  const previous = await currentLink('current');
  const suffix = randomBytes(8).toString('hex');
  const staging = join(base, `incoming-${suffix}`);
  const archive = join(base, `source-${suffix}.tar`);
  const candidate = join(releases, `${sha}-${suffix}`);
  const gitDir = join(base, 'repository.git');
  const git = (args: string[]) =>
    command('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', `--git-dir=${gitDir}`, ...args]);
  const assertCurrent = async () => {
    const head = (
      await command('/usr/bin/git', ['ls-remote', repository, 'refs/heads/main'])
    ).split(/\s/)[0];
    if (head !== sha) throw new Error('Main advanced; wait for CI on its latest commit');
  };
  let snapshot: string | null = null;
  try {
    await release({
      async prepare() {
        await assertCurrent();
        try {
          await stat(gitDir);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await command('/usr/bin/git', ['init', '--bare', gitDir]);
        }
        await git(['fetch', '--depth=1', repository, 'refs/heads/main']);
        if ((await git(['rev-parse', 'FETCH_HEAD'])) !== sha)
          throw new Error('Fetched revision differs from tested commit');
        await git(['archive', '--format=tar', `--output=${archive}`, sha]);
        await command('/usr/bin/chmod', ['0644', archive]);
        await command('/usr/bin/install', [
          '-d',
          '-o',
          'wareongo-build',
          '-g',
          'wareongo-build',
          '-m',
          '0700',
          staging,
        ]);
        await command('/usr/sbin/runuser', [
          '-u',
          'wareongo-build',
          '--',
          '/usr/bin/tar',
          '--extract',
          '--no-same-owner',
          `--file=${archive}`,
          `--directory=${staging}`,
        ]);
        // No runtime credentials are passed to npm scripts or dependency install hooks.
        await sandbox(
          `wareongo-bot-build-${suffix}`,
          'wareongo-build',
          staging,
          [
            '/bin/sh',
            '-ec',
            'npm ci --include=dev --no-audit --no-fund && npm run prisma:generate && npm run build',
          ],
          true,
        );
        for (const file of [
          'dist/index.js',
          'prisma/schema.prisma',
          'node_modules/prisma/build/index.js',
        ]) {
          if (!(await realpath(join(staging, file))).startsWith(`${staging}/`))
            throw new Error('Artifact escapes release directory');
        }
        try {
          await lstat(join(staging, '.env'));
          throw new Error('Runtime .env must never be shipped in a release');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await writeFile(join(staging, 'release.env'), `RELEASE_SHA=${sha}\n`, {
          flag: 'wx',
          mode: 0o644,
        });
        await command('/usr/bin/chown', ['-hR', 'root:root', staging]);
        await command('/usr/bin/chmod', ['-R', 'u=rwX,go=rX', staging]);
        await rename(staging, candidate);
        checkMigrations(await migrations(previous), await migrations(candidate));
      },
      assertCurrent,
      stop,
      async backup() {
        const file = join(backups, `${Date.now()}-${sha}.db`);
        snapshot = (await snapshotDatabase(database, file)) ? file : null;
      },
      async migrate() {
        await sandbox(
          `wareongo-bot-migrate-${suffix}`,
          'wareongo-bot',
          candidate,
          [
            '/usr/bin/node',
            join(candidate, 'node_modules/prisma/build/index.js'),
            'migrate',
            'deploy',
          ],
          false,
        );
      },
      async activate() {
        await link('current', candidate);
      },
      start,
      async verify() {
        await verify(candidate);
      },
      async restoreDatabase() {
        await restoreDatabase(database, snapshot);
        if (snapshot) await command('/usr/bin/chown', ['wareongo-bot:wareongo-bot', database]);
      },
      async rollbackCode() {
        await link('current', previous);
        if (previous) {
          await start();
          await verify(previous);
        }
      },
      async recordSuccess() {
        await link('previous', previous);
      },
    });
    console.log(`Healthy worker release: ${sha}`);
    // Retain current/previous and one additional release. Backups have a separate retention policy.
    const keep = new Set([candidate, previous]);
    const entries = await readdir(releases, { withFileTypes: true });
    const others = await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            /^[a-f0-9]{40}-[a-f0-9]+$/.test(entry.name) &&
            !keep.has(join(releases, entry.name)),
        )
        .map(async (entry) => ({
          path: join(releases, entry.name),
          time: (await stat(join(releases, entry.name))).mtimeMs,
        })),
    );
    for (const entry of others.sort((a, b) => b.time - a.time).slice(1))
      await rm(entry.path, { recursive: true });
  } finally {
    await rm(archive, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(
    `Release failed: ${error instanceof Error ? error.message : 'unknown failure'}. Inspect systemd and verify rollback before retrying.`,
  );
  process.exitCode = 1;
});
