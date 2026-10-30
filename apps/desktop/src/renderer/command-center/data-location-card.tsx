import { useEffect, useState } from 'react';
import type { DataLocationInfo } from '@worldview/ipc-contract';
import { Button } from '@worldview/ui';
import { useClient } from '../store/store.js';
import { bytesText } from './map-download-panel.js';

const KIND_TEXT: Record<DataLocationInfo['kind'], string> = {
  usual: "this computer's usual application-data folder",
  portable: 'a portable WorldView-data folder beside the app, which travels with its drive',
  moved: 'a folder you chose',
};

/**
 * Where all of WorldView's data lives — settings, history, maps, keys, logs — and moving it to
 * a drive (an external SSD) from the next start. Data vaults are for packs only; this moves
 * everything.
 */
export function DataLocationCard() {
  const client = useClient();
  const [info, setInfo] = useState<DataLocationInfo | null>(null);
  const [note, setNote] = useState<{ text: string; restart: boolean; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void client.request('data.location', undefined).then(setInfo, () => setInfo(null));
  }, [client]);
  const act = async (channel: 'data.moveTo' | 'data.useUsual') => {
    setBusy(true);
    try {
      const r = await client.request(channel, undefined);
      if (r.message !== 'cancelled') setNote({ text: r.message, restart: r.restartNeeded, ok: r.ok });
    } finally {
      setBusy(false);
    }
  };
  if (!info) return null;
  return (
    <section className="wv-cc-card">
      <h3 className="wv-cc-caps">Where OP-CB keeps its data</h3>
      {info.missing ? (
        <p className="wv-cc-problem">
          Your data folder {info.missing.path} could not be used at this start ({info.missing.reason}): this
          computer&apos;s own data is in use. Connect the drive and restart to go back to it.
        </p>
      ) : null}
      <p>
        <code>{info.root}</code> — {KIND_TEXT[info.kind]}
        {info.freeBytes !== undefined
          ? `. ${bytesText(info.freeBytes)} free${info.totalBytes ? ` of ${bytesText(info.totalBytes)}` : ''}.`
          : '.'}
      </p>
      <p className="wv-cc-muted">
        Everything OP-CB writes lives here: settings, history, saved places, downloaded maps, the inventory, stored keys
        and logs. To keep all of it on an external SSD, move it there; to carry OP-CB between computers, unzip the
        portable copy onto the drive and make a folder named <code>WorldView-data</code> beside{' '}
        <code>WorldView.exe</code>. Stored keys are locked to one computer by the operating system and are asked for
        again on another.
      </p>
      {info.kind !== 'portable' ? (
        <div className="wv-cc-actions">
          <Button size="sm" disabled={busy} onClick={() => void act('data.moveTo')}>
            Keep all OP-CB data on a drive…
          </Button>
          {info.kind === 'moved' ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('data.useUsual')}>
              Use this computer&apos;s folder again
            </Button>
          ) : null}
        </div>
      ) : null}
      {note ? (
        <div className="wv-cc-answer">
          <p className={note.ok ? '' : 'wv-cc-problem'}>{note.text}.</p>
          {note.restart ? (
            <Button size="sm" variant="primary" onClick={() => void client.request('data.restart', undefined)}>
              Restart OP-CB now
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
