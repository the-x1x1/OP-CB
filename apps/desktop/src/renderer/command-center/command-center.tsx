import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  DEFAULT_SERVICE_PORTS,
  LOCAL_SERVICE_IDS,
  MAX_LOCAL_HOSTS,
  localHostProblem,
  normaliseLocalHost,
  type LocalServiceId,
  type PrepRecord,
} from '@worldview/ipc-contract';
import { Button, Icon, type IconName } from '@worldview/ui';
import { useActions, useAppSlice } from '../store/store.js';
import { MESH_PROVIDER, RECEIVER_PROVIDERS } from './checks.js';
import { completion } from './guide-engine.js';
import type { GuideDefinition, SectionId } from './guide-types.js';
import { COMPLETION_LABEL, GuideRunner } from './guide-runner.js';
import { guideById, guidesFor } from './guides/index.js';
import { dueItems, readinessSummary, type ReadinessItem, type ReadinessStatus } from './readiness.js';
import { useCC, useReadiness, useSaveSettings, useShellFacts } from './use-cc.js';
import {
  AiTest,
  ConfirmButton,
  LibrarySearch,
  MeshNodes,
  MeshTest,
  ModeSwitch,
  PrepForm,
  QuantityCell,
  categoryLabel,
  useAddStarter,
} from './widgets.js';
import { MapDownloadPanel } from './map-download-panel.js';
import { DataLocationCard } from './data-location-card.js';
import { BuiltInLibrary, EmergencyReferences, KiwixCatalog } from './library-panel.js';
import './command-center.css';

/** One empty list for selectors: a new [] each read would never settle. */
const NONE: readonly never[] = Object.freeze([]);

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string; icon: IconName; hint: string }> = [
  { id: 'overview', label: 'Overview', icon: 'activity', hint: 'What is ready, and why the rest is not' },
  { id: 'world', label: 'World & Maps', icon: 'globe', hint: 'The live map, offline maps and sources' },
  { id: 'knowledge', label: 'Knowledge', icon: 'bookmark', hint: 'Offline library and courses' },
  { id: 'intelligence', label: 'Local Intelligence', icon: 'command', hint: 'A local AI model, optional' },
  { id: 'comms', label: 'Communications', icon: 'link', hint: 'Meshtastic radio, receivers and GPS' },
  { id: 'prepare', label: 'Preparedness', icon: 'list', hint: 'Supplies, equipment and contacts' },
  { id: 'resources', label: 'Resources', icon: 'database', hint: 'Packs, drives, local services and network' },
];

export const STATUS_LABEL: Record<ReadinessStatus, string> = {
  ready: 'Ready',
  'verification-required': 'Verification required',
  'setup-required': 'Setup required',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
};

const STATUS_TONE: Record<ReadinessStatus, string> = {
  ready: 'ok',
  'verification-required': 'warn',
  'setup-required': 'muted',
  degraded: 'bad',
  unavailable: 'muted',
};

/**
 * The Command Center (2026-10-30): the first thing after the start screen, and a key away
 * after that. Seven sections over the map; the map itself — every existing WorldView view, panel
 * and tool — is World & Maps → "Show the map", untouched underneath.
 */
export function CommandCenter() {
  const [cc, store] = useCC();
  // Ctrl+Shift+O opens it from anywhere, once a mode is chosen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'O' || e.key === 'o') && store.get().mode?.chosen) {
        e.preventDefault();
        if (store.get().open) store.close();
        else store.openAt();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);
  useEffect(() => {
    if (!cc.open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !cc.guideId) store.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cc.open, cc.guideId, store]);
  if (!cc.open) return null;
  const guide = cc.guideId ? guideById(cc.guideId) : undefined;
  return (
    <div className="wv-cc" role="dialog" aria-modal="false" aria-label="Command Center">
      <nav className="wv-cc__nav" aria-label="Command Center sections">
        <div className="wv-cc__brand">
          <span>WORLDVIEW</span>
          <span className="wv-cc-caps">Command Center</span>
        </div>
        <ModeSwitch compact />
        <ul>
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={`wv-cc__navitem${cc.section === s.id && !guide ? ' wv-cc__navitem--on' : ''}`}
                aria-current={cc.section === s.id ? 'page' : undefined}
                onClick={() => store.show(s.id)}
                title={s.hint}
              >
                <Icon name={s.icon} size={16} />
                <span>{s.label}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="wv-cc__navfoot">
          <Button variant="primary" icon="globe" onClick={() => store.close()}>
            Show the map
          </Button>
          <span className="wv-cc-muted">Esc closes · Ctrl+Shift+O opens</span>
        </div>
      </nav>
      <main className="wv-cc__main">{guide ? <GuideRunner def={guide} /> : <Section id={cc.section} />}</main>
    </div>
  );
}

