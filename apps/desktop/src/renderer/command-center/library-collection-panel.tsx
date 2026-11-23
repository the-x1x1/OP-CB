import { useMemo, useState } from 'react';
import {
  COLLECTION_ITEM,
  LIBRARY_SUBJECTS,
  planCollection,
  resolvedFromAnswer,
  subjectCounts,
  subjectsOfBook,
  subjectsOfReference,
  type CollectionLookupAnswer,
  type LibrarySubjectId,
} from '@opcb/ipc-contract';
import { Button } from '@opcb/ui';
import { useCC } from './use-cc.js';
import { bytesText } from './map-download-panel.js';
import { flavourText } from './catalog-text.js';
import { BUDGET_CHOICES, budgetBytes, useText, type BudgetChoice } from './collection-text.js';
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
  const [note, setNote] = useState<string | null>(null);
  const inBooks = subject ? books.filter((b) => subjectsOfBook(b).includes(subject)) : [];
  const inRefs = subject ? refs.filter((r) => subjectsOfReference(r).includes(subject)) : [];
  const say = (r: { opened: boolean; message?: string }) => setNote(r.opened ? null : (r.message ?? 'not opened'));
  return (
    <section className="wv-cc-card">
      <h3 className="wv-cc-caps">By subject</h3>
      <p className="wv-cc-muted">What the library holds, under each subject. A book can sit under several.</p>
      <div className="wv-cc-actions" role="group" aria-label="Subjects">
        {LIBRARY_SUBJECTS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`wv-cc-chip${counts[s.id] ? '' : ' wv-cc-chip--muted'}`}
            aria-pressed={subject === s.id}
            title={s.blurb}
            onClick={() => setSubject(subject === s.id ? null : s.id)}
          >
            {s.title} · {counts[s.id]}
          </button>
        ))}
      </div>
      {subject ? (
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
            Nothing under {LIBRARY_SUBJECTS.find((s) => s.id === subject)?.title.toLowerCase()} yet: the starter
            collection below has books for it.
          </p>
        )
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
            className="wv-cc-chip"
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
          <p>
            {plan.picks.length
              ? `${plan.picks.length} books, ${useText(plan.bytes, plan.budgetBytes, bytesText)}.`
              : 'Nothing more fits, or everything chosen is already here.'}
          </p>
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
          {plan.tooBig.length ? (
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
