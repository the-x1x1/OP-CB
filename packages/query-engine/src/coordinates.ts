import { readGridReference } from '@worldview/world-model';

/**
 * Coordinate parsing for the search box. Strict by design: a search that guesses is
 * worse than one that declines, because it flies the user somewhere they did not ask
 * for while looking like a success.
 *
 * Decimal degrees: "21.3, -157.9", "21.3 -157.9", "N 21.3 W 157.9", "21.3°N 157.9°W".
 * DMS (basic):     "21°18'25\"N 157°51'30\"W", "21 18 25 N, 157 51 30 W".
 * MGRS:            "4QFJ1234567890", "4Q FJ 12345 67890" (2 to 10 figures) — the middle of the square.
 * UTM:             "4Q 612345 2358765", "4Q 612345mE 2358765mN" — zone, latitude band, easting, northing.
 * geo URI:         "geo:21.3069,-157.8583", with ";crs=wgs84" and ";u=35" (metres) — RFC 5870, two
 *                  dimensions only — and Android's "?z=15" and "geo:0,0?q=21.3,-157.8(Label)" (what a
 *                  phone's "share location" gives; after God's Eye View 11bc2ec).
 * Grid references go through world-model's grid-reference.ts (WGS84, checked against
 * GeographicLib). One that cannot be right — square letters outside their band, a point
 * outside its band, "S" that could be a band or the southern hemisphere — returns
 * `{ kind: 'unsupported', note }` saying why, so the UI can say so instead of guessing.
 *
 * Adapted from gods-eye-view src/search/coordinateParser.js (MIT) — decimal component rules.
 */
export interface ParsedCoordinate {
  kind: 'decimal' | 'dms' | 'mgrs' | 'utm' | 'geo';
  latitude: number;
  longitude: number;
  label: string;
  /** For a grid reference: the side of the square it names, in metres. */
  precisionM?: number;
}

export interface UnsupportedCoordinate {
  kind: 'unsupported';
  note: string;
}

const DECIMAL_COMPONENT = /^([NSEW])?\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*°?\s*([NSEW])?$/i;
const LAT_LETTERS = new Set(['N', 'S']);

interface Component {
  value: number;
  axis: 'lat' | 'lon' | null;
}

function readDecimal(text: string): Component | undefined {
  const m = DECIMAL_COMPONENT.exec(text.trim());
  if (!m) return undefined;
  const [, before, digits, after] = m;
  if (before && after) return undefined;
  const letter = (before ?? after ?? '').toUpperCase();
  const value = Number(digits);
  if (!Number.isFinite(value)) return undefined;
  if (letter && /^[+-]/.test(digits ?? '')) return undefined;
  if (!letter) return { value, axis: null };
  const magnitude = Math.abs(value);
  return {
    value: letter === 'S' || letter === 'W' ? -magnitude : magnitude,
    axis: LAT_LETTERS.has(letter) ? 'lat' : 'lon',
  };
}

/** 21°18'25"N or 21 18 25 N or 21°18.5'N — degrees, optional minutes, optional seconds, mandatory hemisphere letter. */
const DMS_COMPONENT =
  /^(\d{1,3})\s*(?:°|\s)\s*(\d{1,2}(?:\.\d+)?)?\s*(?:['′]|\s)?\s*(\d{1,2}(?:\.\d+)?)?\s*(?:["″])?\s*([NSEW])$|^([NSEW])\s*(\d{1,3})\s*(?:°|\s)\s*(\d{1,2}(?:\.\d+)?)?\s*(?:['′]|\s)?\s*(\d{1,2}(?:\.\d+)?)?\s*(?:["″])?$/i;

function readDms(text: string): Component | undefined {
  const m = DMS_COMPONENT.exec(text.trim());
  if (!m) return undefined;
  const deg = Number(m[1] ?? m[6]);
  const min = Number(m[2] ?? m[7] ?? 0);
  const sec = Number(m[3] ?? m[8] ?? 0);
  const letter = (m[4] ?? m[5] ?? '').toUpperCase();
  if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec) || min >= 60 || sec >= 60)
    return undefined;
  const magnitude = deg + min / 60 + sec / 3600;
  return {
    value: letter === 'S' || letter === 'W' ? -magnitude : magnitude,
    axis: LAT_LETTERS.has(letter) ? 'lat' : 'lon',
  };
}

/** Candidate (first, second) splits: on a comma/semicolon when present, otherwise at each whitespace gap. */
function splitCandidates(text: string): Array<[string, string]> {
  const t = text.trim();
  if (!t) return [];
  if (/[,;]/.test(t)) {
    const parts = t
      .split(/[,;]/)
      .map((p) => p.trim())
      .filter(Boolean);
    return parts.length === 2 ? [[parts[0]!, parts[1]!]] : [];
  }
  const words = t.split(/\s+/);
  const out: Array<[string, string]> = [];
  for (let i = 1; i < words.length; i++) out.push([words.slice(0, i).join(' '), words.slice(i).join(' ')]);
  return out;
}

export function formatCoordinateLabel(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
}

