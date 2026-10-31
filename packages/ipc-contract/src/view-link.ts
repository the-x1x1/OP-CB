/**
 * Links to a view: `opcb://view?lat=21.31&lon=-157.86&z=11` opens the app at that place
 * (ADR-004 amendment 2026-10-20). Registered with the operating system at install, so a link
 * in an email, a chat or a web page opens OP-CB where it points.
 *
 * A link arrives from outside the app, so it is read here, strictly, before anything acts on
 * it: a place, how close, 2D or 3D, a lens, layers shown or hidden, and one thing to select.
 * Nothing in a link is fetched, run or stored as anything but those few values; a link that
 * cannot be read is refused with the reason, and parameters this version does not know are
 * named back rather than half read.
 */

export const VIEW_LINK_SCHEME = 'opcb';
export const VIEW_LINK_MAX_LENGTH = 2048;

export interface ViewLink {
  latitude: number;
  longitude: number;
  /** 2D map zoom (0–22). */
  zoom?: number;
  /** The globe's camera height in metres. */
  altitudeM?: number;
  mode?: '2D' | '3D';
  lensId?: string;
  /** Overview layer ids to turn on, and to turn off. */
  show?: string[];
  hide?: string[];
  /** An object or event id to select when it is in the world. */
  select?: string;
}

export type ViewLinkRead = { ok: true; link: ViewLink; ignored: string[] } | { ok: false; reason: string };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const LAYER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_LAYERS = 32;
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

function num(value: string | null): number | undefined {
  if (value === null || !NUMBER.test(value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Whether `text` is a link to read here, rather than a search or anything else. */
export function isViewLink(text: string): boolean {
  return /^opcb:/i.test(text.trim());
}

/** Reads a `opcb://view?...` link. */
export function readViewLink(text: string): ViewLinkRead {
  const raw = text.trim();
  if (raw.length > VIEW_LINK_MAX_LENGTH) return { ok: false, reason: 'the link is too long' };
  if (!isViewLink(raw)) return { ok: false, reason: 'not an opcb: link' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'the link is not a URL' };
  }
  // `opcb://view?…` puts "view" in the host; `opcb:view?…` in the path.
  const target = (url.hostname || url.pathname).replace(/^\/+|\/+$/g, '').toLowerCase();
  if (target !== 'view') return { ok: false, reason: `"${target || '(nothing)'}" is not something a link can open` };

  const q = url.searchParams;
  const latitude = num(q.get('lat'));
  const longitude = num(q.get('lon') ?? q.get('lng'));
  if (latitude === undefined || longitude === undefined)
    return { ok: false, reason: 'the link needs lat and lon in decimal degrees' };
  if (latitude < -90 || latitude > 90) return { ok: false, reason: 'lat must be between -90 and 90' };
  if (longitude < -180 || longitude > 180) return { ok: false, reason: 'lon must be between -180 and 180' };

  const link: ViewLink = { latitude, longitude };
  const ignored: string[] = [];
  const known = new Set(['lat', 'lon', 'lng', 'z', 'zoom', 'alt', 'mode', 'lens', 'show', 'hide', 'select']);
  for (const key of new Set(q.keys())) if (!known.has(key)) ignored.push(key);

  const zoomText = q.get('z') ?? q.get('zoom');
  if (zoomText !== null) {
    const zoom = num(zoomText);
    if (zoom === undefined || zoom < 0 || zoom > 22) return { ok: false, reason: 'z must be a zoom from 0 to 22' };
    link.zoom = zoom;
  }
  const altText = q.get('alt');
  if (altText !== null) {
    const alt = num(altText);
    if (alt === undefined || alt < 1 || alt > 50_000_000)
      return { ok: false, reason: 'alt must be a camera height from 1 to 50,000,000 m' };
    link.altitudeM = alt;
  }
  const mode = q.get('mode');
  if (mode !== null) {
    const m = mode.toUpperCase();
    if (m !== '2D' && m !== '3D') return { ok: false, reason: 'mode must be 2d or 3d' };
    link.mode = m;
  }
  const lens = q.get('lens');
  if (lens !== null) {
    if (!LAYER_ID.test(lens)) return { ok: false, reason: 'lens is not a lens id' };
    link.lensId = lens;
  }
  for (const key of ['show', 'hide'] as const) {
    const value = q.get(key);
    if (value === null) continue;
    const ids = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length > MAX_LAYERS) return { ok: false, reason: `${key} names more than ${MAX_LAYERS} layers` };
    for (const id of ids) if (!LAYER_ID.test(id)) return { ok: false, reason: `${key}: "${id}" is not a layer id` };
    if (ids.length) link[key] = [...new Set(ids)];
  }
  const select = q.get('select');
  if (select !== null) {
    if (!ID.test(select)) return { ok: false, reason: 'select is not an object or event id' };
    link.select = select;
  }
  return { ok: true, link, ignored };
}

/** Rounds to what a view needs: about a metre in position, a hundredth of a zoom step. */
function fixed(n: number, digits: number): string {
  return String(Number(n.toFixed(digits)));
}

/** The link for a view, in the form `readViewLink` reads back. */
export function formatViewLink(link: ViewLink): string {
  const parts = [`lat=${fixed(link.latitude, 5)}`, `lon=${fixed(link.longitude, 5)}`];
  if (link.zoom !== undefined) parts.push(`z=${fixed(link.zoom, 2)}`);
  if (link.altitudeM !== undefined) parts.push(`alt=${Math.round(link.altitudeM)}`);
  if (link.mode) parts.push(`mode=${link.mode.toLowerCase()}`);
  if (link.lensId) parts.push(`lens=${encodeURIComponent(link.lensId)}`);
  if (link.show?.length) parts.push(`show=${link.show.map(encodeURIComponent).join(',')}`);
  if (link.hide?.length) parts.push(`hide=${link.hide.map(encodeURIComponent).join(',')}`);
  if (link.select) parts.push(`select=${encodeURIComponent(link.select)}`);
  return `${VIEW_LINK_SCHEME}://view?${parts.join('&')}`;
}

/** The first argument on a command line that is a link (how Windows and Linux hand one over). */
export function linkInArgs(argv: readonly string[]): string | undefined {
  return argv.find((a) => typeof a === 'string' && isViewLink(a));
}
