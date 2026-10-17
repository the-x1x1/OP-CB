import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WorldRuntimeDeps } from '@worldview/runtime';

type GeodataReader = NonNullable<WorldRuntimeDeps['geodataReader']>;
type GeodataRead = Awaited<ReturnType<GeodataReader>>;

/** Longer than any file under the 25 MB cap takes; past it the worker is stopped. */
export const GEODATA_WORKER_TIMEOUT_MS = 60_000;

/**
 * The bundled worker (build-main.mjs builds dist/main/geodata-worker.cjs). Inside an asar
 * archive it is read from app.asar.unpacked (electron-builder.yml `asarUnpack`): a worker
 * thread loads its script from a real path.
 */
export function geodataWorkerPath(appDir: string): string {
  return path.join(appDir, 'dist', 'main', 'geodata-worker.cjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

/**
 * A reader that parses each dropped file on its own worker thread, ended when it answers.
 * It rejects only when the worker cannot run (no script, a crash, the time limit): the
 * runtime then reads the file in-process, as before (RuntimeCore.readGeodataFile).
 */
export function geodataWorkerReader(
  workerPath: string,
  options: { timeoutMs?: number; createWorker?: (file: string) => Worker } = {},
): GeodataReader {
  const create = options.createWorker ?? ((file: string) => new Worker(file));
  const timeoutMs = options.timeoutMs ?? GEODATA_WORKER_TIMEOUT_MS;
  return (name, bytes) =>
    new Promise<GeodataRead>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = create(workerPath);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`the file was not read within ${timeoutMs / 1000} s`))),
        timeoutMs,
      );
      worker.once('message', (m: { read?: GeodataRead; error?: string }) =>
        finish(() => (m?.read ? resolve(m.read) : reject(new Error(m?.error ?? 'no answer from the reader')))),
      );
      worker.once('error', (err) => finish(() => reject(err)));
      worker.once('exit', (code) => finish(() => reject(new Error(`the reader stopped (exit ${code})`))));
      const copy = bytes.slice();
      worker.postMessage({ name, bytes: copy }, [copy.buffer]);
    });
}