function Section({ id }: { id: SectionId }) {
  switch (id) {
    case 'overview':
      return <Overview />;
    case 'world':
      return <World />;
    case 'knowledge':
      return <Knowledge />;
    case 'intelligence':
      return <Intelligence />;
    case 'comms':
      return <Comms />;
    case 'prepare':
      return <Prepare />;
    case 'resources':
      return <Resources />;
  }
}

function SectionHead({ id, children }: { id: SectionId; children?: ReactNode }) {
  const s = SECTIONS.find((x) => x.id === id)!;
  const [, store] = useCC();
  const first = guidesFor(id)[0];
  return (
    <header className="wv-cc-head">
      <div>
        <h2>{s.label}</h2>
        <p className="wv-cc-muted">{s.hint}</p>
      </div>
      <div className="wv-cc-head__tools">
        {children}
        {first ? (
          <Button size="sm" icon="info" onClick={() => store.openGuide(first.id)}>
            How do I set this up?
          </Button>
        ) : null}
      </div>
    </header>
  );
}

function GuideCards({ section }: { section: SectionId }) {
  const [cc, store] = useCC();
  const list = guidesFor(section);
  if (!list.length) return null;
  return (
    <section className="wv-cc-card">
      <h3 className="wv-cc-caps">Walkthroughs</h3>
      <ul className="wv-cc-guides">
        {list.map((g) => (
          <GuideCard
            key={g.id}
            def={g}
            status={
              COMPLETION_LABEL[
                completion(
                  g,
                  cc.guides.find((x) => x.id === g.id),
                )
              ]
            }
            onOpen={() => store.openGuide(g.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function GuideCard({ def, status, onOpen }: { def: GuideDefinition; status: string; onOpen: () => void }) {
  return (
    <li className="wv-cc-guidecard">
      <button type="button" onClick={onOpen}>
        <span className="wv-cc-guidecard__title">{def.title}</span>
        <span className="wv-cc-muted">{def.summary}</span>
        <span className="wv-cc-chip wv-cc-chip--muted">{status}</span>
      </button>
    </li>
  );
}

function ReadinessRow({ item }: { item: ReadinessItem }) {
  const [, store] = useCC();
  return (
    <li className="wv-cc-ready">
      <span className={`wv-cc-chip wv-cc-chip--${STATUS_TONE[item.status]}`}>{STATUS_LABEL[item.status]}</span>
      <span className="wv-cc-ready__label">
        {item.label}
        {item.optional ? <span className="wv-cc-muted"> · optional</span> : null}
      </span>
      <span className="wv-cc-ready__why">{item.reason}</span>
      {item.guideId && item.status !== 'ready' && item.status !== 'unavailable' ? (
        <Button size="sm" variant="ghost" onClick={() => store.openGuide(item.guideId!)}>
          {item.status === 'verification-required' ? 'Test' : 'Set up'}
        </Button>
      ) : (
        <span />
      )}
    </li>
  );
}

// ---- Overview ------------------------------------------------------------------------------

function Overview() {
  const [cc, store] = useCC();
  const items = useReadiness();
  const sum = readinessSummary(items);
  const mode = cc.mode;
  return (
    <div className="wv-cc-section">
      <SectionHead id="overview">
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => void store.refreshServices()}>
          {cc.servicesBusy ? 'Looking…' : 'Look again'}
        </Button>
      </SectionHead>
      <div className="wv-cc-grid">
        <section className="wv-cc-card">
          <h3 className="wv-cc-caps">Mode</h3>
          <ModeSwitch />
          <p>
            {mode?.chosen === 'offline'
              ? 'Offline: WorldView sends nothing to the internet. Sources on the internet are paused; what is on this computer keeps working.'
              : 'Online: internet sources, map tiles and updates are in use.'}
          </p>
          <p className="wv-cc-muted">
            <span className={`wv-cc-dot wv-cc-dot--${mode?.osOnline ? 'ok' : 'off'}`} aria-hidden="true" /> This
            computer reports {mode?.osOnline ? 'a network connection' : 'no network connection'} (information only).
            {mode?.localHosts.length
              ? ` ${mode.localHosts.length} device(s) on your network approved for offline use.`
              : ''}{' '}
            Offline is enforced on WorldView&apos;s own requests; it is not a firewall for other programs.
          </p>
        </section>
        <section className="wv-cc-card">
          <h3 className="wv-cc-caps">If the internet goes</h3>
          <p className="wv-cc-big">
            {sum.ready} of {sum.total} <span className="wv-cc-muted">essentials ready</span>
          </p>
          <p className="wv-cc-muted">
            Ready means set up and its walkthrough&apos;s final test passed.{' '}
            {sum.attention ? `${sum.attention} need attention now.` : ''}
          </p>
          <Button size="sm" onClick={() => store.openGuide('getting-started')}>
            Getting started
          </Button>
        </section>
      </div>
      <section className="wv-cc-card">
        <h3 className="wv-cc-caps">Readiness</h3>
        <ul className="wv-cc-readylist">
          {items.map((i) => (
            <ReadinessRow key={i.id} item={i} />
          ))}
        </ul>
      </section>
      <GuideCards section="overview" />
    </div>
  );
}

// ---- World & Maps --------------------------------------------------------------------------

function World() {
  const [, store] = useCC();
  const actions = useActions();
  const { offline, settings } = useShellFacts();
  const profile = settings?.display.profile ?? 'balanced';
  const packs = offline?.packs ?? [];
  return (
    <div className="wv-cc-section">
      <SectionHead id="world" />
      <div className="wv-cc-grid">
        <section className="wv-cc-card">
          <h3 className="wv-cc-caps">The map</h3>
          <p>
            Aircraft, ships, satellites, weather, hazards, your receivers, history and the timeline, saved places and
            watch zones: all on the map, as before.
          </p>
          <div className="wv-cc-actions">
            <Button variant="primary" icon="globe" onClick={() => store.close()}>
              Show the map
            </Button>
            <Button
              onClick={() => {
                store.close();
                actions.setContextTab('sources');
              }}
            >
              Sources
            </Button>
            <Button
              onClick={() => {
                store.close();
                actions.openDialog('settings');
              }}
            >
              Settings
            </Button>
          </div>
        </section>
        <section className="wv-cc-card">
          <h3 className="wv-cc-caps">Operating profile</h3>
          <div className="wv-cc-modeswitch" role="group" aria-label="Profile">
            {(['field', 'balanced', 'docked'] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={`wv-cc-seg${profile === p ? ' wv-cc-seg--on' : ''}`}
                aria-pressed={profile === p}
                onClick={() => void actions.setProfile(p)}
              >
                {p === 'field' ? 'Field' : p === 'balanced' ? 'Balanced' : 'Docked'}
              </button>
            ))}
          </div>
          <p className="wv-cc-muted">
            Field: low graphics, the 2D map and internet sources polled a third as often, to save battery. Docked: full
            graphics and the 3D globe. Your own radios and receivers are never slowed.
          </p>
        </section>
      </div>
      <section className="wv-cc-card">
        <h3 className="wv-cc-caps">Download a map for offline use</h3>
        <MapDownloadPanel />
      </section>
      <section className="wv-cc-card">
        <h3 className="wv-cc-caps">Offline maps</h3>
        <p>
          {offline?.capabilities.localMap
            ? `${packs.filter((p) => p.status === 'active').length} pack(s) give a detailed map offline.`
            : 'No detailed map is installed for offline use: offline, the bundled world map and tiles you have already viewed are drawn.'}{' '}
          {offline?.capabilities.localSearch ? 'Places in your packs are searchable offline.' : ''}
        </p>
        <PackList />
      </section>
      <GuideCards section="world" />
    </div>
  );
}

function PackList() {
  const actions = useActions();
  const packs = useAppSlice((s) => s.offline.status?.packs) ?? NONE;
  if (!packs.length) return <p className="wv-cc-muted">No packs installed.</p>;
  return (
    <ul className="wv-cc-table">
      {packs.map((p) => (
        <li key={p.id}>
          <span
            className={`wv-cc-chip wv-cc-chip--${p.status === 'active' ? 'ok' : p.status === 'invalid' ? 'bad' : 'muted'}`}
          >
            {p.status}
          </span>
          <strong>{p.name}</strong>
          <span className="wv-cc-muted">
            {p.version} · {(p.sizeBytes / 1e6).toFixed(0)} MB{p.vault ? ` · on ${p.vault.label}` : ''}
            {p.signature ? ` · ${p.signature.status}${p.signature.publisher ? ` (${p.signature.publisher})` : ''}` : ''}
            {p.message ? ` · ${p.message}` : ''}
          </span>
          <span className="wv-cc-rowtools">
            {p.status !== 'invalid' ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void actions.setPackEnabled(p.id, p.status !== 'active')}
              >
                {p.status === 'active' ? 'Switch off' : 'Switch on'}
              </Button>
            ) : null}
            <ConfirmButton label="Remove" confirm="Delete pack file" onConfirm={() => void actions.removePack(p.id)} />
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---- Knowledge -----------------------------------------------------------------------------

function ServiceLine({ id }: { id: LocalServiceId }) {
  const [cc, store] = useCC();
  const s = cc.services?.find((x) => x.id === id);
  if (!s) return <p className="wv-cc-muted">{cc.servicesBusy ? 'Looking…' : 'Not asked yet.'}</p>;
  return (
    <p className="wv-cc-svc">
      <span
        className={`wv-cc-chip wv-cc-chip--${s.state === 'running' ? 'ok' : s.state === 'not-found' ? 'muted' : 'bad'}`}
      >
        {s.state === 'running'
          ? 'Running'
          : s.state === 'not-found'
            ? 'Not found'
            : s.state === 'other'
              ? 'Port taken'
              : 'Error'}
      </span>
      <span>
        {s.name}
        {s.version ? ` ${s.version}` : ''} at {s.endpoint}
        {s.detail ? ` — ${s.detail}` : ''}
      </span>
      {s.state === 'running' && id !== 'ollama' ? (
        <Button size="sm" variant="ghost" icon="external" onClick={() => void store.openService(id)}>
          Open
        </Button>
      ) : null}
    </p>
  );
}

function Knowledge() {
  const [cc] = useCC();
  const books = cc.services?.find((s) => s.id === 'kiwix')?.books ?? [];
  return (
    <div className="wv-cc-section">
      <SectionHead id="knowledge" />
      <BuiltInLibrary />
      <EmergencyReferences />
      <KiwixCatalog />
      <section className="wv-cc-card">
        <h3 className="wv-cc-caps">Kiwix server (optional)</h3>
        <p className="wv-cc-muted">
          Not needed to read ZIM files any more. A running kiwix-serve adds full-text search and older files WorldView
          cannot open itself.
        </p>
        <ServiceLine id="kiwix" />
        {books.length ? (
          <>
            <ul className="wv-cc-books">
              {books.slice(0, 40).map((b) => (
                <li key={b.id}>
                  {b.title}
                  {b.language ? <span className="wv-cc-muted"> · {b.language}</span> : null}
                </li>
              ))}
            </ul>
            <LibrarySearch />
          </>
        ) : null}
      </section>
      <section className="wv-cc-card">
        <h3 className="wv-cc-caps">Courses (Kolibri)</h3>
        <ServiceLine id="kolibri" />
      </section>
      <GuideCards section="knowledge" />
    </div>
  );
}

// ---- Local Intelligence --------------------------------------------------------------------

function Intelligence() {
  const [cc] = useCC();
  const { settings } = useShellFacts();
  const saveSettings = useSaveSettings();
  const ollama = cc.services?.find((s) => s.id === 'ollama');
  const models = ollama?.models ?? [];
  const chosen = settings?.services?.aiModel;
  return (
    <div className="wv-cc-section">
      <SectionHead id="intelligence" />
      <section className="wv-cc-card">
        <h3 className="wv-cc-caps">Local model</h3>
        <ServiceLine id="ollama" />
        {models.length ? (
          <label className="wv-cc-field">
            Model
            <select
              className="wv-input"
              value={chosen ?? ''}
              onChange={(e) => void saveSettings({ services: { ...settings?.services, aiModel: e.target.value } })}
            >
              <option value="" disabled>
                Choose one
              </option>
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                  {m.parameterSize ? ` · ${m.parameterSize}` : ''}
                  {m.sizeBytes ? ` · ${(m.sizeBytes / 1e9).toFixed(1)} GB` : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <p className="wv-cc-muted">
          Runs entirely on this computer. On a laptop processor expect a few words a second, a long first answer while
          the model loads, and a lot of battery use. WorldView works the same without it.
        </p>
      </section>
      {chosen && ollama?.state === 'running' ? (
        <>
          <section className="wv-cc-card">
            <h3 className="wv-cc-caps">Ask the model</h3>
            <AiTest />
          </section>
          <GroundedAsk model={chosen} />
        </>
      ) : null}
      <GuideCards section="intelligence" />
    </div>
  );
}

/**
 * A question answered from the operator's library: the library is searched, the passages it
 * finds are shown as retrieved (with their pages), and only then is the model asked to answer
 * from them — its answer labelled as generated. Nothing is sent anywhere but this computer.
 */
function GroundedAsk({ model }: { model: string }) {
  const [cc, store] = useCC();
  // The built-in library first (every readable ZIM file); a running kiwix-serve otherwise.
  const builtIn = (cc.shelf?.books ?? []).filter((b) => b.readable && b.titleSearch);
  const served = (cc.services?.find((s) => s.id === 'kiwix')?.books ?? []).filter((b) => b.name);
  const books = builtIn.length
    ? [
        { id: '', name: '', title: 'Every book in your library' },
        ...builtIn.map((b) => ({ id: b.id, name: b.id, title: b.title })),
      ]
    : served.map((b) => ({ id: b.id, name: b.name!, title: b.title }));
  const [book, setBook] = useState('');
  const [question, setQuestion] = useState('');
  const [retrieved, setRetrieved] = useState<Array<{
    title: string;
    path: string;
    snippet?: string;
    bookId?: string;
  }> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void store.refreshShelf();
  }, [store]);
  if (!books.length) return null;
  const chosen = books.some((b) => b.name === book) ? book : books[0]!.name;
  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    setProblem(null);
    setAnswer(null);
    try {
      let hits: Array<{ title: string; path: string; snippet?: string; bookId?: string }>;
      if (builtIn.length) {
        const found = await store.findInLibrary({
          query: q,
          withText: true,
          limit: 8,
          ...(chosen ? { bookId: chosen } : {}),
        });
        hits = found.hits
          .filter((h) => h.text)
          .slice(0, 4)
          .map((h) => ({ title: h.title, path: h.key, snippet: h.text!.slice(0, 450), bookId: h.bookId }));
      } else {
        const found = await store.librarySearch(chosen, q);
        if (!found.ok) {
          setRetrieved([]);
          return setProblem(found.message ?? 'The library did not answer.');
        }
        hits = found.hits.filter((h) => h.snippet).slice(0, 4);
      }
      setRetrieved(hits);
      if (!hits.length)
        return setProblem(
          builtIn.length
            ? 'No page title matched the words of the question, so the model was not asked. Try naming the subject (water purification, burns…).'
            : 'Nothing in that book matched, so the model was not asked.',
        );
      const excerpts = hits.map((h, i) => `[${i + 1}] ${h.title}: ${h.snippet}`).join('\n');
      const prompt =
        `Answer the question using only the numbered excerpts below, and cite them like [1]. If they do not answer it, say so.\n\nExcerpts:\n${excerpts}\n\nQuestion: ${q}`.slice(
          0,
          2000,
        );
      const a = await store.aiTest(model, prompt);
      if (a.ok) setAnswer(a.text ?? '');
      else setProblem(a.message ?? 'The model did not answer.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="wv-cc-card">
      <h3 className="wv-cc-caps">Ask with your library</h3>
      <form className="wv-cc-inline" onSubmit={(e) => void ask(e)}>
        <select className="wv-input" value={chosen} onChange={(e) => setBook(e.target.value)} aria-label="Book">
          {books.map((b) => (
            <option key={b.id || 'all'} value={b.name}>
              {b.title}
            </option>
          ))}
        </select>
        <input
          className="wv-input"
          placeholder="Your question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <Button size="sm" type="submit" disabled={busy || !question.trim()}>
          {busy ? 'Searching and asking…' : 'Ask'}
        </Button>
      </form>
      {retrieved?.length ? (
        <div className="wv-cc-answer">
          <div className="wv-cc-answer__label">Retrieved from your library (search excerpts)</div>
          <ol>
            {retrieved.map((h) => (
              <li key={h.path}>
                <button
                  type="button"
                  className="wv-cc-link"
                  onClick={() =>
                    void (h.bookId
                      ? store.openLibrary({ kind: 'book', bookId: h.bookId, key: h.path })
                      : store.openService('kiwix', h.path))
                  }
                >
                  {h.title}
                </button>
                <span className="wv-cc-muted"> — {h.snippet}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {answer !== null ? (
        <div className="wv-cc-answer">
          <div className="wv-cc-answer__label">
            Model-generated answer from those excerpts — check it against the pages; not emergency or medical advice
          </div>
          <p>{answer}</p>
        </div>
      ) : null}
      {problem ? <p className="wv-cc-problem">{problem}</p> : null}
    </section>
  );
}

// ---- Communications ------------------------------------------------------------------------

function Comms() {
  const [cc, store] = useCC();
  const actions = useActions();
  const { sources } = useShellFacts();
  const mesh = sources.find((e) => e.providerId === MESH_PROVIDER);
  useEffect(() => {
    if (mesh?.enabled) void store.refreshMeshNodes();
  }, [mesh?.enabled, store]);
  const own = mesh?.health.ownPosition;
  return (
    <div className="wv-cc-section">
      <SectionHead id="comms">
        <Button
          size="sm"
          onClick={() => {
            store.close();
            actions.setContextTab('connections');
          }}
        >
          Connections tab
        </Button>
      </SectionHead>
      <section className="wv-cc-card">
        <h3 className="wv-cc-caps">Meshtastic radio</h3>
        {mesh ? (
          <>
            <p>
              <span
                className={`wv-cc-chip wv-cc-chip--${mesh.enabled && mesh.health.status === 'LIVE' ? 'ok' : mesh.enabled ? 'warn' : 'muted'}`}
              >
                {mesh.enabled ? mesh.health.status.replace('_', ' ') : 'OFF'}
              </span>{' '}
              {mesh.enabled ? (mesh.health.message ?? '') : 'The Meshtastic source is off.'}
            </p>
            <p className="wv-cc-muted">
              Own GPS:{' '}
              {own
                ? own.state === 'fix'
                  ? `fix${own.fixType ? ` ${own.fixType}` : ''}${own.satellites !== undefined ? `, ${own.satellites} satellites` : ''}`
                  : own.state === 'no-fix'
                    ? 'NO FIX'
                    : own.state
                : 'not reported'}
            </p>
            {mesh.enabled ? (
              <>
                <div className="wv-cc-actions">
                  <Button size="sm" variant="ghost" icon="refresh" onClick={() => void store.refreshMeshNodes()}>
                    Refresh radios
                  </Button>
                </div>
                <MeshNodes />
                <h4>Test message</h4>
                <p className="wv-cc-muted">
                  Sent only when you press Transmit, to one radio, on your primary channel. Refused while your radio has
                  no region set.
                </p>
                <MeshTest />
              </>
            ) : null}
          </>
        ) : (
          <p className="wv-cc-muted">This build has no Meshtastic source.</p>
        )}
      </section>
      <section className="wv-cc-card">
        <h3 className="wv-cc-caps">Receivers (receive only)</h3>
        {RECEIVER_PROVIDERS.map((id) => {
          const e = sources.find((x) => x.providerId === id);
          if (!e) return null;
          return (
            <p key={id}>
              <span
                className={`wv-cc-chip wv-cc-chip--${e.enabled && e.health.status === 'LIVE' ? 'ok' : e.enabled ? 'warn' : 'muted'}`}
              >
                {e.enabled ? e.health.status.replace('_', ' ') : 'OFF'}
              </span>{' '}
              {e.name}
              {e.enabled && e.health.message ? <span className="wv-cc-muted"> — {e.health.message}</span> : null}
            </p>
          );
        })}
        <p className="wv-cc-muted">An RTL-SDR only receives: WorldView never transmits through a receiver.</p>
        {cc.receiverObjects !== null ? (
          <p className="wv-cc-muted">{cc.receiverObjects} objects heard by your own receivers now.</p>
        ) : null}
      </section>
      <GuideCards section="comms" />
    </div>
  );
}

// ---- Preparedness --------------------------------------------------------------------------

function Prepare() {
  const [cc, store] = useCC();
  const addStarter = useAddStarter();
  const [note, setNote] = useState<string | null>(null);
  const now = Date.now();
  const due = useMemo(() => dueItems(cc.prep, now), [cc.prep, now]);
  const items = cc.prep.filter((r) => r.kind === 'item');
  const contacts = cc.prep.filter((r) => r.kind === 'contact');
  const notes = cc.prep.filter((r) => r.kind === 'note');
  const byCat = new Map<string, PrepRecord[]>();
  for (const r of items) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
  return (
    <div className="wv-cc-section">
      <SectionHead id="prepare">
        <Button size="sm" onClick={() => void store.exportPrep('csv').then((p) => setNote(p ? `Saved to ${p}` : null))}>
          Save checklist (CSV)…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void store.exportPrep('json').then((p) => setNote(p ? `Backed up to ${p}` : null))}
        >
          Back up (JSON)…
        </Button>
      </SectionHead>
      {note ? <p className="wv-cc-muted">{note}</p> : null}
      <p className="wv-cc-muted">
        Kept on this computer only; it leaves only through a file you save. Your record, not advice: for what to keep,
        follow your emergency management agency.
      </p>
      {due.expired.length || due.soon.length ? (
        <section className="wv-cc-card wv-cc-card--warn">
          <h3 className="wv-cc-caps">Due</h3>
          <ul className="wv-cc-list wv-cc-list--tight">
            {due.expired.map((r) => (
              <li key={r.id}>
                <span className="wv-cc-chip wv-cc-chip--bad">Expired</span> {r.name} {r.expires ? `(${r.expires})` : ''}
              </li>
            ))}
            {due.soon.map((r) => (
              <li key={r.id}>
                <span className="wv-cc-chip wv-cc-chip--warn">Within 30 days</span> {r.name}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="wv-cc-card">
        <h3 className="wv-cc-caps">Add</h3>
        <PrepForm />
        {!items.length ? (
          <Button size="sm" variant="ghost" onClick={() => void addStarter()}>
            Add a starter list to count
          </Button>
        ) : null}
      </section>
      <section className="wv-cc-card">
        <h3 className="wv-cc-caps">Supplies and equipment</h3>
        {items.length ? (
          [...byCat.entries()].map(([cat, rs]) => (
            <div key={cat} className="wv-cc-prepcat">
              <h4>{categoryLabel(cat as PrepRecord['category'])}</h4>
              <ul className="wv-cc-table">
                {rs.map((r) => (
                  <li key={r.id}>
                    <QuantityCell record={r} />
                    <span>{r.unit ?? ''}</span>
                    <strong>{r.name}</strong>
                    <span className="wv-cc-muted">
                      {r.expires ? `expires ${r.expires}` : ''}
                      {r.notes ? ` · ${r.notes}` : ''}
                    </span>
                    <ConfirmButton label="Remove" confirm="Remove" onConfirm={() => void store.deletePrep(r.id)} />
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p className="wv-cc-muted">Nothing recorded yet.</p>
        )}
      </section>
      <section className="wv-cc-card">
        <h3 className="wv-cc-caps">Emergency contacts and notes</h3>
        <ul className="wv-cc-table">
          {[...contacts, ...notes].map((r) => (
            <li key={r.id}>
              <strong>{r.name}</strong>
              <span>{r.phone ?? ''}</span>
              <span className="wv-cc-muted">{r.notes ?? ''}</span>
              <ConfirmButton label="Remove" confirm="Remove" onConfirm={() => void store.deletePrep(r.id)} />
            </li>
          ))}
          {!contacts.length && !notes.length ? <li className="wv-cc-muted">None yet.</li> : null}
        </ul>
      </section>
      <GuideCards section="prepare" />
    </div>
  );
}

// ---- Resources -----------------------------------------------------------------------------

function Resources() {
  const actions = useActions();
  const vaults = useAppSlice((s) => s.offline.status?.vaults) ?? NONE;
  const field = useAppSlice((s) => s.offline.field);
  return (
    <div className="wv-cc-section">
      <SectionHead id="resources" />
      <DataLocationCard />
      <section className="wv-cc-card">
        <h3 className="wv-cc-caps">World packs</h3>
        <PackList />
        <div className="wv-cc-actions">
          <Button size="sm" onClick={() => void actions.installOfflinePack()}>
            Install a pack file…
          </Button>
        </div>
      </section>
      <section className="wv-cc-card">
        <h3 className="wv-cc-caps">Storage</h3>
        {field?.appDisk ? (
          <p>
            App drive: {(field.appDisk.freeBytes / 1e9).toFixed(1)} GB free of{' '}
            {(field.appDisk.totalBytes / 1e9).toFixed(0)} GB.
          </p>
        ) : null}
        <ul className="wv-cc-table">
          {vaults.map((v) => (
            <li key={v.id}>
              <span
                className={`wv-cc-chip wv-cc-chip--${v.state === 'ready' ? 'ok' : v.state === 'absent' ? 'warn' : 'bad'}`}
              >
                {v.state}
              </span>
              <strong>{v.label}</strong>
              <span className="wv-cc-muted">
                {v.path} · {v.message}
                {v.freeBytes !== undefined ? ` · ${(v.freeBytes / 1e9).toFixed(0)} GB free` : ''}
              </span>
              <span className="wv-cc-rowtools">
                {v.state === 'ready' ? (
                  <Button size="sm" variant="ghost" onClick={() => void actions.installPackToVault(v.id)}>
                    Install a pack here…
                  </Button>
                ) : null}
                <ConfirmButton
                  label="Stop using"
                  confirm="Stop using (files stay)"
                  onConfirm={() => void actions.removeDataVault(v.id)}
                />
              </span>
            </li>
          ))}
          {!vaults.length ? (
            <li className="wv-cc-muted">No external drive added. Everything is on the app&apos;s own drive.</li>
          ) : null}
        </ul>
        <div className="wv-cc-actions">
          <Button size="sm" onClick={() => void actions.addDataVault()}>
            Add a folder on an external drive…
          </Button>
        </div>
        <p className="wv-cc-muted">
          An unplugged drive&apos;s packs are kept and listed as missing; nothing is written to it until it is back.
        </p>
      </section>
      <ServicesPorts />
      <LocalHosts />
    </div>
  );
}

function ServicesPorts() {
  const [, store] = useCC();
  const { settings } = useShellFacts();
  const saveSettings = useSaveSettings();
  const ports = settings?.services?.ports ?? {};
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = async (id: LocalServiceId) => {
    const raw = draft[id];
    if (raw === undefined) return;
    const n = raw.trim() === '' ? undefined : Number(raw);
    if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 65535)) return;
    const next = { ...ports };
    if (n === undefined) delete next[id];
    else next[id] = n;
    if (await saveSettings({ services: { ...settings?.services, ports: next } })) void store.refreshServices();
  };
  return (
    <section className="wv-cc-card">
      <h3 className="wv-cc-caps">Local services</h3>
      <p className="wv-cc-muted">
        Asked on this computer only (127.0.0.1). WorldView never installs, starts or stops them.
      </p>
      <ul className="wv-cc-table">
        {LOCAL_SERVICE_IDS.map((id) => (
          <li key={id}>
            <ServiceLine id={id} />
            <label className="wv-cc-field">
              Port
              <input
                className="wv-input wv-cc-num"
                inputMode="numeric"
                placeholder={String(DEFAULT_SERVICE_PORTS[id])}
                value={draft[id] ?? (ports[id] !== undefined ? String(ports[id]) : '')}
                onChange={(e) => setDraft({ ...draft, [id]: e.target.value })}
                onBlur={() => void save(id)}
              />
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LocalHosts() {
  const { settings } = useShellFacts();
  const saveSettings = useSaveSettings();
  const hosts = settings?.network?.localHosts ?? [];
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const write = (next: string[]) =>
    saveSettings({
      network: { workOffline: settings?.network?.workOffline ?? false, ...settings?.network, localHosts: next },
    });
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const why = localHostProblem(text);
    if (why) return setProblem(why);
    const host = normaliseLocalHost(text);
    if (hosts.includes(host)) return setProblem('already approved');
    if (hosts.length >= MAX_LOCAL_HOSTS) return setProblem(`at most ${MAX_LOCAL_HOSTS}`);
    if (await write([...hosts, host])) {
      setText('');
      setProblem(null);
    }
  };
  return (
    <section className="wv-cc-card">
      <h3 className="wv-cc-caps">Local network (offline)</h3>
      <p className="wv-cc-muted">
        In Offline mode WorldView reaches only this computer — and these devices on your own network, one each: a
        receiver on a Raspberry Pi, a weather station. Only private addresses and local names are taken; a whole range
        never is.
      </p>
      <ul className="wv-cc-table">
        {hosts.map((h) => (
          <li key={h}>
            <code>{h}</code>
            <ConfirmButton label="Remove" confirm="Remove" onConfirm={() => void write(hosts.filter((x) => x !== h))} />
          </li>
        ))}
        {!hosts.length ? <li className="wv-cc-muted">None approved.</li> : null}
      </ul>
      <form className="wv-cc-inline" onSubmit={(e) => void add(e)}>
        <input
          className="wv-input"
          placeholder="192.168.1.20 or raspberrypi.local"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button size="sm" type="submit">
          Approve
        </Button>
      </form>
      {problem ? <p className="wv-cc-problem">{problem}</p> : null}
    </section>
  );
}
