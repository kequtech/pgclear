import { createHash } from 'node:crypto';
import type { Configuration } from '../config/index.js';
import type { Authentication } from '../protocol/messages.js';
import { cstring, frame, int32 } from '../protocol/framing.js';
import { authenticationError, ScramClient } from './scram.js';

export class Authenticator {
  #state: 'initial' | 'password' | 'sasl' | 'final' | 'ok' = 'initial';
  #scram: ScramClient | undefined;
  #password: string | undefined;

  constructor(
    private readonly config: Configuration,
    private readonly binding: Buffer | (() => Buffer) | undefined,
  ) {}
  get complete(): boolean {
    return this.#state === 'ok';
  }

  async #getPassword(): Promise<string> {
    if (this.#password !== undefined) return this.#password;
    const password =
      typeof this.config.password === 'function'
        ? await this.config.password(
            Object.freeze({
              host: this.config.host,
              port: this.config.port,
              user: this.config.user,
              database: this.config.database,
            }),
          )
        : this.config.password;
    if (typeof password !== 'string' || !password || password.includes('\0'))
      throw authenticationError();
    this.#password = password;
    return password;
  }

  async receive(message: Authentication): Promise<Buffer | undefined> {
    const policy =
      this.config.tls === false ? 'disable' : (this.config.tls.channelBinding ?? 'prefer');
    if (message.method === 'ok') {
      if (
        this.complete ||
        this.#state === 'sasl' ||
        (this.#state === 'final' && !this.#scram?.verified) ||
        (policy === 'require' && this.#scram?.mechanism !== 'SCRAM-SHA-256-PLUS')
      )
        throw authenticationError();
      this.#state = 'ok';
      this.#password = undefined;
      this.#scram = undefined;
      return;
    }
    if (this.#state === 'initial') {
      if (message.method === 'password' || message.method === 'md5') {
        if (
          policy === 'require' ||
          (message.method === 'password' &&
            this.config.tls === false &&
            !this.config.host.startsWith('/'))
        )
          throw authenticationError();
        this.#state = 'password';
        const password = await this.#getPassword();
        if (message.method === 'password') return frame('p', cstring(password));
        const first = createHash('md5')
          .update(password + this.config.user)
          .digest('hex');
        const response = 'md5' + createHash('md5').update(first).update(message.salt).digest('hex');
        return frame('p', cstring(response));
      }
      if (message.method === 'sasl') {
        this.#state = 'sasl';
        const binding =
          policy === 'disable'
            ? undefined
            : typeof this.binding === 'function'
              ? message.mechanisms.includes('SCRAM-SHA-256-PLUS')
                ? this.binding()
                : Buffer.alloc(0)
              : this.binding;
        this.#scram = new ScramClient(message.mechanisms, policy, binding);
        const initial = Buffer.from(this.#scram.initial);
        return frame('p', cstring(this.#scram.mechanism), int32(initial.length), initial);
      }
    }
    if (message.method === 'continue' && this.#state === 'sasl') {
      this.#state = 'final';
      return frame(
        'p',
        Buffer.from(await this.#scram!.continue(message.data, await this.#getPassword())),
      );
    }
    if (message.method === 'final' && this.#state === 'final' && !this.#scram!.verified) {
      this.#scram!.finish(message.data);
      return;
    }
    throw authenticationError();
  }
}
