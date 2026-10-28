import { DriverError } from './errors.js';
import type { InputValue, Row, SqlQuery } from './types.js';

/** Bind every interpolation; no interpolation can introduce SQL structure. */
export function sql<T extends object = Row>(
  strings: TemplateStringsArray,
  ...values: readonly InputValue[]
): NoInfer<SqlQuery<T>> {
  if (
    !Array.isArray(strings) ||
    !Array.isArray(strings.raw) ||
    strings.length !== values.length + 1 ||
    Array.from(strings).some((part) => typeof part !== 'string')
  )
    throw new DriverError('PGCLEAR_ENCODE', 'sql must be used as a valid template tag.');
  if (values.length > 65535) throw new DriverError('PGCLEAR_ENCODE', 'Invalid parameter count.');
  let text = strings[0]!;
  for (let index = 0; index < values.length; index++)
    text += '$' + (index + 1) + strings[index + 1]!;
  return Object.freeze([text, Object.freeze(values)]) as SqlQuery<T>;
}
