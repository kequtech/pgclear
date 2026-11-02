import type { Oid, Outcome } from './types.js';
import { sharedWeakMap } from './identity.js';

const driverErrors = sharedWeakMap<object, true>('driver-errors');
const databaseErrors = sharedWeakMap<object, true>('database-errors');

export type DriverErrorCode =
  | 'PGCLEAR_CONFIGURATION'
  | 'PGCLEAR_AUTHENTICATION'
  | 'PGCLEAR_CONNECTION_LOST'
  | 'PGCLEAR_CLOSED'
  | 'PGCLEAR_QUEUE_FULL'
  | 'PGCLEAR_TIMEOUT'
  | 'PGCLEAR_ABORTED'
  | 'PGCLEAR_COPY_SOURCE'
  | 'PGCLEAR_ENCODE'
  | 'PGCLEAR_DECODE'
  | 'PGCLEAR_PROTOCOL'
  | 'PGCLEAR_RESULT_LIMIT'
  | 'PGCLEAR_COMMIT_UNKNOWN'
  | 'PGCLEAR_EXPIRED'
  | 'PGCLEAR_BUSY'
  | 'PGCLEAR_SESSION_STATE'
  | 'PGCLEAR_TRANSACTION_STATE';

export class DriverError extends Error {
  readonly column?: string;
  readonly dataTypeOid?: Oid;
  static [Symbol.hasInstance](value: unknown): boolean {
    return this === DriverError
      ? driverErrors.has(value as object)
      : Function.prototype[Symbol.hasInstance].call(this, value);
  }
  override readonly name = 'DriverError';
  constructor(
    readonly code: DriverErrorCode,
    message: string,
    readonly outcome: Outcome = 'not-sent',
    options?: ErrorOptions & {
      readonly column?: string | undefined;
      readonly dataTypeOid?: Oid | undefined;
    },
  ) {
    super(message, options);
    if (options?.column !== undefined) this.column = options.column;
    if (options?.dataTypeOid !== undefined) this.dataTypeOid = options.dataTypeOid;
    driverErrors.set(this, true);
  }
}

/** Original driver errors, in root/cause/aggregate order, without invoking application getters. */
export function findDriverErrors(error: unknown): readonly DriverError[] {
  const found: DriverError[] = [];
  const seen = new Set<object>();
  const pending: unknown[] = [error];
  while (pending.length) {
    const current = pending.pop();
    if ((typeof current !== 'object' || current === null) && typeof current !== 'function')
      continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (current instanceof DriverError) found.push(current);
    // Error.cause and AggregateError.errors are data properties. Accessors are not evidence.
    const cause = Object.getOwnPropertyDescriptor(current, 'cause');
    const errors = Object.getOwnPropertyDescriptor(current, 'errors');
    if (
      current instanceof AggregateError &&
      errors &&
      'value' in errors &&
      Array.isArray(errors.value)
    )
      for (let index = errors.value.length - 1; index >= 0; index--) {
        const member = Object.getOwnPropertyDescriptor(errors.value, String(index));
        if (member && 'value' in member) pending.push(member.value);
      }
    if (cause && 'value' in cause) pending.push(cause.value);
  }
  return found;
}

export class DatabaseError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return this === DatabaseError
      ? databaseErrors.has(value as object)
      : Function.prototype[Symbol.hasInstance].call(this, value);
  }
  override readonly name = 'DatabaseError';
  readonly code: string;
  readonly severity: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly position?: number;
  readonly schema?: string;
  readonly table?: string;
  readonly column?: string;
  readonly dataType?: string;
  readonly constraint?: string;
  readonly routine?: string;

  constructor(fields: ReadonlyMap<string, string>) {
    super(fields.get('M') ?? 'PostgreSQL error');
    databaseErrors.set(this, true);
    this.code = fields.get('C') ?? 'XX000';
    this.severity = fields.get('V') ?? fields.get('S') ?? 'ERROR';
    const attributes = {
      detail: fields.get('D'),
      hint: fields.get('H'),
      schema: fields.get('s'),
      table: fields.get('t'),
      column: fields.get('c'),
      dataType: fields.get('d'),
      constraint: fields.get('n'),
      routine: fields.get('R'),
    };
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) Object.defineProperty(this, key, { value, enumerable: true });
    }
    const position = fields.get('P');
    if (position && /^[1-9]\d*$/.test(position) && Number.isSafeInteger(Number(position))) {
      this.position = Number(position);
    }
  }
}

export function protocolError(message = 'Invalid PostgreSQL protocol message.'): DriverError {
  return new DriverError('PGCLEAR_PROTOCOL', message);
}

export function configurationError(message: string): never {
  throw new DriverError('PGCLEAR_CONFIGURATION', message);
}
