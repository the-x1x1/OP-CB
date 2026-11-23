import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PRIVATE_PASSPHRASE_MIN, type PrivateStatus } from '@opcb/ipc-contract';
import { Button } from '@opcb/ui';
import { useClient } from '../store/store.js';
import { bytesText } from './map-download-panel.js';
import { passphraseHint, requestErrorText } from './private-folder-text.js';

/**
 * The private folder (2026-11-22): the operator's own documents — IDs, deeds, prescriptions,
 * insurance, contacts — encrypted inside OP-CB's data folder with a passphrase only they know
 * (packages/offline/src/private-store.ts). Files go in through the open dialog and come out
 * as a copy through the save dialog; the folder closes itself after fifteen minutes unused.
 */
export function PrivateFolderCard() {
  const client = useClient();
  const [st, setSt] = useState<PrivateStatus | null>(null);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [next, setNext] = useState('');
  const [changing, setChanging] = useState(false);
  /** The file whose Remove was pressed once: a second press deletes it. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSt(await client.request('private.status', undefined));
    } catch (err) {
      setNote({ text: requestErrorText(err), ok: false });
    }
  }, [client]);
  useEffect(() => {
    void refresh();
    // The folder closes itself when unused: look again now and then while the card is shown.
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const run = async (job: () => Promise<PrivateStatus | undefined>, done?: string) => {
    setBusy(true);
    setNote(null);
    try {
      const s = await job();
      if (s) setSt(s);
      if (done) setNote({ text: done, ok: true });
    } catch (err) {
      setNote({ text: requestErrorText(err), ok: false });
      void refresh();
    } finally {
      setBusy(false);
      setPass('');
      setPass2('');
      setNext('');
    }
  };

  const setup = (e: FormEvent) => {
    e.preventDefault();
    if (pass !== pass2) {
      setNote({ text: 'The two passphrases differ.', ok: false });
      return;
    }
    void run(async () => {
      const s = await client.request('private.setup', { passphrase: pass });
      setNote(
        s.open
          ? { text: 'The private folder is ready and open.', ok: true }
          : { text: 'The private folder was not set up here (this build keeps none).', ok: false },
      );
      return s;
    });
  };
  const unlock = (e: FormEvent) => {
    e.preventDefault();
    void run(() => client.request('private.unlock', { passphrase: pass }));
  };
  const change = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const s = await client.request('private.changePassphrase', { current: pass, next });
      setChanging(false);
      return s;
    }, 'Passphrase changed. Every file is kept.');
  };

  if (!st) return null;
  const hint = passphraseHint(st.set ? next : pass);
  return (
    <section className="wv-cc-card">
      <h3 className="wv-cc-caps">Private folder</h3>
      <p className="wv-cc-muted">
        Your own documents — IDs, deeds, prescriptions, insurance, contacts — encrypted (AES-256) inside OP-CB’s data
        folder, so a lost drive or laptop gives nothing away. Names and dates are encrypted too. It closes itself after
        fifteen minutes unused.
      </p>
      {!st.set ? (
        <form className="wv-cc-form" onSubmit={setup}>
          <p className="wv-cc-problem">
            There is no way back in without the passphrase — not for you, not for anyone. Write it down and keep it
            somewhere safe.
          </p>
          <input
            className="wv-input"
            type="password"
            autoComplete="new-password"
            placeholder={`Choose a passphrase (at least ${PRIVATE_PASSPHRASE_MIN} characters)`}
            aria-label="New passphrase"
            value={pass}
            maxLength={1024}
            onChange={(e) => setPass(e.target.value)}
          />
          <input
            className="wv-input"
            type="password"
            autoComplete="new-password"
            placeholder="The same again"
            aria-label="New passphrase again"
            value={pass2}
            maxLength={1024}
            onChange={(e) => setPass2(e.target.value)}
          />
          {pass && hint ? <p className="wv-cc-muted">{hint}</p> : null}
          <Button size="sm" variant="primary" type="submit" disabled={busy || !pass || !pass2}>
            Set up the private folder
          </Button>
        </form>
      ) : !st.open ? (
        <form className="wv-cc-inline" onSubmit={unlock}>
          <input
            className="wv-input"
            type="password"
            autoComplete="current-password"
            placeholder="Passphrase"
            aria-label="Passphrase"
            value={pass}
            maxLength={1024}
            onChange={(e) => setPass(e.target.value)}
          />
          <Button size="sm" type="submit" disabled={busy || !pass || !!st.waitSeconds}>
            {busy ? 'Opening…' : 'Open'}
          </Button>
          {st.waitSeconds ? <span className="wv-cc-muted">Wait {st.waitSeconds} s.</span> : null}
        </form>
      ) : (
        <>
          {st.entries?.length ? (
            <ul className="wv-cc-list">
              {st.entries.map((e) => (
                <li key={e.id} className="wv-cc-libbook">
                  <div>
                    <strong>{e.name}</strong>
                    <span className="wv-cc-muted">
                      {' '}
                      · {bytesText(e.sizeBytes)} · added {e.addedAt.slice(0, 10)}
                    </span>
                  </div>
                  <span className="wv-cc-actions">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const r = await client.request('private.export', { id: e.id });
                          if (r.path) setNote({ text: `Copy saved (not encrypted) to ${r.path}`, ok: true });
                          return undefined;
                        })
                      }
                    >
                      Save a copy…
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        if (confirming !== e.id) {
                          setConfirming(e.id);
                          return;
                        }
                        setConfirming(null);
                        void run(() => client.request('private.remove', { id: e.id }), `${e.name} removed.`);
                      }}
                    >
                      {confirming === e.id ? 'Delete it for good?' : 'Remove'}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>Nothing in the private folder yet.</p>
          )}
          <div className="wv-cc-actions">
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await client.request('private.add', undefined);
                  if (r.added) setNote({ text: `${r.added.name} is in the private folder.`, ok: true });
                  return r.status;
                })
              }
            >
              Add a file…
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(() => client.request('private.lock', undefined))}
            >
              Close
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setChanging(!changing)}>
              Change passphrase
            </Button>
          </div>
          {changing ? (
            <form className="wv-cc-form" onSubmit={change}>
              <input
                className="wv-input"
                type="password"
                autoComplete="current-password"
                placeholder="Current passphrase"
                aria-label="Current passphrase"
                value={pass}
                maxLength={1024}
                onChange={(e) => setPass(e.target.value)}
              />
              <input
                className="wv-input"
                type="password"
                autoComplete="new-password"
                placeholder="New passphrase"
                aria-label="New passphrase"
                value={next}
                maxLength={1024}
                onChange={(e) => setNext(e.target.value)}
              />
              {next && hint ? <p className="wv-cc-muted">{hint}</p> : null}
              <Button size="sm" type="submit" disabled={busy || !pass || !next}>
                Change it
              </Button>
            </form>
          ) : null}
          <p className="wv-cc-muted">
            A saved copy is an ordinary file outside the folder: delete it when you are done with it.
          </p>
        </>
      )}
      {note ? <p className={note.ok ? 'wv-cc-muted' : 'wv-cc-problem'}>{note.text}</p> : null}
    </section>
  );
}
