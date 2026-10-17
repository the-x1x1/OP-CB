import { parentPort } from 'node:worker_threads';
import { readGeodata } from '@worldview/runtime/geodata';

/**
 * The dropped-file reader's thread (geodata-reader.ts): one file in, its shapes out, so the
 * main process — and with it every window — keeps going while a large file is parsed.
 * Nothing here touches the network or the disk; it reads only the bytes it is handed.
 */
parentPort?.on('message', (message: { name?: unknown; bytes?: unknown }) => {
  const name = typeof message?.name === 'string' ? message.name : '';
  const bytes = message?.bytes instanceof Uint8Array ? message.bytes : new Uint8Array(0);
  try {
    parentPort?.postMessage({ read: readGeodata(name, bytes) });
  } catch (err) {
    parentPort?.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
});
