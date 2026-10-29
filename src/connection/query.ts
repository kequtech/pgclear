import { DriverError } from '../errors.js';
import type {
  InputValue,
  QueryInput,
  Statement,
  CommandResult,
  DescribeStatement,
  Parameter,
} from '../types.js';
import { encodeParameter } from '../codecs/parameters.js';
import { textValue } from '../codecs/builtin.js';
import { temporalText } from '../codecs/temporal.js';
import { cstring, frame, int16, int32, uint32 } from '../protocol/framing.js';

function invalid(message: string): never {
  throw new DriverError('PGCLEAR_ENCODE', message);
}

export function encodeQuery(
  input: QueryInput<object>,
  { batchSize = 0, flush = batchSize > 0 }: { batchSize?: number; flush?: boolean } = {},
): Buffer {
  if (typeof input !== 'string' && (!input || typeof input !== 'object'))
    invalid('Expected SQL text, a query tuple or a statement.');
  if (
    Array.isArray(input) &&
    (input.length !== 2 || typeof input[0] !== 'string' || !Array.isArray(input[1]))
  )
    invalid('Expected a [text, values] query tuple.');
  const statement: Statement =
    typeof input === 'string'
      ? { text: input }
      : Array.isArray(input)
        ? { text: input[0] as string, values: input[1] as readonly InputValue[] }
        : (input as Statement);
  if (Object.keys(statement).some((key) => !['text', 'values', 'parameterTypes'].includes(key)))
    invalid('Unknown statement option.');
  const text = textValue(statement.text);
  const values = statement.values === undefined ? [] : statement.values;
  if (!Array.isArray(values) || values.length > 65535) invalid('Invalid parameter count.');
  const hints = statement.parameterTypes;
  if (hints !== undefined && (!Array.isArray(hints) || hints.length !== values.length))
    invalid('Parameter type hints must match values.');
  const { oids, formats, parameters } = encodeValues(values, hints);
  return Buffer.concat([
    frame(
      'P',
      Buffer.concat([cstring(''), cstring(text), int16(oids.length), ...oids.map(uint32)]),
    ),
    bind('', values.length, formats, parameters),
    frame('D', Buffer.from('P'), cstring('')),
    frame('E', cstring(''), int32(batchSize)),
    frame(flush ? 'H' : 'S'),
  ]);
}

/** Shared bind encoding; preparation never runs user encoders until execution is reserved. */
function encodeValues(values: readonly InputValue[], hints?: readonly number[]) {
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
      if (value.includes('\0') || !value.isWellFormed()) invalid('Invalid text parameter.');
      bytes = Buffer.from(value);
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
        invalid('Invalid numeric parameter; use exact text or a typed codec.');
      bytes = Buffer.from(String(value));
    } else if (typeof value === 'bigint') {
      bytes = Buffer.from(String(value));
    } else if (typeof value === 'boolean') {
      oid = 16;
      bytes = Buffer.from(value ? 't' : 'f');
    } else if (value instanceof Uint8Array) {
      oid = 17;
      format = 1;
      bytes = Buffer.from(value);
    } else if (value instanceof Date) {
      if (!Number.isFinite(Date.prototype.getTime.call(value))) invalid('Invalid Date parameter.');
      bytes = Buffer.from(temporalText(value));
    } else {
      const encoded =
        value && typeof value === 'object' ? encodeParameter(value as Parameter) : undefined;
      if (encoded) {
        oid = encoded.oid;
        format = encoded.format;
        bytes = encoded.bytes === null ? undefined : encoded.bytes;
      } else {
        const temporal = temporalText(value);
        if (temporal === undefined)
          invalid('Unsupported parameter value; use an explicit codec or json().');
        bytes = Buffer.from(temporal);
      }
    }
    const hint = hints?.[index];
    if (hints && (hint === undefined || !Number.isInteger(hint) || hint < 0 || hint > 0xffffffff))
      invalid('Invalid parameter OID.');
    if (hint && oid && hint !== oid) invalid('Conflicting parameter OID.');
    oids.push(hint || oid);
    formats.push(int16(format));
    parameters.push(bytes === undefined ? int32(-1) : Buffer.concat([int32(bytes.length), bytes]));
  }
  return { oids, formats, parameters };
}

export function encodePreparedQuery(
  name: string,
  values: readonly InputValue[],
  parameterTypes: readonly number[],
): Buffer {
  if (!Array.isArray(values) || values.length !== parameterTypes.length)
    invalid('Prepared parameter count must match its description.');
  const { formats, parameters } = encodeValues(values, parameterTypes);
  return Buffer.concat([
    bind(name, values.length, formats, parameters),
    frame('D', Buffer.from('P'), cstring('')),
    frame('E', cstring(''), int32(0)),
    frame('S'),
  ]);
}

function bind(
  statement: string,
  count: number,
  formats: readonly Buffer[],
  parameters: readonly Buffer[],
): Buffer {
  return frame(
    'B',
    Buffer.concat([
      cstring(''),
      cstring(statement),
      int16(count),
      ...formats,
      int16(count),
      ...parameters,
      int16(0),
    ]),
  );
}

export function encodePortalExecute(batchSize: number): Buffer {
  return Buffer.concat([frame('E', cstring(''), int32(batchSize)), frame('H')]);
}
export function encodePortalClose(): Buffer {
  return Buffer.concat([frame('C', Buffer.from('P'), cstring('')), frame('S')]);
}
export const sync = frame('S');

export function encodeStatementClose(name: string): Buffer {
  return Buffer.concat([frame('C', Buffer.from('S'), cstring(name)), frame('S')]);
}

export function encodeDescribe(input: string | DescribeStatement, name = ''): Buffer {
  if (typeof input !== 'string' && (!input || typeof input !== 'object' || Array.isArray(input)))
    invalid('Expected SQL text or a description statement.');
  const statement = typeof input === 'string' ? { text: input } : input;
  if (Object.keys(statement).some((key) => !['text', 'parameterTypes'].includes(key)))
    invalid('Describe accepts no execution values.');
  const text = textValue(statement.text),
    hints = statement.parameterTypes === undefined ? [] : statement.parameterTypes;
  if (!Array.isArray(hints) || hints.length > 65535) invalid('Invalid parameter hints.');
  for (const hint of hints)
    if (!Number.isInteger(hint) || hint < 0 || hint > 0xffffffff) invalid('Invalid parameter OID.');
  return Buffer.concat([
    frame(
      'P',
      Buffer.concat([cstring(name), cstring(text), int16(hints.length), ...hints.map(uint32)]),
    ),
    frame('D', Buffer.from('S'), cstring(name)),
    frame('S'),
  ]);
}

export function encodeScript(text: string): Buffer {
  return frame('Q', cstring(textValue(text)));
}

export function commandResult(tag: string, returnedRows?: number): CommandResult {
  const parts = tag.split(' ');
  const command = parts[0] ?? '';
  const counted = /^(?:INSERT \d+|SELECT|UPDATE|DELETE|MERGE|MOVE|FETCH|COPY) (\d+)$/.exec(tag);
  const rowCount = returnedRows ?? (counted ? Number(counted[1]!) : null);
  if (rowCount !== null && (!Number.isSafeInteger(rowCount) || rowCount < 0))
    throw new DriverError(
      'PGCLEAR_RESULT_LIMIT',
      'Row count exceeds the JavaScript safe integer range.',
      'confirmed',
    );
  return Object.freeze({
    command,
    commandTag: tag,
    rowCount,
  });
}
