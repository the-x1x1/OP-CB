import { inflateRawSync } from 'node:zlib';
import { geometrySchema, type WorldGeometry } from '@opcb/world-model';
import { readGpx, readKml, readTopologyDocument, type FileFeature } from '@opcb/connector-runtime';

/**
 * A file the operator dropped on the map (`geodata.read`): GeoJSON, TopoJSON, KML, KMZ or GPX,
 * read into plain shapes the shell draws for the session and nothing else. Only geometry and
 * a name are kept: nothing in the file is followed or fetched (a KML NetworkLink, a remote
 * icon, a ground overlay, balloon HTML — the readers report and skip them), so a file cannot
 * make the app reach the network, and nothing is stored or sent to a source.
 *
 * KMZ is a zip; its first `.kml` (`doc.kml` when there is one) is read, with Node's own
 * inflate — no dependency — and an uncompressed-size limit against a zip bomb.
 */
export const GEODATA_MAX_BYTES = 25 * 1024 * 1024;
export const GEODATA_MAX_FEATURES = 20_000;
/** Coordinates in all of a file's shapes, at most. */
export const GEODATA_MAX_COORDINATES = 1_000_000;
/**
 * The KML inside a KMZ, unpacked, at most: the same as a plain file. A KMZ compresses repeated
 * placemarks some 500 to 1; at 64 MB, a 134 KB file took the main process 5 s and 1 GB.
 */
const KMZ_MAX_UNCOMPRESSED = GEODATA_MAX_BYTES;

export type GeodataFormat = 'geojson' | 'topojson' | 'kml' | 'kmz' | 'gpx';

export interface GeodataFeature {
  geometry: WorldGeometry;
  name?: string;
}

export interface GeodataRead {
  format?: GeodataFormat;
  features: GeodataFeature[];
  /** What was left out or could not be read, for the operator. */
  issues: string[];
}

/** The format a file name says, or undefined. */
export function geodataFormatOf(name: string): GeodataFormat | 'json' | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase();
  switch (ext) {
    case 'geojson':
      return 'geojson';
    case 'topojson':
      return 'topojson';
    case 'json':
      return 'json';
    case 'kml':
      return 'kml';
    case 'kmz':
      return 'kmz';
    case 'gpx':
      return 'gpx';
    default:
      return undefined;
  }
}

export function readGeodata(name: string, bytes: Uint8Array): GeodataRead {
  const asked = geodataFormatOf(name);
  if (!asked) return { features: [], issues: ['not a GeoJSON, TopoJSON, KML, KMZ or GPX file (by its name)'] };
  if (bytes.byteLength > GEODATA_MAX_BYTES)
    return { features: [], issues: [`larger than ${GEODATA_MAX_BYTES / 1024 / 1024} MB`] };
  let format: GeodataFormat = asked === 'json' ? 'geojson' : asked;
  let text: string;
  if (asked === 'kmz') {
    const kml = kmlInKmz(bytes);
    if ('error' in kml) return { format: 'kmz', features: [], issues: [kml.error] };
    text = kml.text;
  } else text = new TextDecoder('utf-8').decode(bytes);

  let read: { features: FileFeature[]; notes: string[]; skipped: Array<{ reason: string }> } | { malformed: string };
  if (format === 'kml' || format === 'kmz') read = readKml(text);
  else if (format === 'gpx') read = readGpx(text);
  else {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return { format, features: [], issues: ['not valid JSON'] };
    }
    const type = (doc as { type?: unknown } | null)?.type;
    if (type === 'Topology') {
      format = 'topojson';
      read = readTopologyDocument(doc);
    } else if (asked === 'topojson') return { format, features: [], issues: ['not TopoJSON'] };
    else read = geoJsonFeatures(doc, type);
  }
  if ('malformed' in read) return { format, features: [], issues: [read.malformed] };

  const issues: string[] = [...read.notes];
  if (read.skipped.length) issues.push(`${read.skipped.length} element(s) could not be read`);
  const features: GeodataFeature[] = [];
  let coordinates = 0;
  let noShape = 0;
  let dropped = 0;
  let droppedForCoordinates = 0;
  for (const f of read.features) {
    if (!f.geometry) {
      noShape++;
      continue;
    }
    // Past the shape limit nothing more is checked: counting is all that is left to do.
    if (features.length >= GEODATA_MAX_FEATURES) {
      dropped++;
      continue;
    }
    const checked = geometrySchema.parse(f.geometry);
    if (!checked.ok) {
      noShape++;
      continue;
    }
    const n = countCoordinates(checked.value);
    if (coordinates + n > GEODATA_MAX_COORDINATES) {
      droppedForCoordinates++;
      continue;
    }
    coordinates += n;
    // A TopoJSON reader leaves the name in the properties, as GeoJSON does.
    const props = (f as { properties?: Record<string, unknown> }).properties ?? {};
    const named = [f.name, props['name'], props['Name'], props['NAME'], props['title']].find(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    const label = named ? named.trim().slice(0, 120) : undefined;
    features.push(label ? { geometry: checked.value, name: label } : { geometry: checked.value });
  }
  if (noShape) issues.push(`${noShape} feature(s) without a usable shape`);
  if (dropped)
    issues.push(`${dropped} feature(s) past the limit of ${GEODATA_MAX_FEATURES.toLocaleString('en-US')} shapes`);
  if (droppedForCoordinates)
    issues.push(
      `${droppedForCoordinates} feature(s) past the limit of ${GEODATA_MAX_COORDINATES.toLocaleString('en-US')} points`,
    );
  if (features.length === 0 && !issues.length) issues.push('no shapes in the file');
  return { format, features, issues };
}

