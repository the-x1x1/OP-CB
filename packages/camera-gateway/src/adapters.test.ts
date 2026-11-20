import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraError, errorForStatus, toCameraError } from './errors.js';
import { createFetchByteFetcher, createFetchUpstreamOpener } from './fetch-adapters.js';
import { looksLikePlaylist } from './hls.js';
import { assertImage, firstJpegFrame } from './image.js';
import { HTML_BYTES, JPEG_BYTES, PNG_BYTES } from './testing.js';
import { basicAuthHeader, cameraIdFor, credentialKeyFor, isCameraId, isLoopbackHost } from './url.js';

test('toCameraError: a camera error is itself; timeouts, aborts and network faults get their codes', () => {
  const own = new CameraError('NOT_FOUND', 'no such camera');
  assert.equal(toCameraError(own), own);
  const named = (name: string, message = 'x') => Object.assign(new Error(message), { name });
  assert.equal(toCameraError(named('TimeoutError')).code, 'TIMEOUT');
  assert.equal(toCameraError(named('AbortError')).code, 'CANCELLED');
  assert.equal(toCameraError(new Error('The operation timed out')).code, 'TIMEOUT');
  for (const text of [
    'getaddrinfo ENOTFOUND cam.local',
    'connect ECONNREFUSED 10.0.0.2:80',
    'fetch failed',
    'read ECONNRESET',
  ])
    assert.equal(toCameraError(new Error(text)).code, 'NETWORK', text);
  assert.equal(toCameraError(new Error('fetch failed', { cause: new Error('connect EHOSTUNREACH') })).code, 'NETWORK');
  assert.equal(toCameraError(new Error('something else')).code, 'INTERNAL');
  assert.equal(toCameraError('a string').code, 'INTERNAL');
  assert.equal(toCameraError(undefined).code, 'INTERNAL');
  assert.equal(toCameraError(null).message, 'null');
});

test('a camera error never carries a credential, and its message is bounded', () => {
  const leaky = new Error(
    `connect ECONNREFUSED http://admin:hunter2@10.0.0.2/snap?token=SECRETTOKEN ${'x'.repeat(500)}`,
  );
  const e = toCameraError(leaky);
  assert.ok(!e.message.includes('hunter2') && !e.message.includes('SECRETTOKEN'), e.message);
  assert.ok(e.message.length <= 200);
  const direct = new CameraError('UPSTREAM_ERROR', 'GET rtsp://user:pass@cam/stream failed');
  assert.ok(!direct.message.includes('user:pass'));
  assert.deepEqual(Object.keys(direct.toInfo()), ['code', 'message']);
  assert.equal(new CameraError('UPSTREAM_ERROR', 'x', { httpStatus: 502 }).toInfo().httpStatus, 502);
});

test('errorForStatus: 2xx is fine; every other status is an error with its own retry answer', () => {
  for (const ok of [200, 204, 206, 299]) assert.equal(errorForStatus(ok), undefined, String(ok));
  const table: Array<[number, string, boolean]> = [
    [301, 'UPSTREAM_ERROR', false],
    [302, 'UPSTREAM_ERROR', false],
    [401, 'UPSTREAM_REFUSED', false],
    [403, 'UPSTREAM_REFUSED', false],
    [404, 'UPSTREAM_ERROR', false],
    [418, 'UPSTREAM_ERROR', false],
    [429, 'UPSTREAM_ERROR', true],
    [500, 'UPSTREAM_ERROR', true],
    [503, 'UPSTREAM_ERROR', true],
    [100, 'UPSTREAM_ERROR', false],
  ];
  for (const [status, code, retryable] of table) {
    const e = errorForStatus(status)!;
    assert.equal(e.code, code, String(status));
    assert.equal(e.retryable, retryable, String(status));
    assert.equal(e.httpStatus, status);
  }
});

