import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameDecoder, frame, startup } from '../src/protocol/framing.js';
import { decodeMessage, Reader, type Message } from '../src/protocol/messages.js';
import { commandResult, encodeQuery } from '../src/connection/query.js';
import { DriverError } from '../src/index.js';
import { auth, i32, packet, ready, z } from './helpers/server.js';

const fields = packet(
  'T',
  Buffer.concat([
    Buffer.from([0, 1]),
    z('value'),
    i32(42),
    Buffer.from([0, 1]),
    i32(23),
    Buffer.from([0, 4]),
    i32(-1),
    Buffer.from([0, 0]),
  ]),
);
const messages = [
  auth(0),
  auth(3),
  auth(5, Buffer.from([1, 2, 3, 4])),
  auth(10, Buffer.concat([z('SCRAM-SHA-256'), Buffer.from([0])])),
  auth(11, Buffer.from('r=abc,s=c2FsdA==,i=4096')),
  auth(12, Buffer.from('v=abc')),
  packet('K', Buffer.concat([i32(123), i32(456)])),
  packet('S', Buffer.concat([z('client_encoding'), z('UTF8')])),
  fields,
  packet('D', Buffer.from('000200000000ffffffff', 'hex')),
  packet('C', z('SELECT 1')),
  packet(
    'N',
    Buffer.concat([
      Buffer.from('S'),
      z('NOTICE'),
      Buffer.from('C'),
      z('00000'),
      Buffer.from('M'),
      z('hello'),
      Buffer.from([0]),
    ]),
  ),
  ready,
  packet('1'),
  packet('2'),
  packet('n'),
  packet('I'),
  packet('A', Buffer.concat([i32(12), z('jobs'), z('ready')])),
];

test('command counts are safe numbers or null, independently of int8 column codecs', () => {
  for (const command of [
    'SELECT',
    'INSERT 0',
    'UPDATE',
    'DELETE',
    'MERGE',
    'MOVE',
    'FETCH',
    'COPY',
  ]) {
    for (const count of [0, 1, 2147483648, Number.MAX_SAFE_INTEGER])
      assert.equal(commandResult(`${command} ${count}`).rowCount, count);
    for (const count of ['9007199254740992', '18446744073709551615'])
      assert.throws(() => commandResult(`${command} ${count}`), {
        code: 'PGCLEAR_RESULT_LIMIT',
        outcome: 'confirmed',
      });
  }
  for (const tag of ['', 'CREATE TABLE', 'BEGIN', 'SHOW'])
    assert.equal(commandResult(tag).rowCount, null);
  assert.deepEqual(commandResult('SELECT 0', 6), {
    command: 'SELECT',
    commandTag: 'SELECT 0',
    rowCount: 6,
  });
  assert.equal(commandResult('SHOW', 1).rowCount, 1);
  assert.throws(() => commandResult('SELECT 0', Number.MAX_SAFE_INTEGER + 1), {
    code: 'PGCLEAR_RESULT_LIMIT',
  });
});

test('backend frames decode identically at every split and when coalesced or byte-fragmented', () => {
  const decode = (chunks: readonly Buffer[]) => {
    const decoder = new FrameDecoder(4096),
      result: Message[] = [];
    for (const chunk of chunks) decoder.push(chunk, (frame) => result.push(decodeMessage(frame)));
    return result;
  };
  const expected = messages.flatMap((message) => decode([message]));
  const coalesced = Buffer.concat(messages);
  assert.deepEqual(decode([coalesced]), expected);
  assert.deepEqual(decode([...coalesced].map((byte) => Buffer.from([byte]))), expected);
  for (const message of messages) {
    for (let split = 0; split <= message.length; split++) {
      assert.deepEqual(
        decode([message.subarray(0, split), message.subarray(split)]),
        decode([message]),
      );
    }
  }
});

test('malformed lengths reject at the header, before reading or allocating their payload', () => {
  for (const length of [0, 1, 2, 3, 1025, 0xffffffff]) {
    const bytes = Buffer.alloc(5);
    bytes[0] = 68;
    bytes.writeUInt32BE(length, 1);
    assert.throws(() => new FrameDecoder(1024).push(bytes, () => assert.fail()), {
      code: 'PGCLEAR_PROTOCOL',
    });
  }
  const decoder = new FrameDecoder(1024);
  assert.throws(() => decoder.push(Buffer.from('4400000003', 'hex'), () => {}));
  assert.throws(() => decoder.push(ready, () => {}), { code: 'PGCLEAR_PROTOCOL' });
});

test('bounded readers reject truncated counts, invalid UTF8, trailing data and unterminated strings', () => {
  const invalid = [
    packet('S', Buffer.from('name')),
    packet('S', Buffer.from('c0800000', 'hex')),
    packet('D', Buffer.from('00010000000301', 'hex')),
    packet('D', Buffer.from('0001fffffffe', 'hex')),
    packet('T', Buffer.from('ffff', 'hex')),
    packet('Z', Buffer.from('X')),
    packet('Z', Buffer.from('II')),
    auth(5, Buffer.from([1, 2, 3])),
    auth(0, Buffer.from([0])),
    auth(10, z('SCRAM-SHA-256')),
    packet('E', Buffer.concat([Buffer.from('M'), z('missing SQLSTATE'), Buffer.from([0])])),
    packet('?'),
  ];
  for (const bytes of invalid)
    assert.throws(
      () => new FrameDecoder(4096).push(bytes, (frame) => decodeMessage(frame)),
      DriverError,
    );
});

