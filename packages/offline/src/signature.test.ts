import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { testing } from '@opcb/provider-sdk';
import {
  SIGNATURE_FORMAT,
  checkSignature,
  formatKeyId,
  generatePackKeyPair,
  keyIdOf,
  parsePublisherKeyFile,
  publisherKeyFile,
  signManifest,
  type TrustedPublisher,
} from './signature.js';
import { signWorldPack } from './sign-pack.js';
import { readWorldPackManifest, verifyWorldPack } from './verify.js';
import { WorldPackRegistry } from './registry.js';
import { ZipReader } from './zip.js';
import { buildTestPack, writeTestPack } from '../test/helpers/pack.js';
import { tempDir } from '../test/helpers/raw-zip.js';

const { VirtualClock } = testing;
const ALICE = generatePackKeyPair();
const BOB = generatePackKeyPair();
const trusted = (k: typeof ALICE, name: string): TrustedPublisher => ({
  keyId: k.keyId,
  publicKey: k.publicKey,
  name,
  addedAt: '2026-09-21T00:00:00.000Z',
});

function registry(dataDir: string): WorldPackRegistry {
  return new WorldPackRegistry({
    dataDir,
    appVersion: '0.1.0',
    clock: new VirtualClock(Date.parse('2026-09-21T12:00:00Z')),
  });
}

test('a signature says who signed these exact manifest bytes, and nothing else', () => {
  const manifest = Buffer.from('{"formatVersion":1,"id":"x"}');
  const sig = signManifest(manifest, ALICE.privateKeyPem);
  const parsed = JSON.parse(Buffer.from(sig).toString('utf8')) as Record<string, unknown>;
  assert.equal(parsed['format'], SIGNATURE_FORMAT);
  assert.equal(parsed['keyId'], ALICE.keyId);
  assert.equal(JSON.stringify(parsed).includes('PRIVATE'), false, 'no private key material');

  assert.deepEqual(checkSignature(manifest, undefined), { status: 'unsigned' });
  const unknown = checkSignature(manifest, sig);
  assert.equal(unknown.status, 'signed');
  assert.equal(unknown.status === 'signed' && unknown.trusted, false, 'a valid signature by an unknown key');
  const known = checkSignature(manifest, sig, [trusted(ALICE, 'Alice Maps')]);
  assert.ok(known.status === 'signed' && known.trusted && known.publisher === 'Alice Maps');
  const other = checkSignature(manifest, sig, [trusted(BOB, 'Bob')]);
  assert.ok(other.status === 'signed' && !other.trusted, 'trust is by key, not by name');

  const changed = checkSignature(Buffer.from('{"formatVersion":1,"id":"y"}'), sig);
  assert.equal(changed.status, 'invalid');
  assert.match(changed.status === 'invalid' ? changed.reason : '', /changed after signing/);
});

test('a malformed or forged signature file is invalid, with the reason', () => {
  const manifest = Buffer.from('{}');
  const good = JSON.parse(Buffer.from(signManifest(manifest, ALICE.privateKeyPem)).toString()) as Record<
    string,
    unknown
  >;
  const reason = (file: unknown) => {
    const r = checkSignature(manifest, Buffer.from(typeof file === 'string' ? file : JSON.stringify(file)));
    return r.status === 'invalid' ? r.reason : `not invalid: ${r.status}`;
  };
  assert.match(reason('not json'), /not JSON/);
  assert.match(reason({ ...good, format: 'other@1' }), /not a worldview-pack-signature@1/);
  assert.match(reason({ ...good, algorithm: 'rsa' }), /algorithm/);
  assert.match(reason({ ...good, publicKey: 'AAAA' }), /32-byte/);
  assert.match(reason({ ...good, keyId: BOB.keyId }), /key id does not belong/);
  // Bob's key with Alice's signature: the claim of authorship does not verify.
  assert.match(reason({ ...good, publicKey: BOB.publicKey, keyId: BOB.keyId }), /does not match/);
  assert.match(reason({ ...good, signature: 'AAAA' }), /64 bytes/);
  const big = checkSignature(manifest, Buffer.alloc(5000, 32));
  assert.match(big.status === 'invalid' ? big.reason : '', /larger than/);
});

