/** GitHub runner entry point: one tested commit, one fixed document, one instance. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { commandArguments, invocationState } from './ssm-client.ts';
const exec = promisify(execFile);
const target = {
  instance: process.env.EC2_INSTANCE_ID ?? '',
  document: process.env.SSM_DOCUMENT_NAME ?? '',
  version: process.env.SSM_DOCUMENT_VERSION ?? '',
  region: process.env.AWS_REGION ?? '',
};
async function aws(args: string[]): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await exec('aws', args, { timeout: 30_000, maxBuffer: 1_048_576 });
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error('AWS command failed; inspect the SSM console with authorized access');
  }
}
try {
  const sent = await aws(commandArguments(process.argv[2] ?? '', target));
  const id = (sent.Command as Record<string, unknown> | undefined)?.CommandId;
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
    throw new Error('Invalid SSM command ID');
  console.log(`Deployment command: ${id}`);
  const deadline = Date.now() + 1_830_000;
  let succeeded = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    let result: Record<string, unknown>;
    try {
      result = await aws([
        'ssm',
        'get-command-invocation',
        '--region',
        target.region,
        '--instance-id',
        target.instance,
        '--command-id',
        id,
        '--output',
        'json',
        '--no-cli-pager',
      ]);
    } catch {
      continue;
    } // SSM is eventually consistent; a bounded timeout still fails the job.
    if (invocationState(result.Status) === 'success') {
      succeeded = true;
      break;
    }
  }
  if (!succeeded) throw new Error('Timed out waiting for deployment; inspect SSM before retrying');
  console.log('EC2 release passed health checks.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Deployment failed');
  process.exitCode = 1;
}