test('retryable and ipcCode follow the code', () => {
  const retry = (code: ConstructorParameters<typeof CameraError>[0]) => new CameraError(code, 'x').retryable;
  for (const code of ['TIMEOUT', 'NETWORK', 'UPSTREAM_ERROR', 'UNAVAILABLE'] as const)
    assert.equal(retry(code), true, code);
  for (const code of [
    'INVALID_URL',
    'UNSUPPORTED_SCHEME',
    'NOT_FOUND',
    'TOO_LARGE',
    'NOT_AN_IMAGE',
    'CANCELLED',
    'INTERNAL',
  ] as const)
    assert.equal(retry(code), false, code);
  assert.equal(new CameraError('TIMEOUT', 'x', { retryable: false }).retryable, false);
  const ipc = (code: ConstructorParameters<typeof CameraError>[0]) => new CameraError(code, 'x').ipcCode;
  assert.equal(ipc('INVALID_URL'), 'INVALID_REQUEST');
  assert.equal(ipc('UNSUPPORTED'), 'INVALID_REQUEST');
  assert.equal(ipc('NOT_FOUND'), 'NOT_FOUND');
  assert.equal(ipc('CANCELLED'), 'CANCELLED');
  assert.equal(ipc('INTERNAL'), 'INTERNAL');
  assert.equal(ipc('TIMEOUT'), 'UNAVAILABLE');
  assert.equal(ipc('NOT_AN_IMAGE'), 'UNAVAILABLE');
});

test('camera ids, credential keys, the Basic header and loopback hosts', () => {
  const id = cameraIdFor('http://192.168.1.10/snap.jpg');
  assert.equal(isCameraId(id), true);
  assert.equal(cameraIdFor('http://192.168.1.10/snap.jpg'), id);
  assert.notEqual(cameraIdFor('http://192.168.1.11/snap.jpg'), id);
  for (const bad of ['', 'ABCDEF012345', 'abcdef01234', 'abcdef0123456', 'abcdef01234g', '../abcdef0123', `${id}\n`])
    assert.equal(isCameraId(bad), false, JSON.stringify(bad));
  assert.equal(credentialKeyFor(id), `camera.${id}.credential`);
  assert.equal(basicAuthHeader('Aladdin:open sesame'), 'Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==');
  assert.equal(basicAuthHeader('user:pässwörd'), `Basic ${Buffer.from('user:pässwörd', 'utf8').toString('base64')}`);
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.5.5.5', '::1', '[::1]'])
    assert.equal(isLoopbackHost(host), true, host);
  for (const host of ['192.168.1.1', '1127.0.0.1', 'localhost.example.com', '::2', 'cam.local'])
    assert.equal(isLoopbackHost(host), false, host);
});

test('looksLikePlaylist: by content type or by the path ending .m3u8, never by the query', () => {
  assert.equal(looksLikePlaylist('http://cam/live', 'application/vnd.apple.mpegurl'), true);
  assert.equal(looksLikePlaylist('http://cam/live', 'audio/x-mpegURL; charset=utf-8'), true);
  assert.equal(looksLikePlaylist('http://cam/live/index.M3U8?token=1', undefined), true);
  assert.equal(looksLikePlaylist('http://cam/segment.ts?next=index.m3u8', 'video/mp2t'), false);
  assert.equal(looksLikePlaylist('http://cam/live', undefined), false);
  assert.equal(looksLikePlaylist('not a url', undefined), false);
  assert.equal(looksLikePlaylist('', ''), false);
});

test('assertImage: JPEG and PNG by their first bytes; anything else is refused whatever it claims to be', () => {
  assert.equal(assertImage(JPEG_BYTES), 'image/jpeg');
  assert.equal(assertImage(PNG_BYTES), 'image/png');
  for (const bytes of [
    HTML_BYTES,
    new Uint8Array(),
    new Uint8Array([0xff, 0xd8]),
    PNG_BYTES.subarray(0, 7),
    new TextEncoder().encode('GIF89a'),
  ])
    assert.throws(
      () => assertImage(bytes),
      (e: unknown) => e instanceof CameraError && e.code === 'NOT_AN_IMAGE' && e.retryable === false,
    );
});

test('firstJpegFrame: the same frame however the stream is cut into chunks', async () => {
  let seed = 5;
  const random = () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  // A frame of 150 kB with no marker bytes inside it, between multipart headers.
  const frame = new Uint8Array(150_000).fill(0x55);
  frame.set([0xff, 0xd8, 0xff, 0xe0], 0);
  frame.set([0xff, 0xd9], frame.length - 2);
  const head = new TextEncoder().encode('--frame\r\nContent-Type: image/jpeg\r\n\r\n');
  const all = new Uint8Array(head.length + frame.length + head.length + 50);
  all.set(head, 0);
  all.set(frame, head.length);
  all.set(head, head.length + frame.length);
  for (const size of [1, 2, 3, 7, 1000, 65_536, 65_537, all.length]) {
    const chunks = async function* (): AsyncGenerator<Uint8Array> {
      let i = 0;
      while (i < all.length) {
        const n = size === 7 ? 1 + Math.floor(random() * 5000) : size;
        yield all.subarray(i, i + n);
        i += n;
      }
    };
    const got = await firstJpegFrame(chunks(), 1024 * 1024);
    assert.equal(got.length, frame.length, `chunk size ${size}`);
    assert.ok(Buffer.from(got).equals(Buffer.from(frame)), `chunk size ${size}`);
  }
  // The frame returned is a copy, not a view of a buffer that is reused.
  const one = await firstJpegFrame(
    (async function* () {
      yield all;
    })(),
    1024 * 1024,
  );
  assert.equal(one.byteOffset, 0);
  assert.equal(one.buffer.byteLength, frame.length);
});

