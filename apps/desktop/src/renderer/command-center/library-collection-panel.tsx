import { useEffect, useMemo, useState } from 'react';
import {
  COLLECTION_ITEM,
  LIBRARY_SUBJECTS,
  shelfView,
  planCollection,
  resolvedFromAnswer,
  subjectCounts,
  subjectsOfReference,
  type CollectionLookupAnswer,
  type ReferenceSearchAnswer,
  type LibrarySubjectId,
} from '@opcb/ipc-contract';
import { Button } from '@opcb/ui';
import { useCC } from './use-cc.js';
import { bytesText } from './map-download-panel.js';
import { flavourText } from './catalog-text.js';
import { BUDGET_CHOICES, budgetBytes, planSummary, type BudgetChoice } from './collection-text.js';
import { DownloadState } from './library-panel.js';

/**
 * The library by subject, and a starter collection fitted to a drive (2026-11-22): medicine,
 * growing and keeping food, building, trades, machines, survival, radio and navigation,
 * teaching and science — chosen from the Kiwix catalogue, the fullest edition of each book
 * that fits, the essentials first.
 */

/** What edition a file-name start is (`_nopic` → "full text, no pictures"); none for a single-edition book. */
function editionOf(file: string): string | undefined {
  return flavourText(/_(maxi|nopic|mini)$/.exec(file)?.[1]);
}