test('authentication challenges have their own finite byte and mechanism count limits', () => {
  assert.throws(() => decodeMessage({ type: 82, payload: Buffer.alloc(65537) }), {
    code: 'PGCLEAR_PROTOCOL',
  });
  const mechanisms = Array.from({ length: 33 }, (_, i) => z(`METHOD_${i}`));
  assert.throws(
    () =>
      decodeMessage({
        type: 82,
        payload: Buffer.concat([i32(10), ...mechanisms, Buffer.from([0])]),
      }),
    { code: 'PGCLEAR_PROTOCOL' },
  );
});

test('row messages distinguish NULL, empty bytes, and stable copied payloads', () => {
  const decoder = new FrameDecoder(4096),
    input = packet('D', Buffer.from('000300000000ffffffff000000026162', 'hex'));
  let message: ReturnType<typeof decodeMessage> | undefined;
  decoder.push(input, (frame) => {
    message = decodeMessage(frame);
  });
  input.fill(0);
  assert.deepEqual(message, { type: 'row', values: [Buffer.alloc(0), null, Buffer.from('ab')] });
});

test('frontend startup and extended execution encode the documented wire structure', () => {
  assert.equal(frame('S').toString('hex'), '5300000004');
  assert.equal(
    startup({ user: 'u', database: 'd' }).toString('hex'),
    '0000001b0003000075736572007500646174616261736500640000',
  );
  const frames: { type: string; reader: Reader }[] = [];
  new FrameDecoder(4096).push(
    encodeQuery({ text: 'SELECT $1, $2', values: [null, new Uint8Array([255])] }),
    (frame) =>
      frames.push({ type: String.fromCharCode(frame.type), reader: new Reader(frame.payload) }),
  );
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ['P', 'B', 'D', 'E', 'S'],
  );
  const parse = frames[0]!.reader;
  assert.equal(parse.cstring(), '');
  assert.equal(parse.cstring(), 'SELECT $1, $2');
  assert.equal(parse.uint16(), 2);
  assert.equal(parse.uint32(), 0);
  assert.equal(parse.uint32(), 17);
  parse.end();
  const bind = frames[1]!.reader;
  assert.equal(bind.cstring(), '');
  assert.equal(bind.cstring(), '');
  assert.equal(bind.uint16(), 2);
  assert.equal(bind.uint16(), 0);
  assert.equal(bind.uint16(), 1);
  assert.equal(bind.uint16(), 2);
  assert.equal(bind.int32(), -1);
  assert.equal(bind.int32(), 1);
  assert.equal(bind.byte(), 255);
  assert.equal(bind.uint16(), 0);
  bind.end();
});

test('sparse and ambiguous values reject before a request is encoded', () => {
  const bad: unknown[] = [
    [undefined],
    Array(1),
    [[1, 2]],
    [{}],
    [new Date(NaN)],
    [NaN],
    [Infinity],
    [Number.MAX_SAFE_INTEGER + 1],
    ['x\0y'],
  ];
  for (const values of bad)
    assert.throws(() => encodeQuery({ text: 'SELECT $1', values } as never), {
      code: 'PGCLEAR_ENCODE',
    });
  assert.throws(() => encodeQuery({ text: 'SELECT $1', values: [1], parameterTypes: [] }), {
    code: 'PGCLEAR_ENCODE',
  });
});

test('protocol strings preserve U+FEFF in names, notices and notification payloads', () => {
  const value = '\ufeffé😀';
  const reader = new Reader(Buffer.concat([z(value), z('\ufeff' + value), Buffer.from(value)]));
  assert.equal(reader.cstring(), value);
  assert.equal(reader.cstring(), '\ufeff' + value);
  assert.equal(reader.text(Buffer.byteLength(value)), value);
  reader.end();
  const decode = (type: string, payload: Buffer) =>
    decodeMessage({ type: type.charCodeAt(0), payload });
  const description = decode(
    'T',
    Buffer.concat([
      Buffer.from([0, 1]),
      z(value),
      i32(0),
      Buffer.from([0, 0]),
      i32(25),
      Buffer.from([0xff, 0xff]),
      i32(-1),
      Buffer.from([0, 0]),
    ]),
  );
  assert.equal(description.type, 'fields');
  if (description.type === 'fields') assert.equal(description.fields[0]!.name, value);
  const notice = decode(
    'N',
    Buffer.concat([
      Buffer.from('S'),
      z('NOTICE'),
      Buffer.from('C'),
      z('00000'),
      Buffer.from('M'),
      z(value),
      Buffer.from([0]),
    ]),
  );
  assert.equal(notice.type, 'notice');
  if (notice.type === 'notice') assert.equal(notice.error.message, value);
  assert.deepEqual(decode('A', Buffer.concat([i32(1), z(value), z(value)])), {
    type: 'notification',
    pid: 1,
    channel: value,
    payload: value,
  });
});
