import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WorldRuntimeDeps } from '@opcb/runtime';

type GeodataReader = NonNullable<WorldRuntimeDeps['geodataReader']>;
type GeodataRead = Awaited<ReturnType<GeodataReader>>;

/**
 * Longer than any file under the 25 MB cap takes (2.4 s measured for 24 MB); past it the worker
 * is stopped. Under the IPC request's own 60 s, so the operator reads "not read within" rather
 * than a timed-out request.
 */
export const GEODATA_WORKER_TIMEOUT_MS = 45_000;

/** The worker's own heap: a hostile file runs it out of memory, not the main process. */
export const GEODATA_WORKER_HEAP_MB = 1024;

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
 * It rejects only when the worker never ran (no script, failed before it came online): the
 * runtime then reads the file in-process (RuntimeCore.readGeodataFile). Once it ran, whatever
 * happens is the file's answer — a time limit, a crash, running out of memory — so a file that
 * defeated the worker is not parsed again on the main thread.
 */
export function geodataWorkerReader(
  workerPath: string,
  options: { timeoutMs?: number; createWorker?: (file: string) => Worker } = {},
): GeodataReader {
  const create =
    options.createWorker ??
    ((file: string) => new Worker(file, { resourceLimits: { maxOldGenerationSizeMb: GEODATA_WORKER_HEAP_MB } }));
  const timeoutMs = options.timeoutMs ?? GEODATA_WORKER_TIMEOUT_MS;
  const unread = (why: string): GeodataRead => ({ features: [], issues: [`could not be read: ${why}`] });
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
      let online = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        fn();
      };
      // Before it is ready a failure is the worker's (read in-process instead); after, the file's.
      const failed = (why: string, err?: unknown) =>
        finish(() => (online ? resolve(unread(why)) : reject(err instanceof Error ? err : new Error(why))));
      const timer = setTimeout(() => failed(`not read within ${timeoutMs / 1000} s`), timeoutMs);
      // The script says it is loaded ({ ready }) before anything else: Node's own 'online' comes
      // before the script is loaded, so a missing script would read as the file's failure.
      worker.on('message', (m: { ready?: boolean; read?: GeodataRead; error?: string }) => {
        if (m?.ready) {
          online = true;
          // The file goes over only now, so any failure from here is surely the file's: a
          // worker's error can otherwise arrive before its "ready" (seen on Windows, Node 24).
          try {
            const copy = bytes.slice();
            worker.postMessage({ name, bytes: copy }, [copy.buffer]);
          } catch (err) {
            failed(err instanceof Error ? err.message : String(err), err);
          }
          return;
        }
        finish(() => resolve(m?.read ?? unread(m?.error ?? 'no answer from the reader')));
      });
      worker.once('error', (err) => failed(err instanceof Error ? err.message : String(err), err));
      worker.once('exit', (code) => failed(`the reader stopped (exit ${code})`));
    });
}
