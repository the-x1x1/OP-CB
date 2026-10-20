/**
 * When world deltas reached the renderer's handler, so that a long main-thread task can be
 * attributed.
 *
 * The perf log showed a ~125 ms task in every window with a satellite refresh, while the
 * two pieces of that work this code times — presentation and handing features to the
 * renderer — came to under 10 ms each. The rest happens where no timer of ours runs: a
 * delta is deserialised from IPC and copied across the context bridge before the handler
 * is ever called, and React renders the shell in a task of its own afterwards. A long task
 * that contains a delta's arrival spent the part before it receiving the message and the
 * part after it handling it; a long task that contains none is something else.
 */
export interface DeltaMark {
  at: number;
  objects: number;
}

export type LongTaskAttribution =
  | {
      kind: 'delta';
      objects: number;
      /** Before the handler ran: IPC deserialisation and the bridge copy. */
      receiveMs: number;
    }
  | { kind: 'other' };

const KEPT = 16;
const marks: DeltaMark[] = [];

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Called as world data reaches the page: each world.changed delta, and each world.subscribe snapshot. */
export function markDelta(objects: number, at: number = clock()): void {
  marks.push({ at, objects });
  if (marks.length > KEPT) marks.shift();
}

export function attributeLongTask(task: { startTime: number; duration: number }): LongTaskAttribution {
  const end = task.startTime + task.duration;
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i]!;
    if (m.at >= task.startTime && m.at <= end)
      return { kind: 'delta', objects: m.objects, receiveMs: m.at - task.startTime };
  }
  return { kind: 'other' };
}

let decodeMaxMs = 0;

/** How long the page took to parse an event sent as JSON (wire-client.ts). */
export function noteDecode(ms: number): void {
  decodeMaxMs = Math.max(decodeMaxMs, ms);
}

/** The longest parse since the last call — one perf window's worth. */
export function takeDecodeMax(): number {
  const ms = decodeMaxMs;
  decodeMaxMs = 0;
  return ms;
}

let dispatchedAt: number | undefined;
let renderMaxMs = 0;

/**
 * A world change was handed to the store (store/sync.ts): the shell renders it next. With
 * `noteShellCommit`, the time from there to React's commit — the shell's own render of a
 * delta, the part no other timer here covers.
 */
export function noteWorldDispatch(at: number = clock()): void {
  dispatchedAt ??= at;
}

/**
 * Where the shell's render of a world change went: each part of the shell (shell.tsx) marks
 * when React reaches it, so the time between two marks is the part before rendering. Kept for
 * the slowest commit of the window, as "top:2 lens:30 map:4 ctx:55 time:3 end:6".
 */
let renderMarks: Array<[string, number]> = [];
let slowestParts = '';

/** React reached this part of the shell (a mark rendered just before it). */
export function noteRenderMark(name: string, at: number = clock()): void {
  if (dispatchedAt === undefined) return;
  renderMarks.push([name, at]);
}

/** The shell committed (shell.tsx, a layout effect after every commit). */
export function noteShellCommit(at: number = clock()): void {
  const marks = renderMarks;
  renderMarks = [];
  if (dispatchedAt === undefined) return;
  const took = at - dispatchedAt;
  if (took >= renderMaxMs && marks.length) {
    const parts: string[] = [];
    let before = dispatchedAt;
    let label = 'wait';
    for (const [name, t] of marks) {
      parts.push(`${label}:${Math.round(t - before)}`);
      label = name;
      before = t;
    }
    parts.push(`${label}:${Math.round(at - before)}`);
    slowestParts = parts.join(' ').slice(0, 40);
  }
  renderMaxMs = Math.max(renderMaxMs, took);
  dispatchedAt = undefined;
}

/** The longest dispatch-to-commit since the last call — one perf window's worth. */
export function takeRenderMax(): number {
  const ms = renderMaxMs;
  renderMaxMs = 0;
  return ms;
}

/** The parts of that slowest commit (see `noteRenderMark`); empty when there was none. */
export function takeRenderParts(): string {
  const p = slowestParts;
  slowestParts = '';
  return p;
}

/** Tests only. */
export function clearDeltaMarks(): void {
  dispatchedAt = undefined;
  renderMaxMs = 0;
  renderMarks = [];
  slowestParts = '';
  marks.length = 0;
  decodeMaxMs = 0;
}
