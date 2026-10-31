import { useEffect, useState, type FormEvent } from 'react';
import type { CatalogAnswer, CatalogEntry, LibraryFindAnswer } from '@opcb/ipc-contract';
import { Button } from '@opcb/ui';
import { useCC } from './use-cc.js';
import { bytesText, etaText } from './map-download-panel.js';

/**
 * The built-in library (2026-10-30): ZIM files OP-CB opens itself, the public-domain
 * emergency references, and books from the Kiwix catalogue downloaded into the library folder.
 */

const SUGGESTED = ['wikipedia', 'medicine', 'post-disaster', 'water', 'wikivoyage', 'ifixit', 'wikihow'] as const;

export function BuiltInLibrary() {
  const [cc, store] = useCC();
  const shelf = cc.shelf;
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<LibraryFindAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void store.refreshShelf();
  }, [store]);
  const books = shelf?.books ?? [];
  const readable = books.filter((b) => b.readable);
  const find = async (e: FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    try {
      setFound(await store.findInLibrary({ query: query.trim(), limit: 30 }));
    } catch (err) {
      setFound({ hits: [], searched: 0, notes: [err instanceof Error ? err.message : 'the search failed'] });
    } finally {
      setBusy(false);
    }
  };
  const open = async (bookId: string, key?: string) => {
    const r = await store.openLibrary(key ? { kind: 'book', bookId, key } : { kind: 'book', bookId });
    setNote(r.opened ? null : (r.message ?? 'not opened'));
  };
  return (
    <section className="wv-cc-card">
      <h3 className="wv-cc-caps">Your library</h3>
      <p className="wv-cc-muted">
        ZIM files OP-CB opens itself — no Kiwix program needed. Put .zim files in the library folder, or download them
        below.
        {shelf?.freeBytes !== undefined ? ` ${bytesText(shelf.freeBytes)} free on that drive.` : ''}
      </p>
      {books.length ? (
        <ul className="wv-cc-list">
          {books.map((b) => (
            <li key={b.id} className="wv-cc-libbook">
              <div>
                <strong>{b.title}</strong>
                <span className="wv-cc-muted">
                  {' '}
                  · {bytesText(b.sizeBytes)}
                  {b.language ? ` · ${b.language}` : ''}
                  {b.date ? ` · ${b.date}` : ''}
                </span>
                {b.problem ? <div className="wv-cc-problem">{b.problem}</div> : null}
                {b.readable && !b.titleSearch ? (
                  <div className="wv-cc-muted">No title list in this file: open it and browse from its start page.</div>
                ) : null}
              </div>
              <Button size="sm" disabled={!b.readable} onClick={() => void open(b.id)}>
                Open
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p>No books in the library yet.</p>
      )}
      {readable.length ? (
        <form className="wv-cc-inline" onSubmit={(e) => void find(e)}>
          <input
            className="wv-input"
            placeholder="Find a page by its title (water purification, tourniquet…)"
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button size="sm" type="submit" disabled={busy || !query.trim()}>
            {busy ? 'Finding…' : 'Find'}
          </Button>
        </form>
      ) : null}
      {found ? (
        <div className="wv-cc-answer">
          {found.hits.length ? (
            <ol>
              {found.hits.map((h) => (
                <li key={`${h.bookId}/${h.key}`}>
                  <button type="button" className="wv-cc-link" onClick={() => void open(h.bookId, h.key)}>
                    {h.title}
                  </button>
                  {readable.length > 1 ? <span className="wv-cc-muted"> — {h.bookTitle}</span> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p>No titles start with that. Title search only: try the first word of a page’s name.</p>
          )}
          {found.notes.map((n) => (
            <p key={n} className="wv-cc-muted">
              {n}
            </p>
          ))}
        </div>
      ) : null}
      {note ? <p className="wv-cc-problem">{note}</p> : null}
      <div className="wv-cc-actions">
        <Button size="sm" variant="ghost" onClick={() => void store.openLibrary({ kind: 'folder' })}>
          Open the library folder
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void store.refreshShelf()}>
          Look again
        </Button>
      </div>
      <p className="wv-cc-muted">
        Pages open in a separate reader window with page scripts off and nothing loaded from the internet. Each book
        keeps its own licence and credits, shown in the book.
      </p>
    </section>
  );
}

export function EmergencyReferences() {
  const [cc, store] = useCC();
  const refs = cc.shelf?.references ?? [];
  const st = cc.libraryDownload;
  const offline = cc.mode?.chosen === 'offline';
  const fetching = (st.phase === 'downloading' || st.phase === 'verifying') && st.item === 'emergency references';
  const busyElse = (st.phase === 'downloading' || st.phase === 'verifying') && !fetching;
  const missing = refs.filter((r) => !r.installed);
  const [note, setNote] = useState<string | null>(null);
  return (
    <section className="wv-cc-card">
      <h3 className="wv-cc-caps">Emergency references</h3>
      <p className="wv-cc-muted">
        Public-domain guides from FEMA, the CDC and the U.S. Army, kept in the library folder and readable offline.
      </p>
      <ul className="wv-cc-list">
        {refs.map((r) => (
          <li key={r.id} className="wv-cc-libbook">
            <div>
              <strong>{r.title}</strong>
              <span className="wv-cc-muted">
                {' '}
                · {r.publisher}
                {r.edition ? ` · ${r.edition}` : ''}
              </span>
              <div className="wv-cc-muted">{r.topic}</div>
            </div>
            {r.installed ? (
              <Button
                size="sm"
                onClick={() =>
                  void store
                    .openLibrary({ kind: 'reference', id: r.id })
                    .then((x) => setNote(x.opened ? null : (x.message ?? null)))
                }
              >
                Open
              </Button>
            ) : (
              <span className="wv-cc-chip wv-cc-chip--muted">Not downloaded</span>
            )}
          </li>
        ))}
      </ul>
      <div className="wv-cc-actions">
        <Button
          size="sm"
          variant="primary"
          disabled={!missing.length || fetching || busyElse || offline}
          onClick={() => void store.startLibraryDownload({ kind: 'references', ids: missing.map((r) => r.id) })}
        >
          {missing.length
            ? `Download ${missing.length === refs.length ? 'all' : `the ${missing.length} missing`}`
            : 'All downloaded'}
        </Button>
        {fetching ? (
          <Button size="sm" variant="ghost" onClick={() => void store.cancelLibraryDownload()}>
            Stop
          </Button>
        ) : null}
        {offline && missing.length ? <span className="wv-cc-muted">Downloading needs Online mode.</span> : null}
      </div>
      {st.item === 'emergency references' ? <DownloadState /> : null}
      {note ? <p className="wv-cc-problem">{note}</p> : null}
      <p className="wv-cc-muted">
        Works of the U.S. federal government are public domain. They open in your computer’s PDF viewer. Not a
        substitute for trained help: call emergency services when you can.
      </p>
    </section>
  );
}

export function KiwixCatalog() {
  const [cc, store] = useCC();
  const st = cc.libraryDownload;
  const offline = cc.mode?.chosen === 'offline';
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState('eng');
  const [answer, setAnswer] = useState<CatalogAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const active = st.phase === 'downloading' || st.phase === 'verifying';
  useEffect(() => {
    void store.refreshLibraryDownload();
  }, [store]);
  const search = async (q: string) => {
    setQuery(q);
    setBusy(true);
    try {
      setAnswer(await store.searchCatalog({ query: q, ...(language ? { language } : {}), count: 50 }));
    } finally {
      setBusy(false);
    }
  };
  const download = (e: CatalogEntry) => void store.startLibraryDownload({ kind: 'zim', entry: e });
  const sorted = [...(answer?.entries ?? [])].sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0));
  return (
    <section className="wv-cc-card">
      <h3 className="wv-cc-caps">Get books from the Kiwix library</h3>
      <p className="wv-cc-muted">
        Wikipedia, WikiMed, iFixit, Wikivoyage, survival and medicine collections — from library.kiwix.org, straight
        into your library folder. A download that stops carries on where it left off.
      </p>
      <form
        className="wv-cc-inline"
        onSubmit={(e) => {
          e.preventDefault();
          void search(query);
        }}
      >
        <input
          className="wv-input"
          placeholder="Search the catalogue"
          value={query}
          maxLength={200}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="wv-input"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          aria-label="Language"
        >
          <option value="eng">English</option>
          <option value="spa">Spanish</option>
          <option value="fra">French</option>
          <option value="">Any language</option>
        </select>
        <Button size="sm" type="submit" disabled={busy || offline}>
          {busy ? 'Searching…' : 'Search'}
        </Button>
      </form>
      <div className="wv-cc-actions">
        {SUGGESTED.map((s) => (
          <button
            key={s}
            type="button"
            className="wv-cc-chip"
            disabled={busy || offline}
            onClick={() => void search(s)}
          >
            {s}
          </button>
        ))}
      </div>
      {offline ? <p className="wv-cc-muted">The catalogue and downloads need Online mode.</p> : null}
      {answer && !answer.ok ? <p className="wv-cc-problem">{answer.message}</p> : null}
      {answer?.ok ? (
        sorted.length ? (
          <ul className="wv-cc-list">
            {sorted.map((e) => (
              <li key={e.id} className="wv-cc-libbook">
                <div>
                  <strong>{e.title}</strong>
                  <span className="wv-cc-muted">
                    {e.flavour ? ` · ${e.flavour}` : ''}
                    {e.sizeBytes ? ` · ${bytesText(e.sizeBytes)}` : ''}
                    {e.articleCount ? ` · ${e.articleCount.toLocaleString()} pages` : ''}
                    {e.issued ? ` · ${e.issued}` : ''}
                  </span>
                  {e.summary ? <div className="wv-cc-muted">{e.summary}</div> : null}
                </div>
                <Button size="sm" disabled={active || offline} onClick={() => download(e)}>
                  Download
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p>Nothing in the catalogue matched.</p>
        )
      ) : null}
      {st.phase !== 'idle' && st.item !== 'emergency references' ? <DownloadState /> : null}
    </section>
  );
}

function DownloadState() {
  const [cc, store] = useCC();
  const st = cc.libraryDownload;
  const p = st.progress;
  const pct = p && p.bytesTotal ? Math.min(100, (p.bytesDone / p.bytesTotal) * 100) : 0;
  const active = st.phase === 'downloading' || st.phase === 'verifying';
  return (
    <div className="wv-cc-answer" role="status">
      {st.item ? <div className="wv-cc-muted">{st.item}</div> : null}
      {st.step ? (
        <p className="wv-cc-muted">
          {st.step.done} of {st.step.total}
        </p>
      ) : null}
      {p ? (
        <>
          <div className="wv-cc-bar" aria-hidden="true">
            <span style={{ width: `${pct.toFixed(1)}%` }} />
          </div>
          <p className="wv-cc-muted">
            {bytesText(p.bytesDone)} of {bytesText(p.bytesTotal)}
            {p.bytesPerSecond ? ` · ${bytesText(p.bytesPerSecond)}/s` : ''}
            {etaText(p.bytesDone, p.bytesTotal, p.bytesPerSecond)}
            {st.resumedFrom ? ` · carried on from ${bytesText(st.resumedFrom)}` : ''}
          </p>
        </>
      ) : null}
      {st.message ? (
        <p className={st.phase === 'failed' ? 'wv-cc-problem' : ''}>
          {st.message.charAt(0).toUpperCase() + st.message.slice(1)}.
        </p>
      ) : null}
      {st.problems?.length ? (
        <ul className="wv-cc-list wv-cc-list--tight">
          {st.problems.map((x) => (
            <li key={x} className="wv-cc-problem">
              {x}
            </li>
          ))}
        </ul>
      ) : null}
      {active && st.item !== 'emergency references' ? (
        <Button size="sm" variant="ghost" onClick={() => void store.cancelLibraryDownload()}>
          Stop (keeps what is downloaded)
        </Button>
      ) : null}
    </div>
  );
}
