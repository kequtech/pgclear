import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, cp } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const exec = promisify(execFile),
  root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--source'))
  throw Error('Usage: npm run trial:tenon -- [--source /path/to/tenon-orm]');
const source = resolve(args[1] ?? join(root, '../tenon-orm'));
const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
const database = process.env.PGCLEAR_TEST_DATABASE_URL;
if (!database || decodeURIComponent(new URL(database).pathname.slice(1)) !== manifest.database)
  throw Error('The Tenon trial requires PGCLEAR_TEST_DATABASE_URL naming pgclear_test.');
await mkdir(join(root, '.trial-dist'), { recursive: true });
const directory = await mkdtemp(join(root, '.trial-dist/tenon-m4-'));
const report = {
  tenon: { version: manifest.version, commit: manifest.commit },
  pgclear: {},
  database: manifest.database,
  checks: [],
  status: 'running',
  nodeVersion: process.version,
};
console.log(`Trial output: ${directory}`);
async function command(label, program, args, cwd, environment = {}) {
  console.log(label);
  try {
    const result = await exec(program, args, {
      cwd,
      env: { ...process.env, ...environment },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120000,
    });
    const log = result.stdout + result.stderr;
    await writeFile(join(directory, label + '.log'), log);
    const summary = {};
    for (const key of ['tests', 'pass', 'fail', 'skipped']) {
      const matches = [...log.matchAll(new RegExp('(?:# |ℹ )' + key + ' (\\d+)', 'g'))];
      if (matches.length) summary[key] = Number(matches.at(-1)[1]);
    }
    report.checks.push({ label, status: 'passed', ...summary });
    return result.stdout;
  } catch (error) {
    await writeFile(
      join(directory, label + '.log'),
      (error.stdout ?? '') + (error.stderr ?? '') + '\n' + error.message,
    );
    report.checks.push({ label, status: 'failed' });
    throw Error(`${label} failed; inspect ${join(directory, label + '.log')}`, { cause: error });
  }
}
async function pack(label, cwd, destination) {
  await mkdir(destination, { recursive: true });
  const output = await command(
    label,
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    cwd,
  );
  const [metadata] = JSON.parse(output),
    filename = join(destination, metadata.filename);
  const sha256 = createHash('sha256')
    .update(await readFile(filename))
    .digest('hex');
  return { filename, sha256 };
}
try {
  await command(
    'verify-tenon-pin',
    'git',
    ['cat-file', '-e', manifest.commit + '^{commit}'],
    source,
  );
  report.pgclear.commit = (
    await command('pgclear-revision', 'git', ['rev-parse', 'HEAD'], root)
  ).trim();
  report.pgclear.workingTreeDirty = Boolean(
    (await command('pgclear-working-tree', 'git', ['status', '--porcelain'], root)).trim(),
  );
  await command('build-pgclear', 'npm', ['run', 'build'], root);
  const { connect } = await import(new URL('../../dist/index.js', import.meta.url));
  const admin = await connect(database);
  try {
    const row = (
      await admin.query(
        "SELECT current_database() AS name,current_setting('server_version') AS version",
      )
    ).rows[0];
    if (row.name !== manifest.database) throw Error('Connected to an unexpected database.');
    report.serverVersion = row.version;
  } finally {
    await admin.close();
  }
  const artifact = await pack('pack-pgclear', root, directory);
  report.pgclear.artifactSha256 = artifact.sha256;
  const archive = join(directory, 'tenon.tar');
  await command(
    'archive-tenon',
    'git',
    ['archive', '--format=tar', '--output=' + archive, manifest.commit],
    source,
  );
  for (const name of ['baseline', 'candidate']) {
    const checkout = join(directory, name);
    await mkdir(checkout);
    await command('extract-' + name, 'tar', ['-xf', archive, '-C', checkout], directory);
    const info = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8'));
    if (info.version !== manifest.version)
      throw Error('Pinned Tenon version differs from the trial manifest.');
  }
  const baseline = join(directory, 'baseline'),
    candidate = join(directory, 'candidate');
  // Only the snapshot's exact test-database allowlist and expectations change. Source is unmodified.
  async function relocateTests(folder) {
    const { readdir } = await import('node:fs/promises');
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await relocateTests(path);
      else if (/\.(ts|mjs)$/.test(path))
        await writeFile(
          path,
          (await readFile(path, 'utf8')).replaceAll('tenon_orm_test', manifest.database),
        );
    }
  }
  await relocateTests(join(baseline, 'test'));
  await command(
    'install-baseline',
    'npm',
    ['ci', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'],
    baseline,
  );
  await command('baseline-full-check', 'npm', ['run', 'check'], baseline, {
    TENON_TEST_DATABASE_URL: database,
  });
  const baselineArtifact = await pack(
    'pack-baseline',
    baseline,
    join(directory, 'baseline-artifacts'),
  );
  await command(
    'apply-candidate',
    'git',
    ['apply', '--directory=' + relative(root, candidate), join(root, 'trials/tenon/adapter.patch')],
    root,
  );
  await relocateTests(join(candidate, 'test'));
  await command(
    'apply-candidate-regressions',
    'git',
    [
      'apply',
      '--directory=' + relative(root, candidate),
      join(root, 'trials/tenon/regressions.patch'),
    ],
    root,
  );
  const info = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
  info.private = true;
  info.dependencies = { '@kequtech/pgclear': 'file:' + artifact.filename };
  await writeFile(join(candidate, 'package.json'), JSON.stringify(info, null, 2) + '\n');
  await command(
    'install-candidate',
    'npm',
    ['install', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'],
    candidate,
  );
  await command(
    'candidate-source-check',
    'npm',
    ['exec', '--', 'tsc', '--noEmit', '-p', 'config/tsconfig.build.json'],
    candidate,
  );
  await command(
    'candidate-format-check',
    'npm',
    ['exec', '--', 'prettier', '--check', 'src'],
    candidate,
  );
  await command('candidate-full-check', 'npm', ['run', 'check'], candidate, {
    TENON_TEST_DATABASE_URL: database,
  });
  const candidateArtifact = await pack(
    'pack-candidate',
    candidate,
    join(directory, 'candidate-artifacts'),
  );
  report.tenon.baselineArtifactSha256 = baselineArtifact.sha256;
  report.tenon.candidateArtifactSha256 = candidateArtifact.sha256;
  for (const [name, tenon] of [
    ['baseline', baselineArtifact],
    ['candidate', candidateArtifact],
  ]) {
    const consumer = join(directory, name + '-consumer');
    await mkdir(consumer);
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify(
        {
          name: 'pgclear-tenon-' + name + '-trial',
          private: true,
          type: 'module',
          dependencies: {
            '@kequtech/tenon-orm': 'file:' + tenon.filename,
            '@kequtech/pgclear': 'file:' + artifact.filename,
          },
          devDependencies: {
            '@types/node': info.devDependencies['@types/node'],
            typescript: info.devDependencies.typescript,
            'typescript-next': info.devDependencies['typescript-next'],
          },
        },
        null,
        2,
      ) + '\n',
    );
    await cp(join(root, 'trials/tenon/contract.test.mjs'), join(consumer, 'contract.test.mjs'));
    await command(
      'install-' + name + '-consumer',
      'npm',
      ['install', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'],
      consumer,
    );
    await command(
      name + '-contracts',
      process.execPath,
      ['--test', '--test-reporter=tap', 'contract.test.mjs'],
      consumer,
      { TENON_TRIAL_DRIVER: name === 'candidate' ? 'pgclear' : 'pg' },
    );
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  throw error;
} finally {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(
    join(root, '.trial-dist/latest-tenon-trial.json'),
    JSON.stringify({ directory, status: report.status }, null, 2) + '\n',
  );
}
console.log(`Trial passed. Evidence: ${join(directory, 'report.json')}`);
