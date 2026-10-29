import { userInfo } from 'node:os';
import { configurationError } from '../errors.js';
import { defaultCodecs, registry } from '../codecs/index.js';
import type { CloseOptions, ConnectionOptions, OperationOptions, TlsOptions } from '../types.js';

export interface Configuration {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
  readonly password: ConnectionOptions['password'];
  readonly tls: false | TlsOptions;
  readonly startup: Readonly<Record<string, string>>;
  readonly connectTimeoutMs: number;
  readonly maxQueuedOperations: number;
  readonly maxMessageBytes: number;
  readonly maxResultBytes: number;
  readonly onEvent: ConnectionOptions['onEvent'];
  readonly codecs: ReturnType<typeof registry>;
}

const optionNames = new Set([
  'connectionString',
  'host',
  'port',
  'user',
  'database',
  'password',
  'tls',
  'applicationName',
  'startupParameters',
  'connectTimeoutMs',
  'maxQueuedOperations',
  'maxMessageBytes',
  'maxResultBytes',
  'onEvent',
  'codecs',
]);
const uriNames = new Set([
  'host',
  'port',
  'user',
  'password',
  'dbname',
  'application_name',
  'sslmode',
]);

export function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    configurationError(`${label} must be a plain object.`);
  }
}
export function stringValue(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value) || value.includes('\0')) {
    configurationError(`${label} must be a ${allowEmpty ? '' : 'nonempty '}string without NUL.`);
  }
  return value;
}
export function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    configurationError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function uriConfiguration(input: unknown): ConnectionOptions {
  const source = stringValue(input, 'Connection URI');
  let uri: URL;
  try {
    uri = new URL(source);
  } catch {
    configurationError('Invalid PostgreSQL connection URI.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(uri.protocol) ||
    uri.hash ||
    uri.hostname.includes(',')
  ) {
    configurationError('Unsupported PostgreSQL connection URI.');
  }
  const query = uri.searchParams;
  for (const key of query.keys()) {
    if (!uriNames.has(key) || query.getAll(key).length !== 1)
      configurationError('Unsupported or duplicate URI option.');
  }
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      configurationError('Invalid URI encoding.');
    }
  };
  const mode = query.get('sslmode');
  if (mode !== null && !['disable', 'require', 'verify-full'].includes(mode))
    configurationError('Unsupported sslmode.');
  const port = query.get('port') ?? uri.port;
  if ((port || query.has('port')) && !/^\d+$/.test(port)) configurationError('Invalid URI port.');
  const host = query.has('host') ? query.get('host')! : decode(uri.hostname);
  const config: ConnectionOptions = {
    ...(host || query.has('host') ? { host: host.startsWith('[') ? host.slice(1, -1) : host } : {}),
    ...(port ? { port: Number(port) } : {}),
    ...(query.has('user') || uri.username
      ? { user: query.get('user') ?? decode(uri.username) }
      : {}),
    ...(query.has('password') || uri.password
      ? { password: query.get('password') ?? decode(uri.password) }
      : {}),
    ...(query.has('dbname') || uri.pathname.length > 1
      ? { database: query.get('dbname') ?? decode(uri.pathname.slice(1)) }
      : {}),
    ...(query.has('application_name') ? { applicationName: query.get('application_name')! } : {}),
    ...(mode !== null ? { tls: mode === 'disable' ? false : {} } : {}),
  };
  return config;
}

