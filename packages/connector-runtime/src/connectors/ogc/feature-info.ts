import type { OverlayValue } from '@worldview/provider-sdk';
import { classifyCrs } from './crs.js';
import { KvpParams, joinUrl } from './common.js';

/**
 * WMS GetFeatureInfo for one point (the `wms` connector's `overlayValue`): what the service
 * says lies under the pixel the operator asked about.
 *
 * The request is a small GetMap-shaped box centred on the point — 101 × 101 pixels, the point
 * at the middle pixel — so the pixel is about a hundred metres across and the answer is for
 * the point itself, not for whatever happens to sit at the corner of the operator's view.
 * The box is in CRS:84 (or EPSG:4326 in the axis order its version uses) when the layers
 * offer it, else in EPSG:3857; a layer that offers neither is not asked.
 *
 * The answer is read in the first format of these the service lists: GeoJSON
 * (`application/json`, `application/geo+json`, GeoServer's default) or GeoServer's
 * `text/plain` (`name = value` lines). HTML and GML are never asked for: there is nothing to
 * show from one that the others do not carry, and HTML would be someone else's markup.
 */

/** The GetFeatureInfo formats this reader takes, in the order it prefers them. */
export const FEATURE_INFO_FORMATS = ['application/json', 'application/geo+json', 'text/plain'] as const;
export type FeatureInfoFormat = (typeof FEATURE_INFO_FORMATS)[number];

/** The query box is SIZE × SIZE pixels; the point is pixel (CENTRE, CENTRE). */
const SIZE = 101;
const CENTRE = 50;
/** Half the box's side, in degrees (about 550 m at the equator). */
const HALF_DEG = 0.005;
/** Half the box's side in Web Mercator metres. */
const HALF_M = 550;
/** Web Mercator's latitude limit. */
const MERCATOR_MAX_LAT = 85.05112878;

/** The format to ask for: the first of FEATURE_INFO_FORMATS the service lists, or undefined. */
export function pickFeatureInfoFormat(offered: readonly string[]): FeatureInfoFormat | undefined {
  const lower = offered.map((f) => f.toLowerCase().split(';')[0]!.trim());
  return FEATURE_INFO_FORMATS.find((f) => lower.includes(f));
}

export interface FeatureInfoQuery {
  /** The service base URL (the overlay's `url`, no query string). */
  base: string;
  version: '1.1.1' | '1.3.0';
  layers: string[];
  styles?: string[];
  /** Every CRS all the layers list. */
  crs: string[];
  format: FeatureInfoFormat;
  /** Vendor parameters and TIME, as GetMap sends them. */
  parameters: Record<string, string>;
  position: { latitude: number; longitude: number };
}

/** The GetFeatureInfo URL, or undefined when the layers offer no CRS the box can be written in. */
export function featureInfoUrl(q: FeatureInfoQuery): string | undefined {
  const box = queryBox(q.version, q.crs, q.position);
  if (!box) return undefined;
  const params = new KvpParams();
  for (const [k, v] of Object.entries(q.parameters)) params.set(k, v);
  const layers = q.layers.join(',');
  params
    .set('SERVICE', 'WMS')
    .set('REQUEST', 'GetFeatureInfo')
    .set('VERSION', q.version)
    .set('LAYERS', layers)
    .set('QUERY_LAYERS', layers)
    .set('STYLES', q.styles?.join(',') ?? '')
    .set(q.version === '1.3.0' ? 'CRS' : 'SRS', box.crs)
    .set('BBOX', box.bbox.map((n) => Number(n.toFixed(7))).join(','))
    .set('WIDTH', String(SIZE))
    .set('HEIGHT', String(SIZE))
    .set(q.version === '1.3.0' ? 'I' : 'X', String(CENTRE))
    .set(q.version === '1.3.0' ? 'J' : 'Y', String(CENTRE))
    .set('INFO_FORMAT', q.format)
    .set('FEATURE_COUNT', '1')
    .set('FORMAT', 'image/png');
  return joinUrl(q.base, params);
}

