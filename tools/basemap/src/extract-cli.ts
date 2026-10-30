#!/usr/bin/env node
/**
 * pnpm basemap:extract --world-zoom <0-10> [--zoom <z> --bbox w,s,e,n] [--build <key>] [--out <file.pmtiles>] [--plan-only]
 *
 * The app's map download, from the command line: the newest (or a named) Protomaps daily build,
 * read by byte ranges, cut to the whole world down to --world-zoom (and, with --bbox, more
 * detail there down to --zoom), written as a PMTiles file. --plan-only reads the build's index
 * and prints the exact size without downloading tiles — how the size of a world map to ship
 * with the installer is measured. Map data: ODbL, © OpenStreetMap contributors.
 */
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import {
  PROTOMAPS_BUILD_BASE,
  PROTOMAPS_BUILDS_LIST,
  httpRangeSource,
  planExtract,
  readBuildList,
  selectionProblem,
  verifyArchive,
  writeExtract,
  type ExtractSelection,
} from '@worldview/offline';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const worldZoom = Number(arg('world-zoom') ?? NaN);
  if (!Number.isInteger(worldZoom)) {
    console.error(
      'usage: pnpm basemap:extract --world-zoom <0-10> [--zoom <z> --bbox w,s,e,n] [--build <key>] [--out <file>] [--plan-only]',
    );
    return 2;
  }
  const bbox = arg('bbox')?.split(',').map(Number);
  const sel: ExtractSelection = {
    worldMaxZoom: worldZoom,
    maxZoom: bbox ? Number(arg('zoom') ?? worldZoom) : worldZoom,
    ...(bbox && bbox.length === 4
      ? { bounds: { west: bbox[0]!, south: bbox[1]!, east: bbox[2]!, north: bbox[3]! } }
      : {}),
  };
  const problem = selectionProblem(sel);
  if (problem) {
    console.error(problem);
    return 2;
  }
  let key = arg('build');
  if (!key) {
    const res = await fetch(PROTOMAPS_BUILDS_LIST);
    key = readBuildList(await res.json())[0]?.key;
    if (!key) throw new Error('no build listed');
  }
  const src = httpRangeSource(fetch, PROTOMAPS_BUILD_BASE + key);
  const plan = await planExtract(src, sel, {
    onProgress: (p) =>
      process.stderr.write(`\rindex: ${p.directoriesRead} parts, ${(p.directoryBytesRead / 1e6).toFixed(1)} MB   `),
  });
  process.stderr.write('\n');
  console.log(
    JSON.stringify({
      build: key,
      selection: sel,
      tiles: plan.addressedTiles,
      bytes: plan.totalBytes,
      indexBytesRead: plan.directoryBytesRead,
    }),
  );
  if (process.argv.includes('--plan-only')) return 0;
  const out = arg('out') ?? `world-z${worldZoom}-${key}`;
  const stream = createWriteStream(out);
  let done = 0;
  const r = await writeExtract(src, plan, {
    write: async (b) => {
      if (!stream.write(b)) await once(stream, 'drain');
      done += b.length;
      process.stderr.write(`\r${(done / 1e6).toFixed(0)} / ${(plan.totalBytes / 1e6).toFixed(0)} MB   `);
    },
  });
  stream.end();
  await once(stream, 'finish');
  process.stderr.write('\n');
  const { open } = await import('node:fs/promises');
  const fh = await open(out, 'r');
  const problemAfter = await verifyArchive(
    {
      read: async (o, l) => {
        const b = new Uint8Array(l);
        const { bytesRead } = await fh.read(b, 0, l, o);
        return b.subarray(0, bytesRead);
      },
    },
    r.bytes,
  );
  await fh.close();
  if (problemAfter) throw new Error(problemAfter);
  console.log(JSON.stringify({ out, bytes: r.bytes, sha256: r.sha256 }));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
