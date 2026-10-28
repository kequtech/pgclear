import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Authenticator } from '../src/auth/index.js';
import { ScramClient, preparePassword } from '../src/auth/scram.js';
import { certificateBinding } from '../src/auth/channel-binding.js';
import { normalizeConfiguration } from '../src/config/index.js';
import { fixturePath } from './helpers/server.js';

const nonce = 'rOprNGfwEbeRWgbNEkqO';
const serverNonce = nonce + '%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
const challenge = `r=${serverNonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096`;

test('SCRAM-SHA-256 matches RFC 7677 section 3, including the verified server proof', async () => {
  const client = new ScramClient(['SCRAM-SHA-256'], 'disable', undefined, nonce, 'user');
  assert.equal(client.initial, `n,,n=user,r=${nonce}`);
  assert.equal(
    await client.continue(challenge, 'pencil'),
    `c=biws,r=${serverNonce},p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=`,
  );
  client.finish('v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
  assert.equal(client.verified, true);
  assert.throws(() => client.finish('v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4='));
});

test('SCRAM refuses corrupt nonces, proofs, duplicate attributes, mandatory extensions and expensive iteration counts', async () => {
  for (const invalid of [
    'r=other,s=c2FsdA==,i=4096',
    `r=${nonce},s=c2FsdA==,i=4096`,
    `r=${nonce}x,s=??,i=4096`,
    `r=${nonce}x,s=c2FsdA==,i=0`,
    `r=${nonce}x,s=c2FsdA==,i=100001`,
    `r=${nonce}x,s=c2FsdA==,i=1,i=1`,
    `m=required,r=${nonce}x,s=c2FsdA==,i=4096`,
    `r=${nonce}x,s=c2FsdA==,i=4x`,
  ]) {
    await assert.rejects(
      new ScramClient(['SCRAM-SHA-256'], 'disable', undefined, nonce).continue(invalid, 'pencil'),
      { code: 'PGCLEAR_AUTHENTICATION' },
    );
  }
  for (const proof of [
    'v=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    'v=AA==',
    'e=invalid-proof',
    'v=??',
  ]) {
    const client = new ScramClient(['SCRAM-SHA-256'], 'disable', undefined, nonce);
    await client.continue(challenge, 'pencil');
    assert.throws(() => client.finish(proof), { code: 'PGCLEAR_AUTHENTICATION' });
  }
});

test('SASLprep follows RFC 4013 mappings and PostgreSQL raw-password fallback', () => {
  assert.equal(preparePassword('I\u00ADX'), 'IX');
  assert.equal(preparePassword('\u00AA'), 'a');
  assert.equal(preparePassword('\u2168'), 'IX');
  assert.equal(preparePassword('x\u00A0y'), 'x y');
  assert.equal(preparePassword('\u0007'), '\u0007');
  assert.equal(preparePassword('\u0627\u0031'), '\u0627\u0031'); // Bidi-invalid: PG uses the raw string.
});

test('channel-binding selection reports downgrade support and incorporates certificate bytes', async () => {
  const binding = Buffer.from([1, 2, 3]);
  const plus = new ScramClient(['SCRAM-SHA-256', 'SCRAM-SHA-256-PLUS'], 'require', binding, nonce);
  assert.equal(plus.mechanism, 'SCRAM-SHA-256-PLUS');
  assert.ok(plus.initial.startsWith('p=tls-server-end-point,,'));
  assert.ok(
    (await plus.continue(challenge, 'pencil')).startsWith(
      `c=${Buffer.concat([Buffer.from('p=tls-server-end-point,,'), binding]).toString('base64')},`,
    ),
  );
  assert.ok(new ScramClient(['SCRAM-SHA-256'], 'prefer', binding, nonce).initial.startsWith('y,,'));
  assert.ok(
    new ScramClient(['SCRAM-SHA-256'], 'disable', binding, nonce).initial.startsWith('n,,'),
  );
  assert.throws(() => new ScramClient(['SCRAM-SHA-256'], 'require', binding), {
    code: 'PGCLEAR_AUTHENTICATION',
  });
});

test('tls-server-end-point uses the certificate signature hash, not a hardcoded SHA256 fingerprint', async () => {
  const certificate = new X509Certificate(await readFile(fixturePath('server-cert.pem'))).raw;
  assert.deepEqual(
    certificateBinding(certificate),
    createHash('sha384').update(certificate).digest(),
  );
  for (const length of [0, 1, 2, 10, certificate.length - 1])
    assert.throws(() => certificateBinding(certificate.subarray(0, length)), {
      code: 'PGCLEAR_AUTHENTICATION',
    });
});

test('authentication state machine refuses premature success, repeated challenges and plaintext password on TCP', async () => {
  const config = normalizeConfiguration({ user: 'postgres', password: 'postgres' });
  await assert.rejects(new Authenticator(config, undefined).receive({ method: 'password' }), {
    code: 'PGCLEAR_AUTHENTICATION',
  });
  const auth = new Authenticator(config, undefined);
  await auth.receive({ method: 'sasl', mechanisms: ['SCRAM-SHA-256'] });
  await assert.rejects(auth.receive({ method: 'ok' }), { code: 'PGCLEAR_AUTHENTICATION' });
  await assert.rejects(auth.receive({ method: 'sasl', mechanisms: ['SCRAM-SHA-256'] }), {
    code: 'PGCLEAR_AUTHENTICATION',
  });
  const required = new Authenticator(
    normalizeConfiguration({ tls: { channelBinding: 'require' } }),
    Buffer.alloc(32),
  );
  await assert.rejects(required.receive({ method: 'ok' }), { code: 'PGCLEAR_AUTHENTICATION' });
});

test('trust authentication does not inspect a certificate digest it does not need', async () => {
  const auth = new Authenticator(normalizeConfiguration({ tls: {} }), () => {
    throw new Error('unused digest');
  });
  await auth.receive({ method: 'ok' });
  assert.equal(auth.complete, true);
});

test('MD5 compatibility uses the unnormalized password and salt, with one provider invocation', async () => {
  let calls = 0;
  const auth = new Authenticator(
    normalizeConfiguration({
      user: 'user',
      password: () => {
        calls++;
        return 'p\u00ADass';
      },
    }),
    undefined,
  );
  const salt = Buffer.from([1, 2, 3, 4]);
  const first = createHash('md5').update('p\u00ADassuser').digest('hex');
  const expected = 'md5' + createHash('md5').update(first).update(salt).digest('hex');
  const response = await auth.receive({ method: 'md5', salt });
  assert.equal(response!.subarray(5).toString(), expected + '\0');
  await auth.receive({ method: 'ok' });
  assert.equal(calls, 1);
  assert.equal(auth.complete, true);
});
