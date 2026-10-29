import { DriverError } from '../errors.js';
import type { Codec, Parameter, WireFormat } from '../types.js';
import { builtin, stringifyJson, synchronous, textValue } from './builtin.js';
import { snapshotCodec } from './index.js';
import { sharedWeakMap } from '../identity.js';

interface EncodedParameter {
  readonly oid: number;
  readonly format: number;
  readonly bytes: Buffer | null;
}
const descriptions = sharedWeakMap<Parameter, () => EncodedParameter>('parameters');
function description(encode: () => EncodedParameter): Parameter {
  const value = Object.freeze({}) as Parameter;
  descriptions.set(value, encode);
  return value;
}
export function param<T>(
  value: NoInfer<T> | null,
  codec: Codec<T>,
  format?: WireFormat,
): Parameter {
  const selected = snapshotCodec(codec),
    wireFormat = format === undefined ? (selected.text ? 'text' : 'binary') : format;
  if (!['text', 'binary'].includes(wireFormat) || !selected[wireFormat])
    throw new DriverError('PGCLEAR_CONFIGURATION', 'Codec does not implement the selected format.');
  return description(() => {
    if (value === null)
      return { oid: selected.oid, format: wireFormat === 'text' ? 0 : 1, bytes: null };
    const encoded = synchronous(
      wireFormat === 'text' ? selected.text!.encode(value) : selected.binary!.encode(value),
    );
    if (wireFormat === 'text')
      return { oid: selected.oid, format: 0, bytes: Buffer.from(textValue(encoded)) };
    if (!(encoded instanceof Uint8Array))
      throw new TypeError('Binary encoder must return Uint8Array.');
    return { oid: selected.oid, format: 1, bytes: Buffer.from(encoded) };
  });
}
export function json(value: unknown, type: 'json' | 'jsonb' = 'jsonb'): Parameter {
  if (type !== 'json' && type !== 'jsonb')
    throw new DriverError('PGCLEAR_CONFIGURATION', 'Unknown JSON type.');
  return description(() => ({
    oid: builtin[type].oid,
    format: 0,
    bytes: Buffer.from(textValue(stringifyJson(value))),
  }));
}
export function encodeParameter(value: Parameter): EncodedParameter | undefined {
  return descriptions.get(value)?.();
}
