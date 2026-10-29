import { DriverError } from './errors.js';
import type { InputValue, Row, SqlQuery } from './types.js';
import { sharedWeakMap } from './identity.js';

const queries = sharedWeakMap<SqlQuery<object>, true>('queries');

export function taggedQuery(query: SqlQuery<object>): SqlQuery<object> {
  if (!queries.has(query))
    throw new DriverError(
      'PGCLEAR_ENCODE',
      'query() requires a sql tag result; use queryClassic() for SQL text and values.',
    );
  return query;
}

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
  const query = Object.freeze([text, Object.freeze(values)]) as SqlQuery<T>;
  queries.set(query, true);
  return query;
}
