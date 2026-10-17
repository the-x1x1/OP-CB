import type { GeoBounds, WorldGeometry } from '@worldview/world-model';
import { geometryCentroid, pointInPolygon } from '@worldview/world-model';
import type { GeodataShape } from '@worldview/ipc-contract';
import type { RenderFeature, RenderGeometry } from '@worldview/render-core';

/**
 * Files the operator dropped on the map (or chose from the palette): their shapes drawn for
 * the session, one colour per file, each file shown or hidden, flown to or removed from the
 * card that lists them (imported-files-card.tsx). The runtime reads the file (`geodata.read`);
 * nothing is kept past the session or sent anywhere. A map tool layer like the grid and the
 * range rings (tool-layers.ts): never a pick target.
 */
export const IMPORTED_LAYER = 'imported';
/** Files at most at once; a further one replaces nothing and is refused. */
export const MAX_IMPORTED_FILES = 12;
/** Shapes drawn in all imported files together, at most. */
export const MAX_IMPORTED_SHAPES = 50_000;

/** The colour of each file in turn: distinct on the dark basemaps and from the alert colours. */
export const IMPORT_COLOURS = [
  '#22d3ee',
  '#a3e635',
  '#f472b6',
  '#facc15',
  '#60a5fa',
  '#fb923c',
  '#c084fc',
  '#34d399',
] as const;

export interface ImportedFile {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  shapes: GeodataShape[];
  /** What the reader left out, said on the card. */
  issues: string[];
  bounds?: GeoBounds;
}

/** The next colour: the first not in use, else round again. */
export function nextImportColour(files: readonly ImportedFile[]): string {
  const used = new Set(files.map((f) => f.color));
  return IMPORT_COLOURS.find((c) => !used.has(c)) ?? IMPORT_COLOURS[files.length % IMPORT_COLOURS.length]!;
}

/** The box round every coordinate of the shapes; undefined for none. */
export function shapesBounds(shapes: readonly GeodataShape[]): GeoBounds | undefined {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (v: unknown): void => {
    if (!Array.isArray(v)) return;
    if (typeof v[0] === 'number' && typeof v[1] === 'number') {
      const [lon, lat] = v as [number, number];
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      return;
    }
    for (const x of v) visit(x);
  };
  for (const s of shapes) visit(s.geometry.coordinates);
  return Number.isFinite(west) ? { west, south, east, north } : undefined;
}

/** One geometry as the renderers' parts: points, lines, polygons. */
function parts(g: WorldGeometry): RenderGeometry[] {
  switch (g.type) {
    case 'Point':
      return [{ kind: 'point', position: { latitude: g.coordinates[1], longitude: g.coordinates[0] } }];
    case 'MultiPoint':
      return g.coordinates.map((c) => ({ kind: 'point', position: { latitude: c[1], longitude: c[0] } }));
    case 'LineString':
      return [{ kind: 'line', positions: g.coordinates.map((c) => ({ latitude: c[1], longitude: c[0] })) }];
    case 'MultiLineString':
      return g.coordinates.map((l) => ({
        kind: 'line',
        positions: l.map((c) => ({ latitude: c[1], longitude: c[0] })),
      }));
    case 'Polygon':
      return [polygon(g.coordinates)];
    case 'MultiPolygon':
      return g.coordinates.map(polygon);
    default:
      return [];
  }
}

function polygon(rings: ReadonlyArray<ReadonlyArray<readonly number[]>>): RenderGeometry {
  return {
    kind: 'polygon',
    rings: rings.map((r) => r.map((c) => ({ latitude: c[1]!, longitude: c[0]! }))),
  };
}

/**
 * Where a named line or area shows its name: a line's middle vertex; an area's average
 * vertex when that lies inside its outer ring, else its first vertex. A label anchor, not a
 * centre of mass — enough to say which shape is which, as Google Earth names its placemarks.
 */
export function nameAnchor(g: RenderGeometry): { latitude: number; longitude: number } | undefined {
  if (g.kind === 'line') return g.positions[Math.floor((g.positions.length - 1) / 2)];
  if (g.kind !== 'polygon') return undefined;
  const ring = g.rings[0];
  if (!ring || ring.length === 0) return undefined;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  const closed = ring.length > 1 && first.latitude === last.latitude && first.longitude === last.longitude;
  const n = closed ? ring.length - 1 : ring.length;
  let lat = 0;
  let lon = 0;
  for (let i = 0; i < n; i++) {
    lat += ring[i]!.latitude;
    lon += ring[i]!.longitude;
  }
  const mid = { latitude: lat / n, longitude: lon / n };
  const coords = ring.map((p) => [p.longitude, p.latitude] as [number, number]);
  return pointInPolygon(mid, coords) ? mid : ring[0];
}

/**
 * The features of every visible file: points with their names, lines and outlines in the
 * file's colour, under everything else on the map, and a named line or area's name at a dot
 * on it (nameAnchor). At most MAX_IMPORTED_SHAPES shapes.
 */
export function importedFeatures(files: readonly ImportedFile[]): RenderFeature[] {
  const out: RenderFeature[] = [];
  let shapes = 0;
  for (const file of files) {
    if (!file.visible) continue;
    for (const [i, shape] of file.shapes.entries()) {
      if (shapes++ >= MAX_IMPORTED_SHAPES) return out;
      parts(shape.geometry).forEach((geometry, part) => {
        out.push({
          id: `imported:${file.id}:${i}${part ? `:${part}` : ''}`,
          geometry,
          style: {
            styleClass: 'imported',
            color: file.color,
            opacity: geometry.kind === 'polygon' ? 0.35 : 0.9,
            ...(geometry.kind === 'point' && shape.name && part === 0 ? { label: shape.name } : {}),
          },
          interactive: false,
          priority: 15,
          layer: IMPORTED_LAYER,
        });
        const name = shape.name;
        const at = name && part === 0 && geometry.kind !== 'point' ? nameAnchor(geometry) : undefined;
        if (at && name)
          out.push({
            id: `imported:${file.id}:${i}:name`,
            geometry: { kind: 'point', position: at },
            style: { styleClass: 'imported', color: file.color, opacity: 0.9, size: 4, label: name },
            interactive: false,
            priority: 15,
            layer: IMPORTED_LAYER,
          });
      });
    }
  }
  return out;
}

/** A key that changes whenever what the imported layer draws does. */
export function importedKey(files: readonly ImportedFile[]): string {
  return files
    .filter((f) => f.visible)
    .map((f) => `${f.id}:${f.color}:${f.shapes.length}`)
    .join('|');
}

/** Where to fly for a file: its box, or the middle of its one shape. */
export function importedTarget(
  file: ImportedFile,
): { position: { latitude: number; longitude: number }; bounds?: GeoBounds } | undefined {
  const b = file.bounds;
  if (b) return { position: { latitude: (b.north + b.south) / 2, longitude: (b.east + b.west) / 2 }, bounds: b };
  const first = file.shapes[0];
  const at = first ? geometryCentroid(first.geometry) : undefined;
  return at ? { position: { latitude: at.latitude, longitude: at.longitude } } : undefined;
}

/** Bytes as base64, in chunks so a large file does not overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
  return btoa(binary);
}
