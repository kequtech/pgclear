import { DriverError } from '../errors.js';
import type { Codec, CodecRegistry, Field } from '../types.js';
import { arrayElements, parseArray } from './arrays.js';
import { builtin, oidCodec } from './builtin.js';

export function snapshotCodec<T>(codec: Codec<T>): Codec<T> {
  const invalid = (): never => {
    throw new DriverError('PGCLEAR_CONFIGURATION', 'Invalid codec definition.');
  };
  if (
    !codec ||
    typeof codec !== 'object' ||
    !Number.isInteger(codec.oid) ||
    codec.oid < 1 ||
    codec.oid > 0xffffffff ||
    (!codec.text && !codec.binary)
  )
    invalid();
  for (const format of [codec.text, codec.binary])
    if (
      format !== undefined &&
      (!format || typeof format.encode !== 'function' || typeof format.decode !== 'function')
    )
      invalid();
  return Object.freeze({
    oid: codec.oid,
    ...(codec.text
      ? { text: Object.freeze({ encode: codec.text.encode, decode: codec.text.decode }) }
      : {}),
    ...(codec.binary
      ? { binary: Object.freeze({ encode: codec.binary.encode, decode: codec.binary.decode }) }
      : {}),
  });
}
type Decoder = ((value: string) => unknown) | undefined;
const scalars: ReadonlyMap<number, Decoder> = new Map([
  ...[
    builtin.bool,
    builtin.int2,
    builtin.int4,
    builtin.int8,
    builtin.float4,
    builtin.float8,
    builtin.numeric,
    builtin.text,
    builtin.uuid,
    builtin.bytea,
    builtin.json,
    builtin.jsonb,
    builtin.date,
    builtin.timestamp,
    builtin.timestamptz,
    oidCodec,
  ].map((codec) => [codec.oid, codec.text!.decode] as const),
]);
// PostgreSQL field bytes are data, not a BOM-prefixed document.
const utf8 = new TextDecoder('utf8', { fatal: true, ignoreBOM: true });

class Registry implements CodecRegistry {
  readonly #overrides: ReadonlyMap<number, Decoder>;
  constructor(overrides: ReadonlyMap<number, Decoder> = new Map()) {
    this.#overrides = overrides;
    Object.freeze(this);
  }
  with<T>(codec: Codec<T>): CodecRegistry {
    const snapshot = snapshotCodec(codec),
      next = new Map(this.#overrides);
    next.set(snapshot.oid, snapshot.text?.decode);
    return new Registry(next);
  }
  text(oid: number, value: string): unknown {
    const selected = this.#overrides.has(oid) ? this.#overrides.get(oid) : scalars.get(oid);
    if (this.#overrides.has(oid) || !arrayElements.has(oid)) {
      const result = selected ? selected(value) : value;
      if (
        result &&
        (typeof result === 'object' || typeof result === 'function') &&
        'then' in result &&
        typeof result.then === 'function'
      ) {
        void Promise.resolve(result).catch(() => {});
        throw new TypeError('Codec decoders must be synchronous.');
      }
      return result;
    }
    const element = arrayElements.get(oid);
    if (element !== undefined)
      return parseArray(value, (text) => this.text(element, text), oid === 1020 ? ';' : ',');
    return value;
  }
  decode(value: Buffer | null, field: Field): unknown {
    if (value === null) return null;
    if (field.format !== 'text') throw new TypeError('Binary result negotiation is not enabled.');
    return this.text(field.dataTypeOid, utf8.decode(value));
  }
}
export const defaultCodecs: CodecRegistry = new Registry();
export function registry(value: CodecRegistry): Registry {
  if (!(value instanceof Registry))
    throw new DriverError(
      'PGCLEAR_CONFIGURATION',
      'Use defaultCodecs.with() to construct a codec registry.',
    );
  return value;
}
export { builtin } from './builtin.js';
