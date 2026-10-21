import type { Migration } from './runner.js';

/**
 * 008 — automatic updates on (operator decision 2026-10-20, ADR-012 amendment): a new version
 * is downloaded in the background and the window offers to restart into it, so nobody works
 * on an old build without knowing. New installations have it on by default; this turns it on,
 * once, in every settings file written before it. An `automatic: false` on disk cannot be told
 * from the old default — the store writes every setting out, chosen or not — so it is not kept:
 * an operator who had switched it off before 0.6.0 finds it on once and switches it off again
 * (said in KNOWN-LIMITATIONS). After that it is the operator's switch: off stays off.
 */
export const automaticUpdatesMigration: Migration = {
  version: 8,
  name: 'automatic-updates-on',
  async up(ctx) {
    const doc = ctx.document;
    const settings =
      typeof doc.settings === 'object' && doc.settings !== null && !Array.isArray(doc.settings) ? doc.settings : {};
    const updater =
      typeof settings['updater'] === 'object' && settings['updater'] !== null && !Array.isArray(settings['updater'])
        ? settings['updater']
        : {};
    updater['automatic'] = true;
    if (typeof updater['prerelease'] !== 'boolean') updater['prerelease'] = false;
    settings['updater'] = updater;
    doc.settings = settings;
  },
};
