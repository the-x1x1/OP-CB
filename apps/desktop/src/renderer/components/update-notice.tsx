import { useState } from 'react';
import type { UpdaterState } from '@worldview/ipc-contract';
import { Button, Icon } from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';

/**
 * "Update available — restart to update?" (operator decision 2026-10-20, ADR-012 amendment):
 * a card over the map when a newer WorldView exists, so nobody works on an old build without
 * knowing. With automatic updates the new version downloads in the background and the card
 * says so, then offers the restart; Later hides it for this version until the next start.
 */
/** Where the releases are published (electron-builder.yml `publish`). */
export const RELEASES_URL = 'https://github.com/the-x1x1/oneview/releases';

export interface UpdateNoticeModel {
  title: string;
  body: string;
  /** The button, when there is something to press. */
  action?: { label: string; kind: 'restart' | 'download' | 'release' };
}

export function updateNoticeModel(state: UpdaterState | null | undefined): UpdateNoticeModel | null {
  if (!state?.availableVersion) return null;
  const v = state.availableVersion;
  // The .deb is the package manager's to install: nothing is downloaded or run from here.
  if (state.canInstall === false) {
    if (state.status !== 'available' && state.status !== 'downloaded') return null;
    return {
      title: `WorldView ${v} is available`,
      body: `You are on ${state.currentVersion}. Download the new package from the release page and install it with your package manager.`,
      action: { label: 'Open the release page', kind: 'release' },
    };
  }
  switch (state.status) {
    case 'downloading':
      return {
        title: `WorldView ${v} is available`,
        body: `Downloading it in the background (${state.message ?? 'downloading'}). You can keep working; it will ask to restart when it is ready.`,
      };
    case 'downloaded':
      return {
        title: `WorldView ${v} is ready`,
        body: `You are on ${state.currentVersion}. Restart to update: it takes a few seconds and opens where you were.`,
        action: { label: 'Restart to update', kind: 'restart' },
      };
    case 'available':
      return {
        title: `WorldView ${v} is available`,
        body: `You are on ${state.currentVersion}.${state.automatic ? '' : ' Download it now and restart into it.'}`,
        action: { label: 'Download and restart', kind: 'download' },
      };
    default:
      return null;
  }
}

export function UpdateNotice() {
  const { updater } = useAppState();
  const actions = useActions();
  const [laterFor, setLaterFor] = useState<string | null>(null);
  const model = updateNoticeModel(updater.state);
  if (!model || laterFor === updater.state?.availableVersion) return null;
  return (
    <div className="wv-update-notice" role="alertdialog" aria-labelledby="wv-update-title">
      <Icon name="download" size={16} />
      <div className="wv-update-notice__text">
        <span id="wv-update-title" className="wv-update-notice__title">
          {model.title}
        </span>
        <span className="wv-update-notice__body">{model.body}</span>
      </div>
      <div className="wv-update-notice__actions">
        {model.action ? (
          <Button
            size="sm"
            icon={model.action.kind === 'release' ? 'external' : 'refresh'}
            variant="primary"
            onClick={() =>
              model.action!.kind === 'release'
                ? void actions.openExternal(`${RELEASES_URL}/tag/v${updater.state!.availableVersion}`)
                : void actions.installUpdate()
            }
          >
            {model.action.label}
          </Button>
        ) : null}
        <Button size="sm" onClick={() => setLaterFor(updater.state?.availableVersion ?? null)}>
          Later
        </Button>
      </div>
    </div>
  );
}