export function normalizeConfiguration(input: string | ConnectionOptions): Configuration {
  let explicit: ConnectionOptions;
  if (typeof input === 'string') explicit = { connectionString: input };
  else {
    record(input, 'Connection options');
    explicit = input;
  }
  for (const name of Object.keys(explicit)) {
    if (!optionNames.has(name)) configurationError('Unknown connection option.');
  }
  // Undefined optional properties do not erase a URI value supplied at runtime.
  const defined = Object.fromEntries(Object.entries(explicit).filter(([, v]) => v !== undefined));
  if (Object.values(defined).some((value) => value === null))
    configurationError('Connection options cannot be null.');
  const options: ConnectionOptions = {
    ...(explicit.connectionString !== undefined ? uriConfiguration(explicit.connectionString) : {}),
    ...defined,
  };
  const user = stringValue(options.user ?? userInfo().username, 'User');
  const host = stringValue(options.host ?? 'localhost', 'Host');
  const database = stringValue(options.database ?? user, 'Database');
  const port = integer(options.port ?? 5432, 'Port', 1, 65535);
  const password = options.password;
  if (password !== undefined && typeof password !== 'function')
    stringValue(password, 'Password', true);
  let tls: false | TlsOptions = options.tls ?? false;
  if (tls !== false) {
    record(tls, 'TLS options');
    for (const key of Object.keys(tls)) {
      if (!['ca', 'cert', 'key', 'serverName', 'channelBinding'].includes(key))
        configurationError('Unknown TLS option.');
    }
    if (tls.ca !== undefined) {
      const authorities = typeof tls.ca === 'string' ? [tls.ca] : tls.ca;
      if (!Array.isArray(authorities) || !authorities.length)
        configurationError('TLS ca must contain certificates.');
      authorities.forEach((value) => stringValue(value, 'TLS CA'));
    }
    for (const key of ['cert', 'key', 'serverName'] as const)
      if (tls[key] !== undefined) stringValue(tls[key], 'TLS option');
    if (Boolean(tls.cert) !== Boolean(tls.key))
      configurationError('TLS cert and key must be supplied together.');
    if (
      tls.channelBinding !== undefined &&
      (typeof tls.channelBinding !== 'string' ||
        !['prefer', 'require', 'disable'].includes(tls.channelBinding))
    )
      configurationError('Invalid channel binding option.');
    if (host.startsWith('/') && !tls.serverName)
      configurationError('TLS over a Unix socket requires serverName.');
    tls = Object.freeze({
      ...tls,
      ...(Array.isArray(tls.ca) ? { ca: Object.freeze([...tls.ca]) } : {}),
    });
  }
  const startup: Record<string, string> = {
    user,
    database,
    client_encoding: 'UTF8',
    DateStyle: 'ISO',
    IntervalStyle: 'iso_8601',
    TimeZone: 'UTC',
  };
  if (options.startupParameters !== undefined) {
    record(options.startupParameters, 'Startup parameters');
    const fixed = new Set([
      'user',
      'database',
      'replication',
      'options',
      'protocol',
      'client_encoding',
      'datestyle',
      'intervalstyle',
      'timezone',
      'application_name',
    ]);
    for (const [key, value] of Object.entries(options.startupParameters)) {
      if (
        !/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(key) ||
        fixed.has(key.toLowerCase()) ||
        key.startsWith('_pq_.')
      )
        configurationError('Reserved or invalid startup parameter.');
      Object.defineProperty(startup, key, {
        value: stringValue(value, 'Startup parameter', true),
        enumerable: true,
      });
    }
  }
  if (options.applicationName !== undefined)
    startup.application_name = stringValue(options.applicationName, 'Application name', true);
  if (options.onEvent !== undefined && typeof options.onEvent !== 'function')
    configurationError('onEvent must be a function.');
  return Object.freeze({
    host,
    port,
    user,
    database,
    password,
    tls,
    startup: Object.freeze(startup),
    connectTimeoutMs: integer(options.connectTimeoutMs ?? 5000, 'connectTimeoutMs', 0),
    maxQueuedOperations: integer(options.maxQueuedOperations ?? 1000, 'maxQueuedOperations', 1),
    maxMessageBytes: integer(
      options.maxMessageBytes ?? 64 * 1024 * 1024,
      'maxMessageBytes',
      4,
      0xffffffff,
    ),
    maxResultBytes: integer(options.maxResultBytes ?? 64 * 1024 * 1024, 'maxResultBytes', 1),
    onEvent: options.onEvent,
    codecs: registry(options.codecs ?? defaultCodecs),
  });
}

export function validateOperation(options: OperationOptions, extra: readonly string[] = []): void {
  record(options, 'Operation options');
  for (const name of Object.keys(options))
    if (!['signal', 'timeoutMs', ...extra].includes(name))
      configurationError('Unknown operation option.');
  if (options.timeoutMs !== undefined) integer(options.timeoutMs, 'timeoutMs', 0);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    configurationError('signal must be an AbortSignal.');
  if (
    'rowMode' in options &&
    options.rowMode !== undefined &&
    options.rowMode !== 'object' &&
    options.rowMode !== 'array'
  )
    configurationError('Invalid row mode.');
  if ('codecs' in options && options.codecs !== undefined)
    registry(options.codecs as import('../types.js').CodecRegistry);
}

/** Close validates before any permanent handle or pool fence is set. */
export function validateClose(options: CloseOptions): void {
  validateOperation(options);
  if ('signal' in options) configurationError('Close accepts only timeoutMs.');
}