test('firstJpegFrame: a stream that ends early, or is larger than allowed, is an error', async () => {
  const start = new Uint8Array([0x00, 0xff, 0xd8, 0xff, 0x01, 0x02]);
  await assert.rejects(
    firstJpegFrame(
      (async function* () {
        yield start;
      })(),
      1000,
    ),
    (e: unknown) => e instanceof CameraError && e.code === 'NOT_AN_IMAGE' && e.retryable,
  );
  await assert.rejects(
    firstJpegFrame((async function* () {})(), 1000),
    (e: unknown) => e instanceof CameraError && e.code === 'NOT_AN_IMAGE',
  );
  // Exactly the limit is allowed; one byte more is not.
  const exact = new Uint8Array(100).fill(1);
  exact.set([0xff, 0xd8], 0);
  exact.set([0xff, 0xd9], 98);
  const whole = async function* () {
    yield exact;
  };
  assert.equal((await firstJpegFrame(whole(), 100)).length, 100);
  await assert.rejects(firstJpegFrame(whole(), 99), (e: unknown) => e instanceof CameraError && e.code === 'TOO_LARGE');
  // A marker split across two chunks is still found.
  const split = async function* () {
    yield new Uint8Array([9, 9, 0xff]);
    yield new Uint8Array([0xd8, 1, 2, 0xff]);
    yield new Uint8Array([0xd9, 9]);
  };
  assert.deepEqual([...(await firstJpegFrame(split(), 100))], [0xff, 0xd8, 1, 2, 0xff, 0xd9]);
});

// ---- the fetch adapters, over a stand-in fetch ------------------------------------------

function streamOf(chunks: Uint8Array[], onPull?: (i: number) => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.(i);
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
  });
}

const never = new AbortController().signal;

test('byte fetcher: sends a plain GET that follows no redirect, and returns status, lower-case headers and the body', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = createFetchByteFetcher(((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(streamOf([JPEG_BYTES.subarray(0, 5), JPEG_BYTES.subarray(5)]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    );
  }) as never);
  const res = await fetcher('http://cam/snap.jpg', {
    timeoutMs: 1000,
    maxBytes: 10_000,
    headers: { authorization: 'Basic eA==' },
    signal: never,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.deepEqual([...res.bytes], [...JPEG_BYTES]);
  assert.equal(calls[0]!.init.redirect, 'manual');
  assert.equal(calls[0]!.init.method, 'GET');
  assert.deepEqual(calls[0]!.init.headers, { authorization: 'Basic eA==' });
});

test('byte fetcher: a status outside 2xx comes back with no body read', async () => {
  let pulled = 0;
  const fetcher = createFetchByteFetcher((() =>
    Promise.resolve(
      new Response(
        streamOf([HTML_BYTES], () => pulled++),
        { status: 302, headers: { location: 'http://elsewhere/' } },
      ),
    )) as never);
  const res = await fetcher('http://cam/snap.jpg', { timeoutMs: 1000, maxBytes: 10_000, signal: never });
  assert.equal(res.status, 302);
  assert.equal(res.headers['location'], 'http://elsewhere/');
  assert.equal(res.bytes.byteLength, 0);
});

test('byte fetcher: more than the limit is refused, by the declared length or by what arrives', async () => {
  const big = new Uint8Array(600).fill(7);
  const declared = createFetchByteFetcher((() =>
    Promise.resolve(new Response(streamOf([big]), { status: 200, headers: { 'content-length': '600' } }))) as never);
  await assert.rejects(
    declared('http://cam/a', { timeoutMs: 1000, maxBytes: 500, signal: never }),
    (e: unknown) => e instanceof CameraError && e.code === 'TOO_LARGE' && /content-length 600/.test(e.message),
  );
  const undeclared = createFetchByteFetcher((() =>
    Promise.resolve(new Response(streamOf([big.subarray(0, 300), big.subarray(300)]), { status: 200 }))) as never);
  await assert.rejects(
    undeclared('http://cam/a', { timeoutMs: 1000, maxBytes: 500, signal: never }),
    (e: unknown) => e instanceof CameraError && e.code === 'TOO_LARGE',
  );
  const exact = createFetchByteFetcher((() =>
    Promise.resolve(new Response(streamOf([big]), { status: 200 }))) as never);
  assert.equal((await exact('http://cam/a', { timeoutMs: 1000, maxBytes: 600, signal: never })).bytes.byteLength, 600);
  const empty = createFetchByteFetcher((() => Promise.resolve(new Response(null, { status: 204 }))) as never);
  assert.equal((await empty('http://cam/a', { timeoutMs: 1000, maxBytes: 600, signal: never })).bytes.byteLength, 0);
});

test('byte fetcher: a failure, a timeout and a cancel each come back as their camera error', async () => {
  const failing = createFetchByteFetcher((() => Promise.reject(new TypeError('fetch failed'))) as never);
  await assert.rejects(
    failing('http://cam/a', { timeoutMs: 1000, maxBytes: 600, signal: never }),
    (e: unknown) => e instanceof CameraError && e.code === 'NETWORK',
  );
  const hanging = createFetchByteFetcher(
    ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      })) as never,
  );
  await assert.rejects(
    hanging('http://cam/a', { timeoutMs: 20, maxBytes: 600, signal: never }),
    (e: unknown) => e instanceof CameraError && e.code === 'TIMEOUT',
  );
  const controller = new AbortController();
  const pending = hanging('http://cam/a', { timeoutMs: 5000, maxBytes: 600, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e: unknown) => e instanceof CameraError && e.code === 'CANCELLED');
});

