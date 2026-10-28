import type { Outcome } from './types.js';

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
  override readonly name = 'DriverError';
  constructor(
    readonly code: DriverErrorCode,
    message: string,
    readonly outcome: Outcome = 'not-sent',
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class DatabaseError extends Error {
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