function geoJsonFeatures(
  doc: unknown,
  type: unknown,
): { features: FileFeature[]; notes: string[]; skipped: Array<{ reason: string }> } | { malformed: string } {
  const crs = (doc as { crs?: { properties?: { name?: unknown } } } | null)?.crs?.properties?.name;
  if (typeof crs === 'string' && !/(CRS84|EPSG:+4326)\b/i.test(crs))
    return { malformed: `the file is in ${crs.slice(0, 60)}, not longitude/latitude (WGS 84)` };
  const list: unknown[] =
    type === 'FeatureCollection'
      ? Array.isArray((doc as { features?: unknown }).features)
        ? ((doc as { features: unknown[] }).features ?? [])
        : []
      : type === 'Feature'
        ? [doc]
        : typeof type === 'string' && /^(Multi)?(Point|LineString|Polygon)$/.test(type)
          ? [{ type: 'Feature', geometry: doc, properties: {} }]
          : [];
  if (list.length === 0 && type !== 'FeatureCollection') return { malformed: 'not GeoJSON' };
  const features: FileFeature[] = [];
  list.forEach((raw, i) => {
    const f = raw as { geometry?: unknown; properties?: Record<string, unknown> | null };
    const props = f?.properties && typeof f.properties === 'object' ? f.properties : {};
    const name = ['name', 'Name', 'NAME', 'title'].map((k) => props[k]).find((v) => typeof v === 'string');
    features.push({
      type: 'Feature',
      id: `feature-${i + 1}`,
      kind: 'feature',
      ...(typeof name === 'string' ? { name } : {}),
      geometry: (f?.geometry ?? null) as WorldGeometry | null,
      properties: {},
    });
  });
  return { features, notes: [], skipped: [] };
}

function countCoordinates(g: WorldGeometry): number {
  const walk = (v: unknown): number =>
    Array.isArray(v) ? (typeof v[0] === 'number' ? 1 : v.reduce((n: number, x) => n + walk(x), 0)) : 0;
  return walk(g.coordinates);
}

/**
 * The KML inside a KMZ: the zip's central directory read for its entries, `doc.kml` or else
 * the first `.kml`, stored or deflated. Nothing else in the archive is read.
 */
export function kmlInKmz(bytes: Uint8Array): { text: string } | { error: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 65_557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return { error: 'not a KMZ (no zip directory)' };
  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const found: Array<{ name: string; method: number; compressed: number; size: number; local: number }> = [];
  for (let e = 0; e < entries; e++) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== 0x02014b50)
      return { error: 'not a KMZ (a damaged zip directory)' };
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(at + 46, at + 46 + nameLen));
    if (/\.kml$/i.test(name)) found.push({ name, method, compressed, size, local });
    at += 46 + nameLen + extraLen + commentLen;
  }
  const entry = found.find((f) => /(^|\/)doc\.kml$/i.test(f.name)) ?? found[0];
  if (!entry) return { error: 'no KML in the KMZ' };
  if (entry.size > KMZ_MAX_UNCOMPRESSED) return { error: 'the KML in the KMZ is too large' };
  if (entry.local + 30 > bytes.byteLength || view.getUint32(entry.local, true) !== 0x04034b50)
    return { error: 'not a KMZ (a damaged zip entry)' };
  const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
  const data = bytes.subarray(start, start + entry.compressed);
  if (data.byteLength !== entry.compressed) return { error: 'not a KMZ (a truncated zip entry)' };
  try {
    const raw =
      entry.method === 0
        ? data
        : entry.method === 8
          ? inflateRawSync(data, { maxOutputLength: KMZ_MAX_UNCOMPRESSED })
          : null;
    if (!raw)
      return { error: `the KML in the KMZ is compressed in a way this reader does not take (method ${entry.method})` };
    return { text: new TextDecoder('utf-8').decode(raw) };
  } catch (err) {
    // A KMZ whose directory understates the KML's size is stopped by the inflate limit.
    if ((err as { code?: unknown })?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError)
      return { error: `the KML in the KMZ is larger than ${KMZ_MAX_UNCOMPRESSED / 1024 / 1024} MB unpacked` };
    return { error: 'the KML in the KMZ could not be decompressed' };
  }
}
