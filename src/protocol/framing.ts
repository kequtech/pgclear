import { protocolError } from '../errors.js';

export interface Frame {
  readonly type: number;
  readonly payload: Buffer;
}

/** One bounded allocation per frame; fragmented input never repeatedly copies the accumulated frame. */
export class FrameDecoder {
  #header = Buffer.alloc(5);
  #headerUsed = 0;
  #payload: Buffer | undefined;
  #payloadUsed = 0;
  #failed = false;

  constructor(private readonly maxMessageBytes: number) {}

  push(chunk: Buffer, receive: (frame: Frame) => void): void {
    if (this.#failed) throw protocolError('The protocol decoder has failed.');
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.#headerUsed < 5) {
          const count = Math.min(5 - this.#headerUsed, chunk.length - offset);
          chunk.copy(this.#header, this.#headerUsed, offset, offset + count);
          this.#headerUsed += count;
          offset += count;
          if (this.#headerUsed < 5) continue;
          const length = this.#header.readUInt32BE(1);
          if (length < 4 || length > this.maxMessageBytes)
            throw protocolError('Invalid or oversized protocol frame.');
          this.#payload = Buffer.allocUnsafe(length - 4);
        }
        const payload = this.#payload!;
        const count = Math.min(payload.length - this.#payloadUsed, chunk.length - offset);
        chunk.copy(payload, this.#payloadUsed, offset, offset + count);
        offset += count;
        this.#payloadUsed += count;
        if (this.#payloadUsed === payload.length) {
          const type = this.#header[0]!;
          this.#headerUsed = this.#payloadUsed = 0;
          this.#payload = undefined;
          receive({ type, payload });
        }
      }
    } catch (error) {
      this.#failed = true;
      this.#payload = undefined;
      throw error;
    }
  }
}

export function int16(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(2);
  bytes.writeUInt16BE(value);
  return bytes;
}
export function int32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeInt32BE(value);
  return bytes;
}
export function uint32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}
export function cstring(value: string): Buffer {
  return Buffer.from(value + '\0');
}
export function frame(type: string, ...parts: readonly Uint8Array[]): Buffer {
  const payload = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type), int32(payload.length + 4), payload]);
}
export function startup(parameters: Readonly<Record<string, string>>): Buffer {
  const body = Buffer.concat([
    int32(196608),
    ...Object.entries(parameters).flatMap(([key, value]) => [cstring(key), cstring(value)]),
    Buffer.from([0]),
  ]);
  return Buffer.concat([int32(body.length + 4), body]);
}
export const sslRequest = Buffer.concat([int32(8), int32(80877103)]);
export const terminate = frame('X');
