import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// PostgreSQL REL_18_0/src/common/saslprep.c. Regeneration is an explicit, offline developer task.
const checksum = 'a47ab6c21ce2a2ae4b8027108bf340d7a714d940d152774d2b9cc3fad31af998';
if (process.argv.length !== 3) throw Error('Usage: node scripts/generate-saslprep.mjs saslprep.c');
const source = await readFile(process.argv[2]);
if (createHash('sha256').update(source).digest('hex') !== checksum)
  throw Error('SASLprep source differs from the PostgreSQL pin.');
const tables = [
  ['spaces', 'non_ascii_space_ranges'],
  ['nothing', 'commonly_mapped_to_nothing_ranges'],
  ['prohibited', 'prohibited_output_ranges'],
  ['unassigned', 'unassigned_codepoint_ranges'],
  ['randal', 'RandALCat_codepoint_ranges'],
  ['ltr', 'LCat_codepoint_ranges'],
];
let output = `// Generated from PostgreSQL REL_18_0/src/common/saslprep.c; see LICENSE.\n// SHA256 ${checksum}\n// Regenerate with scripts/generate-saslprep.mjs. Do not edit character ranges.\n\n`;
for (const [name, table] of tables) {
  const body = source
    .toString()
    .match(new RegExp(`static const pg_wchar ${table}\\[\\] =\\s*\\{([\\s\\S]*?)\\};`))?.[1];
  if (!body) throw Error('Missing table: ' + table);
  const values = [...body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/0x([\dA-Fa-f]+)/g)].map(
    (match) => parseInt(match[1], 16),
  );
  if (!values.length || values.length % 2) throw Error('Invalid ranges: ' + table);
  let pattern = '',
    previous = -1;
  for (let i = 0; i < values.length; i += 2) {
    const [start, end] = [values[i], values[i + 1]];
    if (start <= previous || start > end || end > 0x10ffff)
      throw Error('Unsorted ranges: ' + table);
    const escape = (code) => `\\u{${code.toString(16)}}`;
    pattern += escape(start) + (start === end ? '' : '-' + escape(end));
    previous = end;
  }
  output += `// prettier-ignore\nexport const ${name} = /[${pattern}]/u;\n`;
}
await writeFile(new URL('../src/auth/saslprep-tables.ts', import.meta.url), output);
