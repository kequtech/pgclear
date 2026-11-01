import { builtin, param, type Codec, type Parameter, type PgArray } from '../../src/index.js';

export function uuidArrayParameters(): readonly Parameter[] {
  const codec: Codec<PgArray<string>> = builtin.uuidArray;
  const values = [param(['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', null], codec)];
  param([], codec);
  param(null, codec);
  param([['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11']], codec);
  // @ts-expect-error UUID array elements must be strings or null.
  param([1], codec);
  // @ts-expect-error Undefined is not a UUID array element.
  param([undefined], codec);
  return values;
}