function gridReference(t: string): ParsedCoordinate | UnsupportedCoordinate | undefined {
  const read = readGridReference(t);
  if (!read) return undefined;
  if ('error' in read) return { kind: 'unsupported', note: gridReferenceNote(read.kind, read.error) };
  return {
    kind: read.kind,
    latitude: read.latitude,
    longitude: read.longitude,
    label: `${read.text} (${formatCoordinateLabel(read.latitude, read.longitude)})`,
    precisionM: read.precisionM,
  };
}

/** "MGRS reference not read: …" — the search box's footer says the same (components/search-items.ts). */
function gridReferenceNote(kind: 'mgrs' | 'utm', error: string): string {
  return `${kind === 'mgrs' ? 'MGRS' : 'UTM'} reference not read: ${error}`;
}

/**
 * An RFC 5870 geo URI in WGS 84: latitude and longitude, `;crs=wgs84` and `;u=<metres>` (the
 * uncertainty, kept as the precision). Anything it cannot place exactly — an altitude, another
 * CRS, a query (`?q=`), other parameters — is said rather than half read.
 */
const GEO_URI = /^geo:([+-]?\d{1,3}(?:\.\d+)?),([+-]?\d{1,3}(?:\.\d+)?)((?:,[^;?]*)?)((?:;[^;?]*)*)(\?.*)?$/i;

function decodeURIComponentSafe(v: string): string {
  try {
    return decodeURIComponent(v.replace(/\+/g, ' '));
  } catch {
    return v;
  }
}

function geoUri(t: string): ParsedCoordinate | UnsupportedCoordinate | undefined {
  if (!/^geo:/i.test(t)) return undefined;
  const no = (why: string): UnsupportedCoordinate => ({ kind: 'unsupported', note: `geo URI not read: ${why}` });
  const m = GEO_URI.exec(t);
  if (!m) return no('it needs latitude,longitude in decimal degrees');
  const [, latText, lonText, altitude, params, query] = m;
  if (altitude) return no('it has an altitude, and only a place on the ground is taken');
  let latitude = Number(latText);
  let longitude = Number(lonText);
  // Android's forms: `?z=15` is a zoom (nothing to place; ignored), and `geo:0,0?q=lat,lon(Label)`
  // names the point in its query. A query naming a place by words is the online search's.
  for (const part of (query ?? '').replace(/^\?/, '').split('&').filter(Boolean)) {
    const [rawKey, rawValue = ''] = part.split('=');
    const k = rawKey!.trim().toLowerCase();
    const value = decodeURIComponentSafe(rawValue);
    if (k === 'z') continue;
    const at =
      k === 'q' ? /^\s*([+-]?\d{1,3}(?:\.\d+)?)\s*,\s*([+-]?\d{1,3}(?:\.\d+)?)\s*(?:\(.*\))?\s*$/.exec(value) : null;
    if (at && latitude === 0 && longitude === 0) {
      latitude = Number(at[1]);
      longitude = Number(at[2]);
      continue;
    }
    return no(`its query (${(query ?? '').slice(0, 30)}) is not read`);
  }
  if (!(Math.abs(latitude) <= 90) || !(Math.abs(longitude) <= 180)) return no('latitude or longitude out of range');
  let precisionM: number | undefined;
  for (const p of (params ?? '').split(';').filter(Boolean)) {
    const [key, value = ''] = p.split('=');
    const k = key!.trim().toLowerCase();
    if (k === 'crs') {
      if (value.trim().toLowerCase() !== 'wgs84') return no(`its CRS ${value.slice(0, 20)} is not WGS 84`);
    } else if (k === 'u') {
      const u = value.trim() === '' ? Number.NaN : Number(value);
      if (!(u >= 0) || !Number.isFinite(u)) return no('its uncertainty is not a distance in metres');
      precisionM = u;
    } else return no(`its parameter ${k.slice(0, 20)} is not read`);
  }
  const lat = latitude === 0 ? 0 : latitude;
  const lon = longitude === 0 ? 0 : longitude;
  return {
    kind: 'geo',
    latitude: lat,
    longitude: lon,
    label: `${formatCoordinateLabel(lat, lon)}${precisionM !== undefined ? ` ±${Math.round(precisionM).toLocaleString('en-US')} m` : ''}`,
    ...(precisionM !== undefined ? { precisionM } : {}),
  };
}

export function parseCoordinates(text: string): ParsedCoordinate | UnsupportedCoordinate | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const uri = geoUri(t);
  if (uri) return uri;
  const grid = gridReference(t);
  if (grid) return grid;
  for (const pair of splitCandidates(t)) {
    const dms = [readDms(pair[0]), readDms(pair[1])] as const;
    if (dms[0] && dms[1]) return assemble(dms[0], dms[1], 'dms');
    const dec = [readDecimal(pair[0]), readDecimal(pair[1])] as const;
    if (dec[0] && dec[1]) return assemble(dec[0], dec[1], 'decimal');
  }
  return undefined;
}

function assemble(first: Component, second: Component, kind: 'decimal' | 'dms'): ParsedCoordinate | undefined {
  if (first.axis && first.axis === second.axis) return undefined;
  let lat: number, lon: number;
  if (first.axis === 'lon' || second.axis === 'lat') {
    lat = second.value;
    lon = first.value;
  } else {
    lat = first.value;
    lon = second.value;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180)
    return undefined;
  return { kind, latitude: lat, longitude: lon, label: formatCoordinateLabel(lat, lon) };
}
