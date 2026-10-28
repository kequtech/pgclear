import { Socket, isIP } from 'node:net';
import { connect as connectTls, checkServerIdentity, type TLSSocket } from 'node:tls';
import { certificateBinding } from '../auth/channel-binding.js';
import type { Configuration } from '../config/index.js';
import { DriverError, protocolError } from '../errors.js';
import { sslRequest } from '../protocol/framing.js';

interface TransportObserver {
  ready(binding?: () => Buffer): void;
  data(chunk: Buffer): void;
  error(error: Error): void;
  closed(): void;
}

/** Owns TCP/Unix/TLS negotiation and socket disposal, independently of request/protocol state. */
export class Transport {
  readonly #raw = new Socket();
  #socket: Socket | TLSSocket = this.#raw;
  #negotiating = false;
  #destroyed = false;
  #reportedClose = false;

  constructor(
    private readonly config: Configuration,
    private readonly observer: TransportObserver,
  ) {
    this.#raw.on('error', this.#error);
    this.#raw.once('close', this.#closed);
  }

  open(): void {
    this.#raw.on('data', this.#data);
    this.#raw.once('connect', () => {
      if (this.#destroyed) return;
      this.#raw.setNoDelay(true);
      if (this.config.tls !== false) {
        this.#negotiating = true;
        this.write(sslRequest);
      } else this.observer.ready();
    });
    try {
      if (this.config.host.startsWith('/'))
        this.#raw.connect(`${this.config.host}/.s.PGSQL.${this.config.port}`);
      else this.#raw.connect(this.config.port, this.config.host);
    } catch (error) {
      this.#error(error);
    }
  }

  pause(): void {
    this.#socket.pause();
  }
  resume(): void {
    if (!this.#destroyed) this.#socket.resume();
  }
  write(bytes: Buffer): void {
    if (this.#destroyed) return;
    // Control requests are bounded by the sequential scheduler; COPY payloads use send() below.
    try {
      this.#socket.write(bytes);
    } catch (error) {
      this.#error(error);
    }
  }
  /** A single outstanding COPY write bounds buffering even when the socket is backpressured. */
  send(bytes: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.#destroyed) {
        reject(new DriverError('PGCLEAR_CLOSED', 'Transport is closed.'));
        return;
      }
      const socket = this.#socket;
      const closed = () =>
        finish(new DriverError('PGCLEAR_CONNECTION_LOST', 'Transport closed during COPY write.'));
      const finish = (error?: Error | null) => {
        socket.removeListener('close', closed);
        if (error) {
          this.#error(error);
          reject(error);
        } else resolve();
      };
      socket.once('close', closed);
      try {
        socket.write(bytes, finish);
      } catch (cause) {
        finish(cause instanceof Error ? cause : protocolError());
      }
    });
  }
  end(bytes: Buffer): void {
    if (this.#destroyed) return;
    try {
      this.#socket.end(bytes);
    } catch (error) {
      this.#error(error);
    }
  }
  destroy(): void {
    this.#destroyed = true;
    this.#socket.destroy();
    this.#raw.destroy();
  }

  #closed = (): void => {
    if (this.#reportedClose) return;
    this.#reportedClose = true;
    this.observer.closed();
  };
  #error = (cause: unknown): void => {
    if (!this.#destroyed)
      this.observer.error(
        new DriverError('PGCLEAR_CONNECTION_LOST', 'PostgreSQL transport failed.', 'not-sent', {
          cause,
        }),
      );
  };
  #data = (chunk: Buffer): void => {
    if (this.#destroyed) return;
    if (!this.#negotiating) {
      this.observer.data(chunk);
      return;
    }
    this.#negotiating = false;
    // Extra bytes before the TLS handshake are a protocol error (SSL buffer stuffing).
    if (chunk.length !== 1 || chunk[0] !== 83) {
      this.observer.error(protocolError('Server refused TLS or sent an invalid SSL response.'));
      return;
    }
    this.#upgradeTls();
  };

  #upgradeTls(): void {
    const tls = this.config.tls;
    if (tls === false || this.#destroyed) return;
    this.#raw.removeListener('data', this.#data);
    const host = tls.serverName ?? this.config.host;
    try {
      const secure = connectTls({
        socket: this.#raw,
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        ...(isIP(host) ? {} : { servername: host }),
        ...(tls.ca !== undefined ? { ca: typeof tls.ca === 'string' ? tls.ca : [...tls.ca] } : {}),
        ...(tls.cert !== undefined ? { cert: tls.cert } : {}),
        ...(tls.key !== undefined ? { key: tls.key } : {}),
        checkServerIdentity: (_name, certificate) => checkServerIdentity(host, certificate),
      });
      this.#socket = secure;
      secure.on('error', this.#error);
      secure.once('close', this.#closed);
      secure.on('data', this.#data);
      secure.once('secureConnect', () => {
        if (this.#destroyed) {
          secure.destroy();
          return;
        }
        const identityError = checkServerIdentity(host, secure.getPeerCertificate());
        if (identityError) {
          this.#error(identityError);
          return;
        }
        try {
          this.observer.ready(
            tls.channelBinding === 'disable'
              ? undefined
              : () => certificateBinding(secure.getPeerCertificate().raw),
          );
        } catch (error) {
          this.observer.error(error instanceof Error ? error : protocolError());
        }
      });
    } catch (error) {
      this.#error(error);
    }
  }
}
