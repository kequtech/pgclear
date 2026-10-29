import type { Codec, PgArray } from '../types.js';
import { encodeArray, parseArray } from './arrays.js';

export function synchronous<T>(value: T): T {
  if (
    value &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  ) {
    void Promise.resolve(value).catch(() => {});
    throw new TypeError('Codec functions must be synchronous.');
  }
  return value;
}

export function textValue(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed())
    throw new TypeError('Expected valid text without NUL.');
  return value;
}
function textCodec(oid: number): Codec<string> {
  return Object.freeze({ oid, text: Object.freeze({ encode: textValue, decode: textValue }) });
}
function integerCodec(oid: number, minimum: number, maximum: number): Codec<number> {
  const check = (value: number): number => {
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw new TypeError('Integer out of range.');
    return value;
  };
  return Object.freeze({
    oid,
    text: Object.freeze({
      encode: (value: number) => String(check(value)),
      decode: (value: string) => {
        if (!/^-?\d+$/.test(value)) throw new TypeError('Invalid integer.');
        return check(Number(value));
      },
    }),
  });
}
function floatCodec(oid: number): Codec<number> {
  return Object.freeze({
    oid,
    text: Object.freeze({
      encode: (value: number) => {
        if (typeof value !== 'number') throw new TypeError('Expected a number.');
        return String(value);
      },
      decode: (value: string) => {
        if (value === 'NaN') return NaN;
        if (value === 'Infinity') return Infinity;
        if (value === '-Infinity') return -Infinity;
        if (
          !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ||
          !Number.isFinite(Number(value))
        )
          throw new TypeError('Invalid float.');
        return Number(value);
      },
    }),
  });
}
function int8(value: bigint): bigint {
  if (typeof value !== 'bigint' || value < -9223372036854775808n || value > 9223372036854775807n)
    throw new TypeError('Invalid int8.');
  return value;
}
function numeric(value: string): string {
  textValue(value);
  if (!/^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|NaN|[+-]?Infinity)$/.test(value))
    throw new TypeError('Invalid numeric text.');
  return value;
}
export function stringifyJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('Value does not encode a JSON document.');
  return text;
}
function jsonCodec(oid: number): Codec<unknown> {
  return Object.freeze({
    oid,
    text: Object.freeze({
      encode: stringifyJson,
      decode: (value: string): unknown => JSON.parse(value),
    }),
  });
}
function bytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError('Expected Uint8Array.');
  return new Uint8Array(value);
}
function decodeBytea(value: string): Uint8Array {
  if (value.startsWith('\\x')) {
    if (!/^\\x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new TypeError('Invalid bytea hex.');
    return new Uint8Array(Buffer.from(value.slice(2), 'hex'));
  }
  const result: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\\') {
      const code = value.charCodeAt(i);
      if (code > 127) throw new TypeError('Invalid escaped bytea.');
      result.push(code);
    } else if (value[i + 1] === '\\') {
      result.push(92);
      i++;
    } else {
      const octal = value.slice(i + 1, i + 4);
      if (!/^[0-3][0-7]{2}$/.test(octal)) throw new TypeError('Invalid escaped bytea.');
      result.push(parseInt(octal, 8));
      i += 3;
    }
  }
  return new Uint8Array(result);
}
function arrayCodec<T>(oid: number, element: Codec<T>): Codec<PgArray<T>> {
  return Object.freeze({
    oid,
    text: Object.freeze({
      encode: (value: PgArray<T>) => encodeArray(value, element.text!.encode),
      // Explicit array overrides choose their own element decoder; registry-derived defaults use
      // the active scalar decoder instead.
      decode: (value: string) => parseArray(value, element.text!.decode) as PgArray<T>,
    }),
  });
}

const bool: Codec<boolean> = Object.freeze({
  oid: 16,
  text: Object.freeze({
    encode: (value: boolean) => {
      if (typeof value !== 'boolean') throw new TypeError('Expected boolean.');
      return value ? 't' : 'f';
    },
    decode: (value: string) => {
      if (value !== 't' && value !== 'f') throw new TypeError('Invalid boolean.');
      return value === 't';
    },
  }),
});
const int2 = integerCodec(21, -32768, 32767),
  int4 = integerCodec(23, -2147483648, 2147483647);
const big: Codec<bigint> = Object.freeze({
  oid: 20,
  text: Object.freeze({
    encode: (value: bigint) => String(int8(value)),
    decode: (value: string) => {
      if (!/^-?\d+$/.test(value)) throw new TypeError('Invalid int8.');
      return int8(BigInt(value));
    },
  }),
});
const decimal: Codec<string> = Object.freeze({
  oid: 1700,
  text: Object.freeze({ encode: numeric, decode: numeric }),
});
const text = textCodec(25);
export const builtin = Object.freeze({
  bool,
  int2,
  int4,
  int8: big,
  float4: floatCodec(700),
  float8: floatCodec(701),
  numeric: decimal,
  text,
  uuid: textCodec(2950),
  bytea: Object.freeze({
    oid: 17,
    text: Object.freeze({
      encode: (value: Uint8Array) => '\\x' + Buffer.from(bytes(value)).toString('hex'),
      decode: decodeBytea,
    }),
    binary: Object.freeze({ encode: bytes, decode: bytes }),
  }) satisfies Codec<Uint8Array>,
  json: jsonCodec(114),
  jsonb: jsonCodec(3802),
  jsonText: textCodec(114),
  jsonbText: textCodec(3802),
  date: textCodec(1082),
  timestamp: textCodec(1114),
  timestamptz: textCodec(1184),
  int4Array: arrayCodec(1007, int4),
  int8Array: arrayCodec(1016, big),
  numericArray: arrayCodec(1231, decimal),
  textArray: arrayCodec(1009, text),
});
export const oidCodec = integerCodec(26, 0, 4294967295);