function toggle(list: LibrarySubjectId[], id: LibrarySubjectId): LibrarySubjectId[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

export function SubjectShelf() {
  const [cc, store] = useCC();
  const books = cc.shelf?.books ?? [];
  const refs = (cc.shelf?.references ?? []).filter((r) => r.installed);
  const counts = useMemo(() => subjectCounts(books, refs), [books, refs]);
  const [subject, setSubject] = useState<LibrarySubjectId | null>(null);
  const [query, setQuery] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const view = useMemo(() => shelfView(books, refs, subject, query), [books, refs, subject, query]);
  // Inside the guides: their pages searched once typing pauses.
  const [inside, setInside] = useState<{ query: string; answer: ReferenceSearchAnswer | { failed: string } } | null>(
    null,
  );
  const refCount = refs.length;
  useEffect(() => {
    const q = query.trim();
    if (!q || q.length > 200 || refCount === 0) {
      setInside(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void store.searchReferences(q).then((answer) => {
        if (live) setInside({ query: q, answer });
      });
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, refCount, store]);
  const insideHits =
    inside && 'hits' in inside.answer
      ? subject
        ? inside.answer.hits.filter((h) => {
            const r = refs.find((x) => x.id === h.id);
            return r ? subjectsOfReference(r).includes(subject) : false;
          })
        : inside.answer.hits
      : [];
  const finding = view.searched;
  const inBooks = view.books;
  const inRefs = view.refs;
  const say = (r: { opened: boolean; message?: string }) => setNote(r.opened ? null : (r.message ?? 'not opened'));
  return (
    <section className="wv-cc-card">
      <h3 className="wv-cc-caps">By subject</h3>
      <p className="wv-cc-muted">What the library holds, under each subject. A book can sit under several.</p>
      <div className="wv-cc-inline">
        <input
          className="wv-input"
          type="search"
          placeholder="Find a book or guide by its title or what it covers (canning, splint, antenna…)"
          aria-label="Find in the library by title or topic"
          maxLength={200}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="wv-cc-actions" role="group" aria-label="Subjects">
        {LIBRARY_SUBJECTS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`wv-cc-pick${counts[s.id] ? '' : ' wv-cc-pick--empty'}`}
            aria-pressed={subject === s.id}
            title={s.blurb}
            onClick={() => setSubject(subject === s.id ? null : s.id)}
          >
            {s.title} · {counts[s.id]}
          </button>
        ))}
      </div>
      {subject || finding ? (
        inBooks.length || inRefs.length ? (
          <ul className="wv-cc-list">
            {inBooks.map((b) => (
              <li key={b.id} className="wv-cc-libbook">
                <div>
                  <strong>{b.title}</strong>
                  <span className="wv-cc-muted"> · {bytesText(b.sizeBytes)}</span>
                </div>
                <Button
                  size="sm"
                  disabled={!b.readable}
                  onClick={() => void store.openLibrary({ kind: 'book', bookId: b.id }).then(say)}
                >
                  Open
                </Button>
              </li>
            ))}
            {inRefs.map((r) => (
              <li key={r.id} className="wv-cc-libbook">
                <div>
                  <strong>{r.title}</strong>
                  <span className="wv-cc-muted"> · {r.publisher}</span>
                </div>
                <Button size="sm" onClick={() => void store.openLibrary({ kind: 'reference', id: r.id }).then(say)}>
                  Open
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="wv-cc-muted">
            {finding
              ? 'No book or guide has that in its title or description. Inside a book, the library search above finds article titles.'
              : `Nothing under ${LIBRARY_SUBJECTS.find((s) => s.id === subject)?.title.toLowerCase()} yet: the starter collection below has books for it.`}
          </p>
        )
      ) : null}
      {finding && inside ? (
        <>
          <h4>Inside the guides</h4>
          {'failed' in inside.answer ? (
            <p className="wv-cc-problem">{inside.answer.failed}</p>
          ) : insideHits.length ? (
            <ul className="wv-cc-list">
              {insideHits.map((h) => (
                <li key={`${h.id}:${h.page}`} className="wv-cc-libbook">
                  <div>
                    <strong>{h.title}</strong>
                    <span className="wv-cc-muted"> · page {h.page}</span>
                    <div className="wv-cc-muted">{h.snippet}</div>
                  </div>
                  <Button size="sm" onClick={() => void store.openLibrary({ kind: 'reference', id: h.id }).then(say)}>
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="wv-cc-muted">
              No page of the {inside.answer.searched} downloaded guide{inside.answer.searched === 1 ? '' : 's'} has
              every word.
            </p>
          )}
          {'unreadable' in inside.answer && inside.answer.unreadable.length ? (
            <p className="wv-cc-muted">
              Not searched: {inside.answer.unreadable.map((u) => `${u.title} (${u.why})`).join('; ')}.
            </p>
          ) : null}
        </>
      ) : null}
      {note ? <p className="wv-cc-problem">{note}</p> : null}
    </section>
  );
}

export function StarterCollection() {
  const [cc, store] = useCC();
  const st = cc.libraryDownload;
  const offline = cc.mode?.chosen === 'offline';
  const busy = st.phase === 'downloading' || st.phase === 'verifying';
  const [choice, setChoice] = useState<BudgetChoice>('free');
  const [subjects, setSubjects] = useState<LibrarySubjectId[]>([]);
  const [answer, setAnswer] = useState<CollectionLookupAnswer | null>(null);
  const [looking, setLooking] = useState(false);
  const budget = budgetBytes(choice, cc.shelf?.freeBytes);
  const plan = useMemo(
    () =>
      answer?.ok && budget !== undefined
        ? planCollection(resolvedFromAnswer(answer), budget, {
            haveFiles: (cc.shelf?.books ?? []).map((b) => b.file),
            subjects,
          })
        : null,
    [answer, budget, cc.shelf, subjects],
  );
  const summary = plan ? planSummary(plan, choice, bytesText) : null;
  const lookUp = async () => {
    setLooking(true);
    try {
      setAnswer(await store.lookupCollection({ language: 'eng' }));
    } finally {
      setLooking(false);
    }
  };
  return (
    <section className="wv-cc-card">
      <h3 className="wv-cc-caps">Starter collection</h3>
      <p className="wv-cc-muted">
        A library for when the internet is gone: medicine, water and food, growing, building, repair, survival, radio
        and travel, textbooks and all of Wikipedia — the fullest edition of each that fits, the essentials first.
        Everything comes from library.kiwix.org and keeps its own licence.
      </p>
      <div className="wv-cc-inline">
        <select
          className="wv-input"
          value={choice}
          aria-label="How much room"
          onChange={(e) => setChoice(e.target.value as BudgetChoice)}
        >
          {BUDGET_CHOICES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <Button size="sm" disabled={looking || offline} onClick={() => void lookUp()}>
          {looking ? 'Looking…' : answer ? 'Look again' : 'Look up the collection'}
        </Button>
      </div>
      <div className="wv-cc-actions" role="group" aria-label="Only these subjects">
        {LIBRARY_SUBJECTS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="wv-cc-pick"
            aria-pressed={subjects.includes(s.id)}
            title={s.blurb}
            onClick={() => setSubjects(toggle(subjects, s.id))}
          >
            {s.title}
          </button>
        ))}
      </div>
      <p className="wv-cc-muted">
        {subjects.length ? 'Only books for the subjects chosen.' : 'Every subject; choose some to narrow it.'}
      </p>
      {offline ? <p className="wv-cc-muted">The catalogue and downloads need Online mode.</p> : null}
      {choice === 'free' && budget === undefined ? (
        <p className="wv-cc-muted">The free space of the library’s drive is not known: choose a drive size.</p>
      ) : null}
      {answer && !answer.ok ? (
        <p className="wv-cc-problem">{answer.message ?? 'the catalogue did not answer'}</p>
      ) : null}
      {plan ? (
        <>
          <p>{summary?.line}</p>
          {plan.picks.length ? (
            <ul className="wv-cc-list">
              {plan.picks.map((p) => (
                <li key={p.item.id} className="wv-cc-libbook">
                  <div>
                    <strong>{p.item.title}</strong>
                    <span className="wv-cc-muted">
                      {' '}
                      · {bytesText(p.entry.sizeBytes ?? 0)}
                      {editionOf(p.file) ? ` · ${editionOf(p.file)}` : ''}
                    </span>
                    <div className="wv-cc-muted">
                      {p.item.why}
                      {p.smaller ? ' — a smaller edition, to fit' : ''}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {plan.have.length ? <p className="wv-cc-muted">Already in the library: {plan.have.length}.</p> : null}
          {plan.tooBig.length && summary?.listTooBig ? (
            <p className="wv-cc-muted">
              Too big for what is left:{' '}
              {plan.tooBig.map((t) => `${t.item.title} (${bytesText(t.smallestBytes)})`).join(', ')}.
            </p>
          ) : null}
          {plan.missing.length ? (
            <p className="wv-cc-muted">Not in the catalogue now: {plan.missing.map((m) => m.title).join(', ')}.</p>
          ) : null}
          {answer?.notes.length ? (
            <p className="wv-cc-muted">Some questions failed: {answer.notes.join('; ')}.</p>
          ) : null}
          <div className="wv-cc-actions">
            <Button
              size="sm"
              variant="primary"
              disabled={!plan.picks.length || busy || offline}
              onClick={() =>
                void store.startLibraryDownload({ kind: 'collection', entries: plan.picks.map((p) => p.entry) })
              }
            >
              {plan.picks.length ? `Download ${plan.picks.length} (${bytesText(plan.bytes)})` : 'Nothing to download'}
            </Button>
          </div>
        </>
      ) : null}
      {st.item === COLLECTION_ITEM && st.phase !== 'idle' ? <DownloadState /> : null}
      <p className="wv-cc-muted">
        Big downloads take hours; a stop or a restart carries on where it left off. Medical books are references, not a
        doctor.
      </p>
    </section>
  );
}