test('publisher key files carry the public half only, and are checked on the way in', () => {
  const text = publisherKeyFile('Alice Maps', ALICE.publicKey);
  assert.equal(text.includes('PRIVATE'), false);
  const back = parsePublisherKeyFile(text);
  assert.ok(back.ok);
  assert.equal(back.ok && back.name, 'Alice Maps');
  assert.equal(back.ok && back.keyId, ALICE.keyId);
  assert.equal(keyIdOf(Buffer.from(ALICE.publicKey, 'base64')), ALICE.keyId);
  assert.match(formatKeyId(ALICE.keyId), /^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/);
  const bad = (t: string) => {
    const r = parsePublisherKeyFile(t);
    return r.ok ? 'ok' : r.reason;
  };
  assert.match(bad('{'), /not JSON/);
  assert.match(bad(JSON.stringify({ format: 'x' })), /not a worldview-pack-publisher@1/);
  assert.match(bad(text.replace(ALICE.keyId, BOB.keyId)), /key id does not match/);
  const unnamed = parsePublisherKeyFile(JSON.stringify({ ...JSON.parse(text), name: '' }));
  assert.ok(unnamed.ok && unnamed.name.startsWith('Publisher '), 'an unnamed key is named by its id');
});

test('verify: signed, unsigned and forged packs; a trust requirement refuses what it does not know', async () => {
  const dir = await tempDir();
  const signed = path.join(dir, 'signed.worldpack');
  const unsigned = path.join(dir, 'unsigned.worldpack');
  const forged = path.join(dir, 'forged.worldpack');
  await writeTestPack(signed, { signWith: ALICE.privateKeyPem });
  await writeTestPack(unsigned);
  // Alice signed the pack as built; the manifest was then edited (a file swapped, hashes updated).
  const original = buildTestPack();
  const aliceSig = Buffer.from(signManifest(Buffer.from(JSON.stringify(original.manifest)), ALICE.privateKeyPem));
  await writeTestPack(forged, { name: 'Edited after signing', signature: aliceSig });

  const s = await verifyWorldPack(signed);
  assert.ok(s.ok, s.issues.join('; '));
  assert.equal(s.signature?.status, 'signed');
  assert.equal(s.entries.length, 3, 'manifest.sig is not a content entry');
  const u = await verifyWorldPack(unsigned);
  assert.ok(u.ok);
  assert.deepEqual(u.signature, { status: 'unsigned' });
  const f = await verifyWorldPack(forged, { trustedPublishers: [trusted(ALICE, 'Alice')] });
  assert.equal(f.ok, false, 'a broken signature is refused even from a trusted key');
  assert.match(f.issues.join(';'), /signature: .*changed after signing/);

  const strict = { requireTrusted: true, trustedPublishers: [trusted(ALICE, 'Alice')] };
  assert.equal((await verifyWorldPack(signed, strict)).ok, true);
  assert.match((await verifyWorldPack(unsigned, strict)).issues.join(';'), /not signed/);
  const byBob = path.join(dir, 'bob.worldpack');
  await writeTestPack(byBob, { signWith: BOB.privateKeyPem });
  assert.match((await verifyWorldPack(byBob, strict)).issues.join(';'), /not one of your trusted publishers/);

  const inspected = await readWorldPackManifest(signed);
  assert.ok(inspected.ok && inspected.signature.status === 'signed');
  await fs.rm(dir, { recursive: true, force: true });
});

