import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
if (process.argv.length !== 3) throw Error('Pass an empty build directory.');
const directory = resolve(process.argv[2]);
await mkdir(directory); // Never overwrite an existing build.
const pin = JSON.parse(
  await readFile(new URL('../test/compatibility/pgbouncer.json', import.meta.url)),
);
const response = await fetch(pin.url, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw Error('PgBouncer source download failed.');
const archive = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(archive).digest('hex') !== pin.sha256)
  throw Error('PgBouncer source checksum differs from the pin.');
await writeFile(join(directory, 'source.tar.gz'), archive);
await run('tar', ['-xzf', 'source.tar.gz'], { cwd: directory });
const source = join(directory, 'pgbouncer-' + pin.version);
for (const [program, args] of [
  ['./configure', ['--without-cares']],
  ['make', ['-j2', 'pgbouncer']],
]) {
  const result = await run(program, args, {
    cwd: source,
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  await writeFile(
    join(directory, program === 'make' ? 'build.log' : 'configure.log'),
    result.stdout + result.stderr,
  );
}
console.log(join(source, 'pgbouncer'));
