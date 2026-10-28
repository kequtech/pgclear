import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import saslprep from '@mongodb-js/saslprep';
import { DriverError } from '../errors.js';

const derive = promisify(pbkdf2);
export const maxScramIterations = 100_000;
export function authenticationError(): DriverError {
  return new DriverError(
    'PGCLEAR_AUTHENTICATION',
    'PostgreSQL authentication failed or is unsupported.',
  );
}

/** PostgreSQL falls back to the original password if SASLprep rejects it. */
export function preparePassword(password: string): string {
  try {
    return saslprep(password);
  } catch {
    return password;
  }
}

function attributes(message: string): Map<string, string> {
  if (!message || message.length > 65536) throw authenticationError();
  const result = new Map<string, string>();
  for (const pair of message.split(',')) {
    if (!/^[A-Za-z]=[\x21-\x2b\x2d-\x7e]+$/.test(pair)) throw authenticationError();
    const key = pair[0]!;
    if (key === 'm' || result.has(key)) throw authenticationError();
    result.set(key, pair.slice(2));
  }
  return result;
}
function base64(text: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text) || !text)
    throw authenticationError();
  const decoded = Buffer.from(text, 'base64');
  if (decoded.toString('base64') !== text) throw authenticationError();
  return decoded;
}
function hmac(key: Uint8Array, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export class ScramClient {
  readonly mechanism: 'SCRAM-SHA-256' | 'SCRAM-SHA-256-PLUS';
  readonly initial: string;
  #state: 'first' | 'deriving' | 'final' | 'verified' = 'first';
  #serverSignature: Buffer | undefined;
  #header: string;
  #bare: string;

  constructor(
    mechanisms: readonly string[],
    policy: 'prefer' | 'require' | 'disable',
    private readonly binding: Buffer | undefined,
    private readonly nonce = randomBytes(18).toString('base64'),
    username = '',
  ) {
    const plus =
      binding !== undefined && policy !== 'disable' && mechanisms.includes('SCRAM-SHA-256-PLUS');
    if ((policy === 'require' && !plus) || (!plus && !mechanisms.includes('SCRAM-SHA-256')))
      throw authenticationError();
    this.mechanism = plus ? 'SCRAM-SHA-256-PLUS' : 'SCRAM-SHA-256';
    this.#header = plus
      ? 'p=tls-server-end-point,,'
      : binding && policy !== 'disable'
        ? 'y,,'
        : 'n,,';
    this.#bare = `n=${username.replaceAll('=', '=3D').replaceAll(',', '=2C')},r=${nonce}`;
    this.initial = this.#header + this.#bare;
  }

  async continue(message: string, password: string): Promise<string> {
    if (this.#state !== 'first') throw authenticationError();
    this.#state = 'deriving';
    const values = attributes(message),
      nonce = values.get('r') ?? '',
      iterations = values.get('i') ?? '';
    if (
      !nonce.startsWith(this.nonce) ||
      nonce.length <= this.nonce.length ||
      !/^[1-9][0-9]*$/.test(iterations) ||
      Number(iterations) > maxScramIterations
    )
      throw authenticationError();
    const salt = base64(values.get('s') ?? '');
    const salted = await derive(preparePassword(password), salt, Number(iterations), 32, 'sha256');
    const binding = Buffer.concat([
      Buffer.from(this.#header),
      ...(this.mechanism === 'SCRAM-SHA-256-PLUS' ? [this.binding!] : []),
    ]);
    const final = `c=${binding.toString('base64')},r=${nonce}`;
    const auth = `${this.#bare},${message},${final}`;
    const clientKey = hmac(salted, 'Client Key');
    const signature = hmac(createHash('sha256').update(clientKey).digest(), auth);
    const proof = Buffer.from(clientKey.map((byte, index) => byte ^ signature[index]!));
    this.#serverSignature = hmac(hmac(salted, 'Server Key'), auth);
    this.#state = 'final';
    return `${final},p=${proof.toString('base64')}`;
  }

  finish(message: string): void {
    if (this.#state !== 'final') throw authenticationError();
    const values = attributes(message);
    if (values.has('e') || !values.has('v')) throw authenticationError();
    const signature = base64(values.get('v')!);
    if (signature.length !== 32 || !timingSafeEqual(signature, this.#serverSignature!))
      throw authenticationError();
    this.#serverSignature = undefined;
    this.#state = 'verified';
  }

  get verified(): boolean {
    return this.#state === 'verified';
  }
}
