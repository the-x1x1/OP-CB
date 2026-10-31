import type { ViewLink } from '@opcb/ipc-contract';
import type { ViewState } from '@opcb/render-core';
import { LAYER_GROUPS } from '../layer-tree.js';
import { withLayer } from '../overview-layers.js';
import { withWeatherImagery } from '../weather-imagery.js';

/**
 * A opcb:// link in the shell (packages/ipc-contract view-link.ts reads and writes the
 * text): which layer switches it turns, and the link for what is on the map now.
 */

/** The same patterns `readViewLink` accepts (packages/ipc-contract view-link.ts). */
const LINK_SELECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const LINK_LENS_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Every switch a link may turn: the categories, their types and children, the weather pictures. */
export function linkableLayerIds(): Set<string> {
  const ids = new Set<string>();
  for (const g of LAYER_GROUPS) {
    ids.add(g.id);
    for (const l of g.layers) {
      ids.add(l.id);
      for (const c of l.children) ids.add(c.id);
    }
    for (const i of g.imagery ?? []) ids.add(i.id);
  }
  return ids;
}

/** The hidden list after a link's `show` and `hide`, and the ids it named that are no switch here. */
export function linkHiddenLayers(
  hidden: readonly string[],
  link: Pick<ViewLink, 'show' | 'hide'>,
  known: ReadonlySet<string> = linkableLayerIds(),
): { hidden: string[]; unknown: string[] } {
  const imagery = new Set(LAYER_GROUPS.flatMap((g) => (g.imagery ?? []).map((i) => i.id)));
  let next = [...hidden];
  const unknown: string[] = [];
  const turn = (id: string, on: boolean) => {
    if (!known.has(id)) {
      unknown.push(id);
      return;
    }
    next = imagery.has(id) ? withWeatherImagery(next, id, on) : withLayer(next, id, on);
  };
  for (const id of link.show ?? []) turn(id, true);
  for (const id of link.hide ?? []) turn(id, false);
  return { hidden: next, unknown };
}

/** The link for the view on the map, with the lens and the selection when there are. */
export function linkForView(
  view: Pick<ViewState, 'center' | 'altitudeM' | 'zoom'>,
  mode: '2D' | '3D',
  opts: { lensId?: string | undefined; selectedId?: string | null | undefined } = {},
): ViewLink {
  // 2D says where it is by zoom, the globe by its camera height.
  const link: ViewLink = { latitude: view.center.latitude, longitude: view.center.longitude, mode };
  if (mode === '3D') link.altitudeM = Math.max(1, Math.min(50_000_000, view.altitudeM));
  else link.zoom = Math.max(0, Math.min(22, view.zoom));
  if (opts.lensId && LINK_LENS_ID.test(opts.lensId)) link.lensId = opts.lensId;
  // Only an id the link can carry (view-link.ts reads `select` by this pattern): one it
  // cannot — a '+' in it, over 128 characters — is left out rather than written into a link
  // that the app would then refuse.
  if (opts.selectedId && LINK_SELECT_ID.test(opts.selectedId)) link.select = opts.selectedId;
  // A centre a hair outside ±180 after a pan is the same place: wrap it into range.
  link.longitude = ((((link.longitude + 180) % 360) + 360) % 360) - 180;
  return link;
}
