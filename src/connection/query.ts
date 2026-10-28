import { DriverError } from '../errors.js';
import type { Field, InputValue, Statement, CommandResult } from '../types.js';
import { cstring, frame, int16, int32, uint32 } from '../protocol/framing.js';

function invalid(message: string): never {
  throw new DriverError('PGCLEAR_ENCODE', message);
}

export function encodeQuery(input: string | Statement): Buffer {
  if (typeof input !== 'string' && (!input || typeof input !== 'object' || Array.isArray(input)))
    invalid('Expected SQL text or a statement.');
  const statement = typeof input === 'string' ? { text: input } : input;
  if (Object.keys(statement).some((key) => !['text', 'values', 'parameterTypes'].includes(key)))
    invalid('Unknown statement option.');
  if (typeof statement.text !== 'string' || statement.text.includes('\0'))
    invalid('SQL text must be a string without NUL.');
  const values = statement.values === undefined ? [] : statement.values;
  if (!Array.isArray(values) || values.length > 65535) invalid('Invalid parameter count.');
  const hints = statement.parameterTypes;
  if (hints !== undefined && (!Array.isArray(hints) || hints.length !== values.length))
    invalid('Parameter type hints must match values.');
  const oids: number[] = [],
    formats: Buffer[] = [],
    parameters: Buffer[] = [];
  // Array.from visits sparse entries, so holes cannot silently become SQL NULL.
  for (const [index, value] of Array.from(values as readonly InputValue[]).entries()) {
    let oid = 0,
      bytes: Buffer | undefined,
      format = 0;
    if (value === null) {
      /* Protocol NULL. */
    } else if (typeof value === 'string') {
      if (value.includes('\0')) invalid('Text parameters cannot contain NUL.');
      bytes = Buffer.from(value);
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
        invalid('Invalid numeric parameter; use bigint or a typed codec.');
      bytes = Buffer.from(String(value));
    } else if (typeof value === 'bigint') {
      oid = 20;
      bytes = Buffer.from(String(value));
    } else if (typeof value === 'boolean') {
      oid = 16;
      bytes = Buffer.from(value ? 't' : 'f');
    } else if (value instanceof Uint8Array) {
      oid = 17;
      format = 1;
      bytes = Buffer.from(value);
    } else invalid('Unsupported parameter value; explicit codecs are introduced in M2.');
    const hint = hints?.[index];
    if (hints && (hint === undefined || !Number.isInteger(hint) || hint < 0 || hint > 0xffffffff))
      invalid('Invalid parameter OID.');
    if (hint && oid && hint !== oid) invalid('Conflicting parameter OID.');
    oids.push(hint || oid);
    formats.push(int16(format));
    parameters.push(bytes === undefined ? int32(-1) : Buffer.concat([int32(bytes.length), bytes]));
  }
  return Buffer.concat([
    frame(
      'P',
      Buffer.concat([
        cstring(''),
        cstring(statement.text),
        int16(oids.length),
        ...oids.map(uint32),
      ]),
    ),
    frame(
      'B',
      Buffer.concat([
        cstring(''),
        cstring(''),
        int16(values.length),
        ...formats,
        int16(values.length),
        ...parameters,
        int16(0),
      ]),
    ),
    frame('D', Buffer.from('P'), cstring('')),
    frame('E', cstring(''), int32(0)),
    frame('S'),
  ]);
}

const utf8 = new TextDecoder('utf8', { fatal: true });
/** Minimal scalar result decoding for M1; registry and array support belong to M2. */
export function decodeValue(value: Buffer | null, field: Field): unknown {
  if (value === null) return null;
  if (field.format !== 'text') throw new Error('Unexpected binary result.');
  const text = utf8.decode(value);
  switch (field.dataTypeOid) {
    case 16:
      if (!['t', 'f'].includes(text)) throw new Error('Invalid boolean.');
      return text === 't';
    case 20:
      if (!/^-?\d+$/.test(text)) throw new Error('Invalid int8.');
      return BigInt(text);
    case 21:
    case 23:
    case 26: {
      const number = Number(text);
      if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(number))
        throw new Error('Invalid integer.');
      return number;
    }
    case 700:
    case 701: {
      if (text === 'Infinity') return Infinity;
      if (text === '-Infinity') return -Infinity;
      if (text === 'NaN') return NaN;
      const number = Number(text);
      if (!text || !Number.isFinite(number)) throw new Error('Invalid float.');
      return number;
    }
    case 114:
    case 3802:
      return JSON.parse(text) as unknown;
    case 17:
      if (!/^\\x(?:[0-9a-f]{2})*$/.test(text)) throw new Error('Unsupported bytea encoding.');
      return new Uint8Array(Buffer.from(text.slice(2), 'hex'));
    default:
      return text;
  }
}

export function commandResult(tag: string): CommandResult {
  const parts = tag.split(' ');
  const command = parts[0] ?? '';
  const counted = /^(?:INSERT \d+|SELECT|UPDATE|DELETE|MERGE|MOVE|FETCH|COPY) (\d+)$/.exec(tag);
  return Object.freeze({
    command,
    commandTag: tag,
    rowCount: counted ? BigInt(counted[1]!) : null,
  });
}
