import assert from 'node:assert/strict';
import { Reader } from '../../src/protocol/messages.js';
import { type Peer, packet, ready, z, i32 } from './server.js';

export async function listenerQuery(peer: Peer): Promise<string> {
  const message = await peer.message();
  assert.equal(message.type, 'P');
  const reader = new Reader(message.payload);
  assert.equal(reader.cstring(), '');
  const text = reader.cstring();
  for (const type of ['B', 'D', 'E', 'S']) assert.equal((await peer.message()).type, type);
  return text;
}
export function listenerReply(tag = 'SELECT 0'): Buffer {
  return Buffer.concat([packet('1'), packet('2'), packet('n'), packet('C', z(tag)), ready]);
}
export async function registerListener(peer: Peer, channels = ['fixture']): Promise<void> {
  assert.match(await listenerQuery(peer), /max_identifier_length/);
  peer.socket.write(listenerReply());
  for (const channel of channels) {
    assert.equal(await listenerQuery(peer), 'LISTEN "' + channel.replaceAll('"', '""') + '"');
    peer.socket.write(listenerReply('LISTEN'));
  }
}
export function notification(channel = 'fixture', payload = 'bytes', pid = 42): Buffer {
  return packet('A', Buffer.concat([i32(pid), z(channel), z(payload)]));
}
