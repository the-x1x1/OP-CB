import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraHub } from './hub.js';
import { DirectGateway } from './direct-gateway.js';
import { MemorySecretStore } from './secret-store.js';
import { PublicFrameRegistry } from './public-frames.js';
import { fakeByteFetcher, JPEG_BYTES } from './testing.js';

/**
 * A camera with a login waits for the secure store before it is listed. Removing it, or
 * registering it again without the login, while that wait is on must not be undone when the
 * wait ends: the last thing asked is what is kept, and no login is left behind for a camera
 * that is gone.
 */
class SlowSecrets extends MemorySecretStore {
  held: Array<() => void> = [];
  hold = false;
  override async set(key: string, value: string): Promise<void> {
    if (this.hold) await new Promise<void>((r) => this.held.push(r));
    await super.set(key, value);
  }
}

function setup() {
  const secrets = new SlowSecrets();
  const fetchBytes = fakeByteFetcher(() => ({
    status: 200,
    bytes: JPEG_BYTES,
    headers: { 'content-type': 'image/jpeg' },
  }));
  const direct = new DirectGateway({ fetchBytes, secrets });
  const hub = new CameraHub({ direct, publicFrames: new PublicFrameRegistry(), fetchBytes });
  return { hub, secrets };
}

const withLogin = { name: 'Gate', url: 'http://admin:s3cret@192.168.1.20/snap.jpg' };
const withoutLogin = { name: 'Gate again', url: 'http://192.168.1.20/snap.jpg' };

test('cameras: removed while its registration waited for the secure store: it stays removed', async () => {
  const { hub, secrets } = setup();
  const { cameraId } = await hub.register(withoutLogin);
  secrets.hold = true;
  // Its address edited to carry a login: that registration waits for the secure store...
  const registering = hub.register(withLogin);
  await new Promise((r) => setImmediate(r));
  // ...and the camera is removed meanwhile.
  const removing = hub.unregister(cameraId);
  await new Promise((r) => setImmediate(r));
  for (const release of secrets.held.splice(0)) release();
  await registering;
  await removing;
  assert.deepEqual(
    (await hub.list()).map((c) => c.cameraId),
    [],
    'the camera removed last is not in the list',
  );
  assert.deepEqual(secrets.keys(), [], 'and no login is kept for it');
});

test('cameras: registered again without the login while the first waited: the second is what is kept', async () => {
  const { hub, secrets } = setup();
  secrets.hold = true;
  const first = hub.register(withLogin);
  await new Promise((r) => setImmediate(r));
  const second = hub.register(withoutLogin);
  await new Promise((r) => setImmediate(r));
  for (const release of secrets.held.splice(0)) release();
  await first;
  await second;
  const list = await hub.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, 'Gate again', 'the registration asked last is the one kept');
  assert.deepEqual(secrets.keys(), [], 'its login was dropped with it');
});
