/** Minimal SSM command contract. It never forwards remote logs, which may contain credentials. */
import { commitSha } from './release-core.ts';

export interface SsmTarget {
  instance: string;
  document: string;
  version: string;
  region: string;
}
export function commandArguments(sha: string, target: SsmTarget): string[] {
  commitSha(sha);
  if (
    !/^i-[a-f0-9]{8,17}$/.test(target.instance) ||
    !/^[A-Za-z0-9_-]{3,128}$/.test(target.document) ||
    !/^[1-9][0-9]*$/.test(target.version) ||
    !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(target.region)
  )
    throw new Error('Invalid SSM target configuration');
  return [
    'ssm',
    'send-command',
    '--region',
    target.region,
    '--instance-ids',
    target.instance,
    '--document-name',
    target.document,
    '--document-version',
    target.version,
    '--parameters',
    JSON.stringify({ Commit: [sha] }),
    '--timeout-seconds',
    '60',
    '--output',
    'json',
    '--no-cli-pager',
  ];
}
export function invocationState(status: unknown): 'waiting' | 'success' {
  if (status === 'Success') return 'success';
  if (['Pending', 'InProgress', 'Delayed'].includes(String(status))) return 'waiting';
  throw new Error(
    `SSM deployment did not succeed (${String(status)
      .replace(/[^A-Za-z]/g, '')
      .slice(0, 32)})`,
  );
}
