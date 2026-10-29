import type { Codec, TemporalInput } from '../types.js';
import { DriverError } from '../errors.js';
import { textValue } from './builtin.js';
import { dateText, isoTemporal, postgresTemporal } from './temporal-values.js';

const tags = new Set([
  'Temporal.PlainDate',
  'Temporal.PlainTime',
  'Temporal.PlainDateTime',
  'Temporal.Instant',
  'Temporal.ZonedDateTime',
  'Temporal.Duration',
]);

export function temporalText(value: Date): string;
export function temporalText(value: unknown): string | undefined;
export function temporalText(value: unknown): string | undefined {
  if (value instanceof Date) return dateText(value);
  if (!value || typeof value !== 'object') return undefined;
  const temporal = value as {
    [Symbol.toStringTag]?: unknown;
    toString?: unknown;
    toInstant?: unknown;
  };
  const tag = temporal[Symbol.toStringTag];
  if (typeof tag !== 'string' || !tags.has(tag)) return undefined;
  if (tag === 'Temporal.ZonedDateTime') {
    if (typeof temporal.toInstant !== 'function') throw new TypeError('Invalid Temporal value.');
    return temporalText(Reflect.apply(temporal.toInstant, value, []));
  }
  if (typeof temporal.toString !== 'function') throw new TypeError('Invalid Temporal value.');
  const text: unknown = Reflect.apply(temporal.toString, value, [{ calendarName: 'never' }]);
  const encoded = textValue(text);
  // PostgreSQL ISO intervals put negative signs on components, not before the P marker.
  if (tag === 'Temporal.Duration' && encoded.startsWith('-P'))
    return encoded.slice(1).replace(/(\d+(?:\.\d+)?)([YMWDHS])/g, '-$1$2');
  return postgresTemporal(encoded);
}

/** Pass native Temporal or a compatible polyfill; no global or runtime dependency is installed. */
export interface TemporalConstructors<
  D extends TemporalInput = TemporalInput,
  DT extends TemporalInput = TemporalInput,
  I extends TemporalInput = TemporalInput,
  T extends TemporalInput = TemporalInput,
> {
  readonly PlainDate: { from(value: string): D };
  readonly PlainDateTime: { from(value: string): DT };
  readonly Instant: { from(value: string): I };
  readonly PlainTime: { from(value: string): T };
}

export function createTemporalCodecs<
  D extends TemporalInput,
  DT extends TemporalInput,
  I extends TemporalInput,
  T extends TemporalInput,
>(
  temporal: TemporalConstructors<D, DT, I, T>,
  options: { readonly typescriptNamespace?: string } = {},
): Readonly<{ date: Codec<D>; timestamp: Codec<DT>; timestamptz: Codec<I>; time: Codec<T> }> {
  if (
    !options ||
    typeof options !== 'object' ||
    Object.keys(options).some((key) => key !== 'typescriptNamespace')
  )
    throw new DriverError('PGCLEAR_CONFIGURATION', 'Invalid Temporal codec options.');
  const namespace = options.typescriptNamespace ?? 'Temporal';
  if (
    typeof namespace !== 'string' ||
    !namespace.trim() ||
    namespace.includes('\0') ||
    !namespace.isWellFormed()
  )
    throw new DriverError('PGCLEAR_CONFIGURATION', 'Expected a TypeScript Temporal namespace.');
  function codec<V extends TemporalInput>(
    oid: number,
    kind: keyof TemporalConstructors,
    factory: { from(value: string): V },
  ): Codec<V> {
    if (!factory || typeof factory.from !== 'function')
      throw new DriverError('PGCLEAR_CONFIGURATION', 'Expected Temporal constructors.');
    return Object.freeze({
      oid,
      text: Object.freeze({
        encode: (value: V) => {
          if (value?.[Symbol.toStringTag] !== 'Temporal.' + kind)
            throw new TypeError('Unexpected Temporal value for codec.');
          return temporalText(value)!;
        },
        decode: (value: string) => factory.from(isoTemporal(value)),
        typescript: namespace + '.' + kind,
      }),
    });
  }
  if (!temporal || typeof temporal !== 'object')
    throw new DriverError('PGCLEAR_CONFIGURATION', 'Expected Temporal constructors.');
  return Object.freeze({
    date: codec(1082, 'PlainDate', temporal.PlainDate),
    timestamp: codec(1114, 'PlainDateTime', temporal.PlainDateTime),
    timestamptz: codec(1184, 'Instant', temporal.Instant),
    time: codec(1083, 'PlainTime', temporal.PlainTime),
  });
}
