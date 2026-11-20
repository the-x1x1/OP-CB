import { CameraError } from './errors.js';

/**
 * Frame validation by magic bytes. The gateway never trusts an upstream
 * Content-Type: a login page served as `image/jpeg` is still HTML.
 */
export type FrameMimeType = 'image/jpeg' | 'image/png';

export function detectImageType(bytes: Uint8Array): FrameMimeType | undefined {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return 'image/png';
  return undefined;
}

export function assertImage(bytes: Uint8Array): FrameMimeType {
  const type = detectImageType(bytes);
  if (!type)
    throw new CameraError('NOT_AN_IMAGE', `upstream body is not a JPEG or PNG image (${bytes.byteLength} bytes)`, {
      retryable: false,
    });
  return type;
}

/**
 * Extract the first complete JPEG frame from an MJPEG byte stream: bytes between
 * the first SOI marker (FF D8) and the following EOI marker (FF D9). Stops reading
 * as soon as a frame is complete or `maxBytes` has been consumed.
 */
export async function firstJpegFrame(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  // One buffer that grows by doubling. Joining every chunk received so far each time one
  // arrived copied the whole frame once per chunk: a megabyte frame in 1 kB chunks was half
  // a gigabyte of copying.
  let buf = new Uint8Array(64 * 1024);
  let total = 0;
  let start = -1;
  let scanFrom = 0;
  for await (const chunk of body) {
    if (total + chunk.byteLength > maxBytes)
      throw new CameraError('TOO_LARGE', `no complete MJPEG frame within ${maxBytes} bytes`, { retryable: false });
    if (total + chunk.byteLength > buf.byteLength) {
      const grown = new Uint8Array(Math.max(buf.byteLength * 2, total + chunk.byteLength));
      grown.set(buf.subarray(0, total));
      buf = grown;
    }
    buf.set(chunk, total);
    total += chunk.byteLength;
    const seen = buf.subarray(0, total);
    if (start < 0) {
      const soi = indexOfMarker(seen, 0xd8, scanFrom);
      if (soi < 0) {
        scanFrom = Math.max(0, total - 1);
        continue;
      }
      start = soi;
      scanFrom = soi + 2;
    }
    const eoi = indexOfMarker(seen, 0xd9, scanFrom);
    if (eoi >= 0) return seen.slice(start, eoi + 2);
    scanFrom = Math.max(start + 2, total - 1);
  }
  throw new CameraError('NOT_AN_IMAGE', 'MJPEG stream ended before a complete frame', { retryable: true });
}

function indexOfMarker(buf: Uint8Array, second: number, from: number): number {
  for (let i = from; i + 1 < buf.byteLength; i++) if (buf[i] === 0xff && buf[i + 1] === second) return i;
  return -1;
}
