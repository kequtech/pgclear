import { DriverError } from '../errors.js';
import type { Codec, CodecRegistry, Field } from '../types.js';
import { arrayElements, parseArray } from './arrays.js';
import { builtin, oidCodec, synchronous } from './builtin.js';
import { sharedWeakMap } from '../identity.js';

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
// Generation and decoding share these registrations; unknown OIDs remain wire text.
const scalarTypes = [
  [builtin.bool, 'boolean'],
  [builtin.int2, 'number'],
  [builtin.int4, 'number'],
  [builtin.int8, 'bigint'],
  [builtin.float4, 'number'],
  [builtin.float8, 'number'],
  [builtin.numeric, 'string'],
  [builtin.text, 'string'],
  [builtin.uuid, 'string'],
  [builtin.bytea, 'globalThis.Uint8Array'],
  [builtin.json, 'unknown'],
  [builtin.jsonb, 'unknown'],
  [builtin.date, 'string'],
  [builtin.timestamp, 'string'],
  [builtin.timestamptz, 'string'],
  [oidCodec, 'number'],
] as const;
const scalars: ReadonlyMap<number, Decoder> = new Map(
  scalarTypes.map(([codec]) => [codec.oid, codec.text!.decode]),
);
const knownTypes = sharedWeakMap<NonNullable<Decoder>, string>('decoder-types');
for (const [codec, type] of scalarTypes) knownTypes.set(codec.text!.decode, type);
for (const codec of Object.values(builtin)) {
  const element = arrayElements.get(codec.oid);
  if (element !== undefined && codec.text) {
    const decode = scalars.get(element);
    knownTypes.set(codec.text.decode, `PgArray<${decode ? knownTypes.get(decode) : 'string'}>`);
  }
}
// PostgreSQL field bytes are data, not a BOM-prefixed document.
const utf8 = new TextDecoder('utf8', { fatal: true, ignoreBOM: true });
const registries = sharedWeakMap<CodecRegistry, Registry>('registries');

class Registry implements CodecRegistry {
  readonly #overrides: ReadonlyMap<number, Decoder>;
  constructor(overrides: ReadonlyMap<number, Decoder> = new Map()) {
    this.#overrides = overrides;
    registries.set(this, this);
    Object.freeze(this);
  }
  with<T>(codec: Codec<T>): CodecRegistry {
    const snapshot = snapshotCodec(codec),
      next = new Map(this.#overrides);
    next.set(snapshot.oid, snapshot.text?.decode);
    return new Registry(next);
  }
  /** Custom decoder functions have erased return types; generation must not guess. */
  typescript(oid: number): string | undefined {
    if (!Number.isInteger(oid) || oid < 1 || oid > 0xffffffff)
      throw new DriverError('PGCLEAR_CONFIGURATION', 'Expected a PostgreSQL type OID.');
    if (this.#overrides.has(oid)) {
      const decode = this.#overrides.get(oid);
      return decode ? knownTypes.get(decode) : 'string';
    }
    const decode = scalars.get(oid);
    if (decode) return knownTypes.get(decode);
    const element = arrayElements.get(oid);
    if (element === undefined) return 'string';
    const type = this.typescript(element);
    return type === undefined ? undefined : `PgArray<${type}>`;
  }
  text(oid: number, value: string): unknown {
    const overridden = this.#overrides.has(oid);
    const selected = overridden ? this.#overrides.get(oid) : scalars.get(oid);
    const element = arrayElements.get(oid);
    if (overridden || element === undefined) {
      return synchronous(selected ? selected(value) : value);
    }
    return parseArray(value, (text) => this.text(element, text), oid === 1020 ? ';' : ',');
  }
  decode(value: Buffer | null, field: Field): unknown {
    if (value === null) return null;
    if (field.format !== 'text') throw new TypeError('Binary result negotiation is not enabled.');
    return this.text(field.dataTypeOid, utf8.decode(value));
  }
}
export const defaultCodecs: CodecRegistry = new Registry();
export function registry(value: CodecRegistry): Registry {
  const selected = registries.get(value);
  if (!selected)
    throw new DriverError(
      'PGCLEAR_CONFIGURATION',
      'Use defaultCodecs.with() to construct a codec registry.',
    );
  return selected;
}
export { builtin } from './builtin.js';
