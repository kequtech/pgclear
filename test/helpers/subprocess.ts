import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

/** A leaked hour-long deadline or socket must prevent natural exit and fail this check. */
export async function runLifecycle(
  kind: 'describe' | 'prepare' | 'stream' | 'copy' | 'pool',
  scenario: string,
  port: number,
): Promise<void> {
  const fixture = new URL('../fixtures/lifecycle/child.js', import.meta.url);
  await run(process.execPath, [fileURLToPath(fixture), kind, scenario, String(port)], {
    timeout: 3000,
  });
}