/** The box round the point and the CRS it is written in; undefined when no CRS fits. */
export function queryBox(
  version: '1.1.1' | '1.3.0',
  crsList: readonly string[],
  position: { latitude: number; longitude: number },
): { crs: string; bbox: [number, number, number, number] } | undefined {
  const kinds = crsList.map((c) => ({ crs: c, info: classifyCrs(c) }));
  const lat = Math.min(90 - HALF_DEG, Math.max(-90 + HALF_DEG, position.latitude));
  // Keep the box inside ±180 so the point stays its middle pixel.
  const lon = Math.min(180 - HALF_DEG, Math.max(-180 + HALF_DEG, position.longitude));
  const lonLat: [number, number, number, number] = [lon - HALF_DEG, lat - HALF_DEG, lon + HALF_DEG, lat + HALF_DEG];
  if (version === '1.3.0') {
    if (kinds.some((k) => k.info.kind === 'crs84')) return { crs: 'CRS:84', bbox: lonLat };
    // EPSG:4326 in 1.3.0 is latitude first.
    if (kinds.some((k) => k.info.kind === 'epsg4326'))
      return { crs: 'EPSG:4326', bbox: [lat - HALF_DEG, lon - HALF_DEG, lat + HALF_DEG, lon + HALF_DEG] };
  } else {
    // 1.1.1's EPSG:4326 is longitude first. A layer that lists only CRS:84 is asked in CRS:84
    // (also longitude first): a server answers in a CRS the layer lists, not one it does not.
    if (kinds.some((k) => k.info.kind === 'epsg4326')) return { crs: 'EPSG:4326', bbox: lonLat };
    const crs84 = kinds.find((k) => k.info.kind === 'crs84');
    if (crs84) return { crs: crs84.crs, bbox: lonLat };
  }
  const mercator = kinds.find((k) => k.info.kind === 'webmercator');
  if (!mercator || Math.abs(position.latitude) > MERCATOR_MAX_LAT) return undefined;
  const [x, y] = toWebMercator(position.longitude, position.latitude);
  const crs = kinds.some((k) => k.crs.toUpperCase() === 'EPSG:3857') ? 'EPSG:3857' : mercator.crs;
  return { crs, bbox: [x - HALF_M, y - HALF_M, x + HALF_M, y + HALF_M] };
}

function toWebMercator(lon: number, lat: number): [number, number] {
  const R = 6_378_137;
  const x = (R * lon * Math.PI) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

/**
 * The values in a GetFeatureInfo answer, in the order given: each property of the first
 * feature that is a number, a string or a boolean (as text). Nested objects, arrays, empty
 * strings, nulls and NaN (GeoServer's no-data) are left out; so is an answer that is an OGC exception or not the format
 * asked for. An empty list means nothing there.
 */
export function parseFeatureInfo(text: string, format: FeatureInfoFormat): OverlayValue[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<')) return [];
  if (format === 'text/plain') return parsePlain(trimmed);
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];
  const features = (doc as { features?: unknown }).features;
  const first = Array.isArray(features) ? (features[0] as { properties?: unknown } | undefined) : undefined;
  const props = first?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return [];
  const out: OverlayValue[] = [];
  for (const [name, value] of Object.entries(props as Record<string, unknown>)) {
    const v = scalar(value);
    if (v !== undefined) out.push({ name, value: v });
  }
  return out;
}

function scalar(value: unknown): string | number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value.trim() && !isNoData(value) ? value.trim() : undefined;
  return undefined;
}

/** GeoServer writes a pixel with no data as NaN. */
function isNoData(v: string): boolean {
  return /^\s*[-+]?nan\s*$/i.test(v);
}

/**
 * GeoServer's `text/plain`: a "Results for FeatureType …" heading, rules of dashes, then
 * `name = value` lines for the first feature. A number reads as a number. "no features were
 * found" and the like have no `=` and give nothing.
 */
function parsePlain(text: string): OverlayValue[] {
  const out: OverlayValue[] = [];
  let seenRule = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^-{3,}\s*$/.test(line.trim())) {
      // The rule after the first feature ends it.
      if (seenRule && out.length) break;
      seenRule = true;
      continue;
    }
    const m = /^\s*([^=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const name = m[1]!;
    const raw = m[2]!;
    if (!raw || isNoData(raw)) continue;
    const n = Number(raw);
    out.push({ name, value: raw !== '' && Number.isFinite(n) && /^[-+]?[\d.]/.test(raw) ? n : raw });
  }
  return out;
}
