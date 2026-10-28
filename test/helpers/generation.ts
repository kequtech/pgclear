import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Compile a consumer of actual generated declarations against the built package. */
export async function checkGenerated(source: string, consumer: string): Promise<void> {
  const directory = await mkdtemp(resolve('.test-dist/generated-'));
  try {
    await writeFile(join(directory, 'schema.d.ts'), source);
    await writeFile(join(directory, 'consumer.ts'), consumer);
    await run(process.execPath, [
      resolve('node_modules/typescript/bin/tsc'),
      '--ignoreConfig',
      '--noEmit',
      '--strict',
      '--exactOptionalPropertyTypes',
      '--noUncheckedIndexedAccess',
      '--target',
      'ES2024',
      '--module',
      'NodeNext',
      '--types',
      'node',
      join(directory, 'consumer.ts'),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const typeAssertions = `
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
`;