test('byte fetcher: a body cut short by the timeout is an error, never a shorter body', async () => {
  // The first chunk arrives; the second never does.
  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(JPEG_BYTES.subarray(0, 4));
    },
  });
  const fetcher = createFetchByteFetcher((() => Promise.resolve(new Response(stalled, { status: 200 }))) as never);
  const started = Date.now();
  await assert.rejects(
    Promise.race([
      fetcher('http://cam/a', { timeoutMs: 30, maxBytes: 600, signal: never }),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('still waiting after a second')), 1000)),
    ]),
    (e: unknown) => e instanceof CameraError && (e.code === 'TIMEOUT' || e.code === 'CANCELLED'),
  );
  assert.ok(Date.now() - started < 900);
});

test('upstream opener: hands back status, headers and the body as it arrives; cancel never throws', async () => {
  const opener = createFetchUpstreamOpener(((_url: string, init: RequestInit) => {
    assert.equal(init.redirect, 'manual');
    return Promise.resolve(
      new Response(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]), {
        status: 200,
        headers: { 'Content-Type': 'multipart/x-mixed-replace' },
      }),
    );
  }) as never);
  const stream = await opener('http://cam/mjpeg', { timeoutMs: 1000, signal: never });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers['content-type'], 'multipart/x-mixed-replace');
  const got: number[] = [];
  for await (const chunk of stream.body) got.push(...chunk);
  assert.deepEqual(got, [1, 2, 3]);
  assert.doesNotThrow(() => stream.cancel());
  assert.doesNotThrow(() => stream.cancel());

  const bodiless = createFetchUpstreamOpener((() => Promise.resolve(new Response(null, { status: 204 }))) as never);
  const none = await bodiless('http://cam/x', { timeoutMs: 1000, signal: never });
  let chunks = 0;
  for await (const _ of none.body) chunks++;
  assert.equal(chunks, 0);
  assert.doesNotThrow(() => none.cancel());

  const failing = createFetchUpstreamOpener((() => Promise.reject(new TypeError('fetch failed'))) as never);
  await assert.rejects(
    failing('http://cam/x', { timeoutMs: 1000, signal: never }),
    (e: unknown) => e instanceof CameraError && e.code === 'NETWORK',
  );
});

test('upstream opener: the body stops when the caller aborts', async () => {
  const controller = new AbortController();
  let sent = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(c) {
      sent++;
      c.enqueue(new Uint8Array([sent]));
    },
  });
  const opener = createFetchUpstreamOpener((() => Promise.resolve(new Response(endless, { status: 200 }))) as never);
  const stream = await opener('http://cam/mjpeg', { timeoutMs: 1000, signal: controller.signal });
  let read = 0;
  for await (const _ of stream.body) {
    if (++read === 3) controller.abort();
    assert.ok(read < 10, 'kept reading after the abort');
  }
  assert.equal(read, 3);
});
