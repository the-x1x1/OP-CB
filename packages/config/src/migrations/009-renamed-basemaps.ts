import type { Migration } from './runner.js';

/**
 * 009 — the rename to OP-CB (0.7.2) renamed the built-in vector basemaps: `worldview-dark` is
 * now `opcb-dark`, `worldview-light` now `opcb-light`. A settings file that chose one of them
 * keeps its choice under the new id; any other value is left as it is.
 */
export const RENAMED_BASEMAPS: Readonly<Record<string, string>> = Object.freeze({
  'worldview-dark': 'opcb-dark',
  'worldview-light': 'opcb-light',
});

export const renamedBasemapsMigration: Migration = {
  version: 9,
  name: 'renamed-basemaps',
  async up(ctx) {
    const doc = ctx.document;
    const settings =
      typeof doc.settings === 'object' && doc.settings !== null && !Array.isArray(doc.settings) ? doc.settings : {};
    const id = settings['basemapId'];
    if (typeof id === 'string' && RENAMED_BASEMAPS[id]) settings['basemapId'] = RENAMED_BASEMAPS[id];
    doc.settings = settings;
  },
};
