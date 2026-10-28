import { DatabaseError, DriverError, protocolError } from '../errors.js';
import type { Field, TransactionStatus } from '../types.js';
import type { Frame } from './framing.js';

// Each protocol string must retain a leading U+FEFF as part of its value/name.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export class Reader {
  #offset = 0;
  constructor(private readonly data: Buffer) {}
  #take(size: number): number {
    if (size < 0 || size > this.data.length - this.#offset)
      throw protocolError('Truncated protocol field.');
    const start = this.#offset;
    this.#offset += size;
    return start;
  }
  byte(): number {
    return this.data[this.#take(1)]!;
  }
  int16(): number {
    return this.data.readInt16BE(this.#take(2));
  }
  uint16(): number {
    return this.data.readUInt16BE(this.#take(2));
  }
  int32(): number {
    return this.data.readInt32BE(this.#take(4));
  }
  uint32(): number {
    return this.data.readUInt32BE(this.#take(4));
  }
  bytes(size: number): Buffer {
    const start = this.#take(size);
    return this.data.subarray(start, start + size);
  }
  text(size: number): string {
    try {
      return utf8.decode(this.bytes(size));
    } catch {
      throw protocolError('Invalid UTF8 protocol string.');
    }
  }
  cstring(): string {
    const end = this.data.indexOf(0, this.#offset);
    if (end === -1) throw protocolError('Unterminated protocol string.');
    const value = this.text(end - this.#offset);
    this.#offset++;
    return value;
  }
  get remaining(): number {
    return this.data.length - this.#offset;
  }
  end(): void {
    if (this.remaining !== 0) throw protocolError('Unexpected trailing protocol data.');
  }
}

export type Authentication =
  | { readonly method: 'ok' }
  | { readonly method: 'password' }
  | { readonly method: 'md5'; readonly salt: Buffer }
  | { readonly method: 'sasl'; readonly mechanisms: readonly string[] }
  | { readonly method: 'continue' | 'final'; readonly data: string };

export type Message =
  | { readonly type: 'authentication'; readonly authentication: Authentication }
  | { readonly type: 'parameter'; readonly name: string; readonly value: string }
  | { readonly type: 'key'; readonly pid: number; readonly secret: number }
  | { readonly type: 'ready'; readonly status: TransactionStatus }
  | { readonly type: 'error' | 'notice'; readonly error: DatabaseError }
  | { readonly type: 'fields'; readonly fields: readonly Field[] }
  | { readonly type: 'parameters'; readonly oids: readonly number[] }
  | { readonly type: 'row'; readonly values: readonly (Buffer | null)[] }
  | { readonly type: 'command'; readonly tag: string }
  | {
      readonly type: 'copy-in' | 'copy-out';
      readonly format: number;
      readonly columns: readonly number[];
    }
  | { readonly type: 'copy-data'; readonly bytes: Buffer }
  | { readonly type: 'copy-done' }
  | { readonly type: 'parse' | 'bind' | 'no-data' | 'empty' | 'close' | 'suspended' }
  | {
      readonly type: 'notification';
      readonly pid: number;
      readonly channel: string;
      readonly payload: string;
    };

function authentication(reader: Reader): Authentication {
  if (reader.remaining > 65536) throw protocolError('Oversized authentication message.');
  const method = reader.int32();
  switch (method) {
    case 0:
      return { method: 'ok' };
    case 3:
      return { method: 'password' };
    case 5:
      return { method: 'md5', salt: reader.bytes(4) };
    case 10: {
      const mechanisms: string[] = [];
      for (let name = reader.cstring(); name; name = reader.cstring()) {
        if (
          mechanisms.length >= 32 ||
          !/^[A-Z0-9_-]{1,64}$/.test(name) ||
          mechanisms.includes(name)
        )
          throw protocolError('Invalid SASL mechanism list.');
        mechanisms.push(name);
      }
      if (!mechanisms.length) throw protocolError('Empty SASL mechanism list.');
      return { method: 'sasl', mechanisms };
    }
    case 11:
    case 12:
      if (reader.remaining > 65536) throw protocolError('Oversized SASL challenge.');
      return { method: method === 11 ? 'continue' : 'final', data: reader.text(reader.remaining) };
    default:
      throw new DriverError(
        'PGCLEAR_AUTHENTICATION',
        'Unsupported PostgreSQL authentication method.',
      );
  }
}

export function decodeMessage(frame: Frame): Message {
  const reader = new Reader(frame.payload);
  let message: Message;
  switch (String.fromCharCode(frame.type)) {
    case 'R':
      message = { type: 'authentication', authentication: authentication(reader) };
      break;
    case 'S':
      message = { type: 'parameter', name: reader.cstring(), value: reader.cstring() };
      break;
    case 'K':
      message = { type: 'key', pid: reader.uint32(), secret: reader.uint32() };
      break;
    case 'Z': {
      const status = reader.byte();
      if (![73, 84, 69].includes(status)) throw protocolError('Invalid transaction status.');
      message = {
        type: 'ready',
        status: status === 73 ? 'idle' : status === 84 ? 'transaction' : 'failed',
      };
      break;
    }
    case 'E':
    case 'N': {
      const fields = new Map<string, string>();
      for (let key = reader.byte(); key; key = reader.byte()) {
        const name = String.fromCharCode(key);
        if (fields.has(name)) throw protocolError('Duplicate diagnostic field.');
        fields.set(name, reader.cstring());
      }
      if (!fields.has('M') || !/^[0-9A-Z]{5}$/.test(fields.get('C') ?? ''))
        throw protocolError('Invalid database diagnostic.');
      message = { type: frame.type === 69 ? 'error' : 'notice', error: new DatabaseError(fields) };
      break;
    }
    case 'T': {
      const count = reader.uint16();
      const fields: Field[] = [];
      for (let i = 0; i < count; i++) {
        const name = reader.cstring(),
          tableOid = reader.uint32(),
          columnAttribute = reader.int16();
        const dataTypeOid = reader.uint32(),
          dataTypeSize = reader.int16(),
          typeModifier = reader.int32();
        const format = reader.uint16();
        if (format > 1) throw protocolError('Invalid field format.');
        fields.push(
          Object.freeze({
            name,
            tableOid,
            columnAttribute,
            dataTypeOid,
            dataTypeSize,
            typeModifier,
            format: format === 0 ? 'text' : 'binary',
          }),
        );
      }
      message = { type: 'fields', fields: Object.freeze(fields) };
      break;
    }
    case 't': {
      const count = reader.uint16(),
        oids: number[] = [];
      for (let i = 0; i < count; i++) oids.push(reader.uint32());
      message = { type: 'parameters', oids: Object.freeze(oids) };
      break;
    }
    case 'D': {
      const count = reader.uint16(),
        values: (Buffer | null)[] = [];
      for (let i = 0; i < count; i++) {
        const length = reader.int32();
        values.push(length === -1 ? null : reader.bytes(length));
      }
      message = { type: 'row', values };
      break;
    }
    case 'G':
    case 'H': {
      const format = reader.byte(),
        count = reader.uint16(),
        columns: number[] = [];
      if (format > 1) throw protocolError('Invalid COPY format.');
      for (let i = 0; i < count; i++) {
        const column = reader.uint16();
        if (column > 1) throw protocolError('Invalid COPY column format.');
        columns.push(column);
      }
      message = {
        type: frame.type === 71 ? 'copy-in' : 'copy-out',
        format,
        columns: Object.freeze(columns),
      };
      break;
    }
    case 'd':
      message = { type: 'copy-data', bytes: reader.bytes(reader.remaining) };
      break;
    case 'c':
      message = { type: 'copy-done' };
      break;
    case 'C':
      message = { type: 'command', tag: reader.cstring() };
      break;
    case '1':
      message = { type: 'parse' };
      break;
    case '2':
      message = { type: 'bind' };
      break;
    case 's':
      message = { type: 'suspended' };
      break;
    case '3':
      message = { type: 'close' };
      break;
    case 'n':
      message = { type: 'no-data' };
      break;
    case 'I':
      message = { type: 'empty' };
      break;
    case 'A':
      message = {
        type: 'notification',
        pid: reader.uint32(),
        channel: reader.cstring(),
        payload: reader.cstring(),
      };
      break;
    default:
      throw protocolError('Unexpected or unsupported backend message.');
  }
  reader.end();
  return message;
}