test('sign an existing pack: same entries, same manifest bytes, a signature added — or replaced', async () => {
  const dir = await tempDir();
  const input = path.join(dir, 'in.worldpack');
  const out = path.join(dir, 'out.worldpack');
  await writeTestPack(input);
  const r = await signWorldPack(input, out, ALICE.privateKeyPem);
  assert.equal(r.keyId, ALICE.keyId);
  assert.equal(r.replacedSignature, false);
  const v = await verifyWorldPack(out, { trustedPublishers: [trusted(ALICE, 'Alice')] });
  assert.ok(v.ok, v.issues.join('; '));
  assert.ok(v.signature?.status === 'signed' && v.signature.trusted);
  const names = async (f: string) => {
    const z = await ZipReader.open(f);
    try {
      return z.entries().map((e) => `${e.name}:${e.method}`);
    } finally {
      await z.close();
    }
  };
  assert.deepEqual((await names(out)).slice(0, -1), await names(input), 'entries and methods kept, sig appended');
  const manifestOf = async (f: string) => {
    const z = await ZipReader.open(f);
    try {
      return (await z.readEntry('manifest.json')).toString('utf8');
    } finally {
      await z.close();
    }
  };
  assert.equal(await manifestOf(out), await manifestOf(input), 'the manifest is copied, not re-serialized');

  const again = await signWorldPack(out, out, BOB.privateKeyPem);
  assert.equal(again.replacedSignature, true);
  const b = await verifyWorldPack(out);
  assert.ok(b.signature?.status === 'signed' && b.signature.keyId === BOB.keyId);
  assert.equal((await names(out)).filter((n) => n.startsWith('manifest.sig')).length, 1);

  const original = buildTestPack();
  const aliceSig = Buffer.from(signManifest(Buffer.from(JSON.stringify(original.manifest)), ALICE.privateKeyPem));
  const forged = path.join(dir, 'forged.worldpack');
  await writeTestPack(forged, { name: 'Edited', signature: aliceSig });
  await assert.rejects(signWorldPack(forged, path.join(dir, 'x.worldpack'), BOB.privateKeyPem), /does not verify/);
  await assert.rejects(signWorldPack(input, path.join(dir, 'y.worldpack'), 'not a key'), /signing key unusable/);
  assert.deepEqual(
    (await fs.readdir(dir)).filter((n) => n.includes('.signing') || n.includes('.partial')),
    [],
    'no work files left behind',
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('registry: publishers are trusted by the operator, persist, and a trust requirement applies to installed packs too', async () => {
  const dir = await tempDir();
  const dataDir = path.join(dir, 'data');
  const signed = path.join(dir, 'signed.worldpack');
  const unsigned = path.join(dir, 'unsigned.worldpack');
  await writeTestPack(signed, { signWith: ALICE.privateKeyPem });
  await writeTestPack(unsigned, { id: 'plain-pack' });
  const reg = registry(dataDir);
  await reg.refresh();

  const r = await reg.install(signed);
  assert.deepEqual(r.installed?.signature, { status: 'signed', keyId: ALICE.keyId });
  assert.ok(
    (await fs.stat(path.join(dataDir, 'worldpacks', 'hawaii-test', 'manifest.sig'))).isFile(),
    'the signature is installed with the pack',
  );
  assert.equal((await reg.install(unsigned)).installed?.signature?.status, 'unsigned');

  await reg.trustPackPublisher('hawaii-test', 'Alice Maps');
  assert.deepEqual(reg.get('hawaii-test')?.summary.signature, {
    status: 'trusted',
    keyId: ALICE.keyId,
    publisher: 'Alice Maps',
  });
  await assert.rejects(reg.trustPackPublisher('plain-pack', 'x'), /not signed/);
  const st = reg.status({
    state: 'CONNECTED',
    networkOnline: true,
    remoteLive: 0,
    remoteTotal: 0,
    localLive: 0,
    at: '2026-09-21T12:00:00.000Z',
  });
  assert.deepEqual(st.trust, {
    requireTrusted: false,
    publishers: [{ keyId: ALICE.keyId, name: 'Alice Maps', addedAt: '2026-09-21T12:00:00.000Z' }],
  });
  assert.equal(JSON.stringify(st).includes(ALICE.publicKey), false, 'the page is not sent public keys');

  // Only trusted packs from now on: the unsigned pack stops counting, the signed one stays.
  await reg.setRequireTrusted(true);
  assert.equal(reg.get('plain-pack')?.summary.status, 'invalid');
  assert.match(reg.get('plain-pack')?.summary.message ?? '', /trusted publishers/);
  assert.equal(reg.get('hawaii-test')?.summary.status, 'active');
  const refused = await reg.install(unsigned);
  assert.equal(refused.installed, null);
  assert.match(refused.issues.join(';'), /not signed/);

  // A fresh registry reads the same trust.
  const again = registry(dataDir);
  await again.refresh();
  assert.equal(again.trustState().requireTrusted, true);
  assert.equal(again.get('hawaii-test')?.summary.signature?.status, 'trusted');

  // Removing the publisher: its pack no longer passes the requirement.
  assert.equal(await again.removePublisher(ALICE.keyId), true);
  assert.equal(again.get('hawaii-test')?.summary.status, 'invalid');
  // Added back from the key file Alice hands out.
  const key = parsePublisherKeyFile(publisherKeyFile('Alice (from key file)', ALICE.publicKey));
  assert.ok(key.ok);
  await again.addPublisher(key.name, key.publicKey);
  assert.equal(again.get('hawaii-test')?.summary.status, 'active');
  await assert.rejects(again.addPublisher('x', 'AAAA'), /32-byte/);

  // A manifest edited on disk after installation reads as tampered on the next scan.
  const manifestFile = path.join(dataDir, 'worldpacks', 'hawaii-test', 'manifest.json');
  const m = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as { name: string };
  m.name = 'Renamed on disk';
  await fs.writeFile(manifestFile, JSON.stringify(m));
  await again.refresh();
  assert.equal(again.get('hawaii-test')?.summary.status, 'invalid');
  assert.match(again.get('hawaii-test')?.summary.message ?? '', /signature: .*changed after signing/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('no change to the manifest or to the signature file passes as signed by a trusted publisher', () => {
  // Fixed-seed tampering: one or two bytes of the manifest changed, added or removed; the
  // signature file changed the same ways, or its fields swapped for another signer's.
  let s = 2026;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const tamper = (good: Uint8Array): Uint8Array => {
    let b = new Uint8Array(good);
    const times = 1 + Math.floor(next() * 2);
    for (let k = 0; k < times; k++) {
      const at = Math.floor(next() * b.length);
      const roll = next();
      if (roll < 0.6) b[at] = b[at]! ^ (1 << Math.floor(next() * 8));
      else if (roll < 0.8) b = Uint8Array.from([...b.subarray(0, at), Math.floor(next() * 256), ...b.subarray(at)]);
      else b = Uint8Array.from([...b.subarray(0, at), ...b.subarray(at + 1)]);
    }
    return b;
  };
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
  const manifest = new TextEncoder().encode(JSON.stringify(buildTestPack().manifest, null, 2));
  const signature = signManifest(manifest, ALICE.privateKeyPem);
  const publishers = [trusted(ALICE, 'Alice')];
  const good = checkSignature(manifest, signature, publishers);
  assert.ok(good.status === 'signed' && good.trusted && good.publisher === 'Alice');

  let tried = 0;
  for (let i = 0; i < 3000; i++) {
    const changedManifest = tamper(manifest);
    if (same(changedManifest, manifest)) continue;
    tried++;
    const verdict = checkSignature(changedManifest, signature, publishers);
    assert.equal(verdict.status, 'invalid', `a changed manifest read as ${JSON.stringify(verdict)}`);
  }
  for (let i = 0; i < 3000; i++) {
    const changedSignature = tamper(signature);
    if (same(changedSignature, signature)) continue;
    tried++;
    const verdict = checkSignature(manifest, changedSignature, publishers);
    // A change to the file's white space or to nothing the check reads can leave it signed by
    // Alice; anything else is invalid. It is never signed by, or trusted as, anyone else.
    if (verdict.status === 'signed') {
      assert.equal(verdict.keyId, ALICE.keyId, `signed by ${verdict.keyId}`);
      assert.equal(verdict.publicKey, ALICE.publicKey);
    } else assert.ok(verdict.status === 'invalid', JSON.stringify(verdict));
  }
  // Bob's signature under Alice's name, and Alice's signature claimed with Bob's key.
  const bobs = JSON.parse(new TextDecoder().decode(signManifest(manifest, BOB.privateKeyPem))) as Record<
    string,
    unknown
  >;
  const alices = JSON.parse(new TextDecoder().decode(signature)) as Record<string, unknown>;
  for (const key of Object.keys(alices))
    for (const swap of [
      { ...alices, [key]: bobs[key] },
      { ...bobs, [key]: alices[key] },
    ]) {
      const verdict = checkSignature(manifest, new TextEncoder().encode(JSON.stringify(swap)), publishers);
      const isAlices = JSON.stringify(swap) === JSON.stringify(alices);
      const isBobs = JSON.stringify(swap) === JSON.stringify(bobs);
      if (verdict.status === 'signed') {
        assert.ok(isAlices || isBobs || verdict.keyId === ALICE.keyId || verdict.keyId === BOB.keyId);
        assert.equal(
          verdict.trusted,
          verdict.keyId === ALICE.keyId,
          `trusted wrongly: ${JSON.stringify(verdict)} from ${key}`,
        );
        // What is signed is checked against the key it names: a mixture verifies only if it is whole.
        assert.ok(isAlices || isBobs || bobs[key] === alices[key], `a mixture of two signatures verified (${key})`);
      }
    }
  assert.ok(tried > 5000, `${tried} tamperings tried`);
});
