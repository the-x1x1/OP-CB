import { useCallback, useEffect, useState } from 'react';
import { SHARE_MINUTES_CHOICES, type LibraryShareStatus } from '@opcb/ipc-contract';
import { Button } from '@opcb/ui';
import { useClient } from '../store/store.js';
import { qrMatrix, qrPath } from './qr.js';
import { requestErrorText } from './private-folder-text.js';
import { shareMinutesText, shareUntilText } from './collection-text.js';

/**
 * The library on phones and tablets (2026-11-22): read-only, on this network, for as long as
 * chosen (runtime support/library-share.ts). Off whenever OP-CB starts.
 */
export function LibraryShareCard() {
  const client = useClient();
  const [st, setSt] = useState<LibraryShareStatus>({ sharing: false });
  const [minutes, setMinutes] = useState<number>(120);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setSt(await client.request('library.share.status', undefined));
    } catch {
      /* the next look tells */
    }
  }, [client]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);
  const run = async (job: () => Promise<LibraryShareStatus>) => {
    setBusy(true);
    setNote(null);
    try {
      const s = await job();
      setSt(s);
      if (!s.sharing && job === start) setNote('This build does not share the library.');
    } catch (err) {
      setNote(requestErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  const start = () => client.request('library.share.start', { minutes });
  const first = st.urls?.[0];
  const qr = first ? qrMatrix(first) : undefined;
  return (
    <section className="wv-cc-card">
      <h3 className="wv-cc-caps">On phones and tablets</h3>
      <p className="wv-cc-muted">
        Read the library’s books and downloaded guides from a phone or tablet on the same Wi-Fi or network, in its
        browser. Read only; nothing else of OP-CB’s is shared. Off until you start it, and off again when the time is up
        or OP-CB closes.
      </p>
      {st.sharing ? (
        <>
          <div className="wv-cc-share">
            {qr ? (
              <svg
                className="wv-cc-qr"
                viewBox={`0 0 ${qr.length + 8} ${qr.length + 8}`}
                role="img"
                aria-label={`QR code for ${first}`}
              >
                <rect width={qr.length + 8} height={qr.length + 8} fill="#fff" />
                <path d={qrPath(qr)} fill="#000" />
              </svg>
            ) : null}
            <div>
              <p>Point the phone’s camera at the code, or type an address into its browser:</p>
              <ul className="wv-cc-list">
                {(st.urls ?? []).map((u) => (
                  <li key={u}>
                    <code className="wv-cc-mono">{u}</code>
                  </li>
                ))}
              </ul>
              {!st.urls?.length ? (
                <p className="wv-cc-problem">
                  This computer has no address on a local network: connect it to Wi-Fi or a network cable.
                </p>
              ) : null}
              <p className="wv-cc-muted">
                {shareUntilText(st.until)} · {st.served ?? 0} pages served. Anyone on this network with the address can
                read the library until then.
              </p>
            </div>
          </div>
          <div className="wv-cc-actions">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void run(() => client.request('library.share.stop', undefined))}
            >
              Stop sharing
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(start)}>
              New address
            </Button>
          </div>
        </>
      ) : (
        <div className="wv-cc-inline">
          <select
            className="wv-input"
            aria-label="For how long"
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          >
            {SHARE_MINUTES_CHOICES.map((m) => (
              <option key={m} value={m}>
                For {shareMinutesText(m)}
              </option>
            ))}
          </select>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(start)}>
            Share the library
          </Button>
        </div>
      )}
      <p className="wv-cc-muted">
        On Windows, the first time, the firewall may ask whether OP-CB may use the network: allow it on private networks
        only.
      </p>
      {note ? <p className="wv-cc-problem">{note}</p> : null}
    </section>
  );
}
