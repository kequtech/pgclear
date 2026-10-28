import { createHash } from 'node:crypto';
import { authenticationError } from './scram.js';

interface DerValue {
  readonly tag: number;
  readonly start: number;
  readonly end: number;
}
/** Only the certificate's outer signature AlgorithmIdentifier is inspected, after TLS verification. */
function der(data: Buffer, offset: number, limit: number): DerValue {
  if (offset + 2 > limit) throw authenticationError();
  const tag = data[offset++]!;
  let size = data[offset++]!;
  if (size >= 128) {
    const count = size & 127;
    if (count === 0 || count > 4 || offset + count > limit || data[offset] === 0)
      throw authenticationError();
    size = 0;
    for (let i = 0; i < count; i++) size = size * 256 + data[offset++]!;
    if (size < 128) throw authenticationError();
  }
  const end = offset + size;
  if (end > limit) throw authenticationError();
  return { tag, start: offset, end };
}
const algorithmHashes: Readonly<Record<string, string>> = {
  '2a864886f70d010104': 'sha256', // RSA MD5/SHA1 are upgraded by RFC 5929.
  '2a864886f70d010105': 'sha256',
  '2a864886f70d01010b': 'sha256',
  '2a864886f70d01010c': 'sha384',
  '2a864886f70d01010d': 'sha512',
  '2a864886f70d01010e': 'sha224',
  '2a864886f70d01010f': 'sha512-224',
  '2a864886f70d010110': 'sha512-256',
  '2a8648ce3d0401': 'sha256',
  '2a8648ce3d040301': 'sha224',
  '2a8648ce3d040302': 'sha256',
  '2a8648ce3d040303': 'sha384',
  '2a8648ce3d040304': 'sha512',
  '2b6570': 'sha512', // Ed25519, matching PostgreSQL/OpenSSL's certificate digest.
};
const digestHashes: Readonly<Record<string, string>> = {
  '2b0e03021a': 'sha256', // PSS defaults to SHA1, promoted to SHA256.
  '608648016503040201': 'sha256',
  '608648016503040202': 'sha384',
  '608648016503040203': 'sha512',
  '608648016503040204': 'sha224',
};

function oid(data: Buffer, value: DerValue): string {
  if (value.tag !== 6 || value.start === value.end) throw authenticationError();
  return data.subarray(value.start, value.end).toString('hex');
}

export function certificateBinding(certificate: Buffer): Buffer {
  const root = der(certificate, 0, certificate.length);
  if (root.tag !== 0x30 || root.end !== certificate.length) throw authenticationError();
  const info = der(certificate, root.start, root.end);
  const algorithm = der(certificate, info.end, root.end);
  if (info.tag !== 0x30 || algorithm.tag !== 0x30) throw authenticationError();
  const identifier = der(certificate, algorithm.start, algorithm.end);
  const algorithmOid = oid(certificate, identifier);
  let hash = algorithmHashes[algorithmOid];
  if (algorithmOid === '2a864886f70d01010a') {
    hash = 'sha256';
    if (identifier.end < algorithm.end) {
      const parameters = der(certificate, identifier.end, algorithm.end);
      if (parameters.tag !== 0x30 || parameters.end !== algorithm.end) throw authenticationError();
      // RSASSA-PSS hashAlgorithm [0] is optional and defaults to SHA1.
      if (parameters.start < parameters.end) {
        const first = der(certificate, parameters.start, parameters.end);
        if (first.tag === 0xa0) {
          const digest = der(certificate, first.start, first.end);
          if (digest.tag !== 0x30 || digest.end !== first.end) throw authenticationError();
          hash = digestHashes[oid(certificate, der(certificate, digest.start, digest.end))];
        }
      }
    }
  }
  if (!hash) throw authenticationError();
  return createHash(hash).update(certificate).digest();
}
