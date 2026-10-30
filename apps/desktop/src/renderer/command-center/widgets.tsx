import { useMemo, useState, type FormEvent } from 'react';
import type { LibraryFindAnswer, PrepCategory, PrepRecord } from '@worldview/ipc-contract';
import { Button, Toggle } from '@worldview/ui';
import { useActions, useAppSlice } from '../store/store.js';
import { MESH_PROVIDER, RECEIVER_PROVIDERS, ago, heardHow } from './checks.js';
import type { ActionId } from './guide-types.js';
import { useCC, useShellFacts } from './use-cc.js';
import { MapDownloadPanel } from './map-download-panel.js';

/** One empty list for selectors: a new [] each read would never settle. */
const NONE: readonly never[] = Object.freeze([]);

/**
 * The real controls a walkthrough step or a section offers. Each does the thing through the
 * runtime — switches a source, installs a pack, sends a search, asks the model — and shows what
 * came back. None reports success it did not get.
 */

export function ModeSwitch({ compact = false }: { compact?: boolean }) {
  const [cc, store] = useCC();
  const mode = cc.mode?.chosen;
  return (
    <div className={`wv-cc-modeswitch${compact ? ' wv-cc-modeswitch--compact' : ''}`} role="group" aria-label="Mode">
      {(['online', 'offline'] as const).map((m) => (
        <button
          key={m}
          type="button"
          className={`wv-cc-seg${mode === m ? ' wv-cc-seg--on' : ''}`}
          aria-pressed={mode === m}
          onClick={() => void store.chooseMode(m)}
        >
          {m === 'online' ? 'Online' : 'Offline'}
        </button>
      ))}
    </div>
  );
}

/** A button that asks twice before it deletes. */
export function ConfirmButton({
  label,
  confirm,
  onConfirm,
}: {
  label: string;
  confirm: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  return armed ? (
    <span className="wv-cc-confirm">
      <Button size="sm" variant="danger" onClick={() => (setArmed(false), onConfirm())}>
        {confirm}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setArmed(false)}>
        Keep
      </Button>
    </span>
  ) : (
    <Button size="sm" variant="ghost" onClick={() => setArmed(true)}>
      {label}
    </Button>
  );
}

function SourceSwitch({ providerId }: { providerId: string }) {
  const { sources } = useShellFacts();
  const actions = useActions();
  const e = sources.find((x) => x.providerId === providerId);
  if (!e) return <p className="wv-cc-muted">This build has no {providerId} source.</p>;
  return (
    <div className="wv-cc-source">
      <Toggle
        size="sm"
        label={e.name}
        checked={e.enabled}
        onChange={(v) => void actions.setSourceEnabled(providerId, v)}
      />
      <span
        className={`wv-cc-chip wv-cc-chip--${e.enabled && e.health.status === 'LIVE' ? 'ok' : e.enabled ? 'warn' : 'muted'}`}
      >
        {e.enabled ? e.health.status.replace('_', ' ') : 'OFF'}
      </span>
      {e.enabled && e.health.message ? <p className="wv-cc-muted wv-cc-source__msg">{e.health.message}</p> : null}
    </div>
  );
}

function PlaceSearch() {
  const [, store] = useCC();
  const actions = useActions();
  const [text, setText] = useState('');
  const [found, setFound] = useState<string[] | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    const results = (await actions.search(t, 8)).filter((r) => r.kind === 'place');
    store.notePlaceSearch(t, results.length);
    setFound(results.map((r) => `${r.title}${r.subtitle ? ` — ${r.subtitle}` : ''}`));
  };
  return (
    <form className="wv-cc-inline" onSubmit={(e) => void submit(e)}>
      <input
        className="wv-input"
        placeholder="A town in your pack's area"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Button size="sm" type="submit">
        Search
      </Button>
      {found ? (
        <ul className="wv-cc-list wv-cc-list--tight">
          {found.length ? found.map((f) => <li key={f}>{f}</li>) : <li className="wv-cc-muted">No place found.</li>}
        </ul>
      ) : null}
    </form>
  );
}

/** Find a page by title in the built-in library (records the result for the walkthrough's check). */
export function LibraryFind() {
  const [cc, store] = useCC();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<LibraryFindAnswer['hits'] | null>(null);
  const readable = (cc.shelf?.books ?? []).filter((b) => b.readable);
  if (!readable.length) return <p className="wv-cc-muted">No books OP-CB can open yet.</p>;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      setHits((await store.findInLibrary({ query: text.trim(), limit: 10 })).hits);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="wv-cc-inline" onSubmit={(e) => void submit(e)}>
      <input
        className="wv-input"
        placeholder="The start of a page title (Water, Burn…)"
        value={text}
        maxLength={200}
        onChange={(e) => setText(e.target.value)}
      />
      <Button size="sm" type="submit" disabled={busy}>
        {busy ? 'Finding…' : 'Find'}
      </Button>
      {hits ? (
        <ul className="wv-cc-list wv-cc-hits">
          {hits.length ? null : <li className="wv-cc-muted">No titles start with that.</li>}
          {hits.map((h) => (
            <li key={`${h.bookId}/${h.key}`}>
              <button
                type="button"
                className="wv-cc-link"
                onClick={() => void store.openLibrary({ kind: 'book', bookId: h.bookId, key: h.key })}
              >
                {h.title}
              </button>
              <span className="wv-cc-muted"> — {h.bookTitle}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}

export function LibrarySearch() {
  const [cc, store] = useCC();
  const books = cc.services?.find((s) => s.id === 'kiwix')?.books ?? [];
  const [book, setBook] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = book || books.find((b) => b.name)?.name || '';
  const last = cc.lastLibrarySearch;
  if (!books.length) return <p className="wv-cc-muted">No library books found yet.</p>;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen || !text.trim()) return;
    setBusy(true);
    try {
      await store.librarySearch(chosen, text.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="wv-cc-inline" onSubmit={(e) => void submit(e)}>
      <select className="wv-input" value={chosen} onChange={(e) => setBook(e.target.value)} aria-label="Book">
        {books
          .filter((b) => b.name)
          .map((b) => (
            <option key={b.id} value={b.name}>
              {b.title}
              {b.language ? ` (${b.language})` : ''}
            </option>
          ))}
      </select>
      <input
        className="wv-input"
        placeholder="Search the book"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Button size="sm" type="submit" disabled={busy}>
        {busy ? 'Searching…' : 'Search'}
      </Button>
      {last ? (
        last.answer.ok ? (
          <ul className="wv-cc-list wv-cc-hits">
            {last.answer.hits.length ? null : <li className="wv-cc-muted">No pages found.</li>}
            {last.answer.hits.map((h) => (
              <li key={h.path}>
                <button type="button" className="wv-cc-link" onClick={() => void store.openService('kiwix', h.path)}>
                  {h.title}
                </button>
                {h.snippet ? <span className="wv-cc-muted"> — {h.snippet}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="wv-cc-problem">{last.answer.message}</p>
        )
      ) : null}
    </form>
  );
}

export function AiTest() {
  const [cc, store] = useCC();
  const { settings } = useShellFacts();
  const model = settings?.services?.aiModel;
  const [prompt, setPrompt] = useState('In one sentence, what is a compass used for?');
  if (!model) return <p className="wv-cc-muted">Choose a model first (Local Intelligence).</p>;
  const t = cc.lastAiTest;
  return (
    <div className="wv-cc-inline">
      <input className="wv-input" value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Question" />
      <Button size="sm" disabled={cc.aiBusy || !prompt.trim()} onClick={() => void store.aiTest(model, prompt.trim())}>
        {cc.aiBusy ? 'Waiting for the model…' : `Ask ${model}`}
      </Button>
      {t ? (
        t.answer.ok ? (
          <div className="wv-cc-answer">
            <div className="wv-cc-answer__label">Model-generated answer (not checked against any source)</div>
            <p>{t.answer.text}</p>
            <div className="wv-cc-muted">
              {(t.answer.elapsedMs / 1000).toFixed(1)} s
              {t.answer.tokensPerSecond !== undefined ? ` · ${t.answer.tokensPerSecond} tokens/s` : ''}
              {t.offline ? ' · OP-CB offline' : ''}
            </div>
          </div>
        ) : (
          <p className="wv-cc-problem">{t.answer.message}</p>
        )
      ) : null}
    </div>
  );
}

const MESH_STAGES = [
  ['connected', 'Connected to your radio'],
  ['accepted', 'Accepted into its send queue'],
  ['relayed', 'Repeated by another radio (out over the air)'],
  ['acknowledged', 'Acknowledged by the radio it was for'],
] as const;

export function MeshTest() {
  const [cc, store] = useCC();
  const nodes = (cc.meshNodes ?? []).filter((o) => o.properties['thisNode'] !== true);
  const [to, setTo] = useState('');
  const [text, setText] = useState('OP-CB radio check');
  const [armed, setArmed] = useState(false);
  const target = nodes.find((o) => o.properties['nodeId'] === to) ?? nodes[0];
  const id = typeof target?.properties['nodeId'] === 'string' ? target.properties['nodeId'] : '';
  const name = String(target?.properties['name'] ?? id);
  const t = cc.lastMeshTest;
  if (cc.meshNodes === null)
    return (
      <Button size="sm" onClick={() => void store.refreshMeshNodes()}>
        Find radios
      </Button>
    );
  if (!nodes.length) return <p className="wv-cc-muted">No other radio with a position is known yet.</p>;
  const bytes = new TextEncoder().encode(text.trim()).length;
  return (
    <div className="wv-cc-inline">
      <select className="wv-input" value={id} onChange={(e) => setTo(e.target.value)} aria-label="Send to">
        {nodes.map((o) => (
          <option key={o.id} value={String(o.properties['nodeId'])}>
            {String(o.properties['name'] ?? o.properties['nodeId'])} — {heardHow(o)}
          </option>
        ))}
      </select>
      <input
        className="wv-input"
        value={text}
        maxLength={200}
        onChange={(e) => setText(e.target.value)}
        aria-label="Message"
      />
      {armed ? (
        <span className="wv-cc-confirm">
          <span className="wv-cc-muted">Transmit to {name} on your primary channel?</span>
          <Button
            size="sm"
            variant="primary"
            disabled={cc.meshBusy}
            onClick={() => {
              setArmed(false);
              void store.meshTest(id, name, text.trim());
            }}
          >
            Transmit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setArmed(false)}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button size="sm" disabled={cc.meshBusy || !id || !bytes || bytes > 200} onClick={() => setArmed(true)}>
          {cc.meshBusy ? 'Waiting for the report (up to a minute)…' : 'Send test message'}
        </Button>
      )}
      {t ? (
        <div className="wv-cc-answer">
          <ul className="wv-cc-stages">
            {MESH_STAGES.map(([k, label]) => (
              <li key={k} className={t.answer.evidence[k] ? 'wv-cc-stage--yes' : 'wv-cc-stage--no'}>
                {t.answer.evidence[k] ? '✓' : '·'} {label}
              </li>
            ))}
          </ul>
          <p className="wv-cc-muted">
            {t.name}: {t.answer.message}
            {t.answer.routingError ? ` (${t.answer.routingError})` : ''}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function MeshNodes() {
  const [cc] = useCC();
  const now = Date.now();
  const nodes = cc.meshNodes ?? [];
  if (!nodes.length) return <p className="wv-cc-muted">No radio with a position yet.</p>;
  return (
    <ul className="wv-cc-list wv-cc-list--tight">
      {nodes.slice(0, 30).map((o) => {
        const heard = Date.parse(String(o.properties['lastHeardAt'] ?? ''));
        const battery = o.properties['batteryPct'];
        return (
          <li key={o.id}>
            <strong>{String(o.properties['name'] ?? o.id)}</strong>
            {o.properties['thisNode'] === true ? ' (this radio)' : ` — ${heardHow(o)}`}
            {Number.isFinite(heard) ? `, ${ago(now - heard)}` : ''}
            {typeof battery === 'number' ? `, battery ${battery}%` : ''}
          </li>
        );
      })}
    </ul>
  );
}

// ---- preparedness ----------------------------------------------------------------------------

const CATEGORY_LABELS: Record<PrepCategory, string> = {
  water: 'Water',
  food: 'Food',
  medical: 'First aid and medical',
  power: 'Power and light',
  communications: 'Communications',
  tools: 'Tools',
  shelter: 'Shelter and warmth',
  documents: 'Documents',
  other: 'Other',
};

/** The starter list: names and categories only, no quantities — the operator counts. */
const STARTER: ReadonlyArray<[PrepCategory, string, string?]> = [
  ['water', 'Drinking water', 'L'],
  ['food', 'Food that keeps (no cooking needed)', 'days'],
  ['medical', 'First aid kit'],
  ['medical', 'Prescription medicines', 'days'],
  ['power', 'Torch / headlamp'],
  ['power', 'Spare batteries'],
  ['power', 'Power bank'],
  ['communications', 'Battery or crank radio'],
  ['documents', 'Copies of ID and insurance'],
  ['tools', 'Multi-tool'],
  ['shelter', 'Blankets or sleeping bags'],
];

export function categoryLabel(c: PrepCategory): string {
  return CATEGORY_LABELS[c];
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function useAddStarter(): () => Promise<number> {
  const [cc, store] = useCC();
  return async () => {
    const have = new Set(cc.prep.map((r) => r.name.toLowerCase()));
    let added = 0;
    for (const [category, name, unit] of STARTER) {
      if (have.has(name.toLowerCase())) continue;
      const ok = await store.savePrep({
        id: newId('item'),
        kind: 'item',
        category,
        name,
        ...(unit ? { unit } : {}),
        updatedAt: new Date().toISOString(),
      });
      if (ok) added++;
    }
    return added;
  };
}

export function PrepForm({ onDone }: { onDone?: () => void }) {
  const [, store] = useCC();
  const [kind, setKind] = useState<PrepRecord['kind']>('item');
  const [category, setCategory] = useState<PrepCategory>('water');
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [expires, setExpires] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setProblem('Give it a name.');
    const q = quantity.trim() === '' ? undefined : Number(quantity);
    if (q !== undefined && (!Number.isFinite(q) || q < 0)) return setProblem('The quantity is a number, 0 or more.');
    const record: PrepRecord = {
      id: newId(kind),
      kind,
      category: kind === 'contact' ? 'other' : category,
      name: name.trim(),
      ...(kind === 'item' && q !== undefined ? { quantity: q } : {}),
      ...(kind === 'item' && unit.trim() ? { unit: unit.trim() } : {}),
      ...(kind === 'item' && expires ? { expires } : {}),
      ...(kind === 'contact' && phone.trim() ? { phone: phone.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (!(await store.savePrep(record))) return setProblem('Not saved: check the fields.');
    setProblem(null);
    setName('');
    setQuantity('');
    setExpires('');
    setPhone('');
    setNotes('');
    onDone?.();
  };
  return (
    <form className="wv-cc-form" onSubmit={(e) => void submit(e)}>
      <select
        className="wv-input"
        value={kind}
        onChange={(e) => setKind(e.target.value as PrepRecord['kind'])}
        aria-label="Kind"
      >
        <option value="item">Supply or equipment</option>
        <option value="contact">Emergency contact</option>
        <option value="note">Plan or note</option>
      </select>
      {kind !== 'contact' ? (
        <select
          className="wv-input"
          value={category}
          onChange={(e) => setCategory(e.target.value as PrepCategory)}
          aria-label="Category"
        >
          {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      ) : null}
      <input
        className="wv-input"
        placeholder="Name"
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
      />
      {kind === 'item' ? (
        <>
          <input
            className="wv-input wv-cc-num"
            placeholder="How many"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
          <input
            className="wv-input wv-cc-num"
            placeholder="Unit"
            value={unit}
            maxLength={24}
            onChange={(e) => setUnit(e.target.value)}
          />
          <label className="wv-cc-date">
            Expires{' '}
            <input className="wv-input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </label>
        </>
      ) : null}
      {kind === 'contact' ? (
        <input
          className="wv-input"
          placeholder="Phone or call sign"
          value={phone}
          maxLength={64}
          onChange={(e) => setPhone(e.target.value)}
        />
      ) : null}
      <input
        className="wv-input"
        placeholder="Notes (where it is kept…)"
        value={notes}
        maxLength={2000}
        onChange={(e) => setNotes(e.target.value)}
      />
      <Button size="sm" type="submit" variant="primary">
        Add
      </Button>
      {problem ? <p className="wv-cc-problem">{problem}</p> : null}
    </form>
  );
}

/** One record's quantity, edited in place (counting the starter list). */
export function QuantityCell({ record }: { record: PrepRecord }) {
  const [, store] = useCC();
  const [value, setValue] = useState(record.quantity === undefined ? '' : String(record.quantity));
  const save = () => {
    const q = value.trim() === '' ? undefined : Number(value);
    if (q !== undefined && (!Number.isFinite(q) || q < 0)) return;
    if (q === record.quantity) return;
    const { quantity: _old, ...rest } = record;
    void store.savePrep({ ...rest, ...(q !== undefined ? { quantity: q } : {}), updatedAt: new Date().toISOString() });
  };
  return (
    <input
      className="wv-input wv-cc-num"
      value={value}
      inputMode="decimal"
      aria-label={`How many: ${record.name}`}
      placeholder="count"
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && save()}
    />
  );
}

// ---- the action dispatcher -------------------------------------------------------------------

/** The controls one walkthrough step offers, by id. */
export function StepActions({ ids }: { ids: readonly ActionId[] }) {
  return (
    <div className="wv-cc-actions">
      {ids.map((id) => (
        <StepAction key={id} id={id} />
      ))}
    </div>
  );
}

function StepAction({ id }: { id: ActionId }) {
  const [cc, store] = useCC();
  const actions = useActions();
  const addStarter = useAddStarter();
  const vaults = useAppSlice((s) => s.offline.status?.vaults) ?? NONE;
  const readyVault = useMemo(() => vaults.find((v) => v.state === 'ready'), [vaults]);
  const [note, setNote] = useState<string | null>(null);
  const button = (label: string, run: () => unknown, variant: 'primary' | 'secondary' = 'secondary') => (
    <span className="wv-cc-action">
      <Button size="sm" variant={variant} onClick={() => void Promise.resolve(run())}>
        {label}
      </Button>
      {note ? <span className="wv-cc-muted"> {note}</span> : null}
    </span>
  );
  switch (id) {
    case 'mode.offline':
      return cc.mode?.chosen === 'offline' ? (
        <span className="wv-cc-chip wv-cc-chip--ok">Offline</span>
      ) : (
        button('Switch to Offline', () => store.chooseMode('offline'))
      );
    case 'mode.online':
      return cc.mode?.chosen === 'online' ? (
        <span className="wv-cc-chip wv-cc-chip--muted">Online</span>
      ) : (
        button('Back to Online', () => store.chooseMode('online'))
      );
    case 'maps.installPack':
      return (
        <span className="wv-cc-action">
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              void actions
                .installOfflinePack()
                .then((r) => setNote(r.installed ? `Installed ${r.installed}.` : r.issues.join('; ') || null))
            }
          >
            Install a pack file…
          </Button>
          {readyVault ? (
            <Button
              size="sm"
              onClick={() =>
                void actions
                  .installPackToVault(readyVault.id)
                  .then((r) =>
                    setNote(
                      r.installed ? `Installed ${r.installed} on ${readyVault.label}.` : r.issues.join('; ') || null,
                    ),
                  )
              }
            >
              Install onto “{readyVault.label}”…
            </Button>
          ) : null}
          {note ? <span className="wv-cc-muted"> {note}</span> : null}
        </span>
      );
    case 'maps.download':
      return <MapDownloadPanel />;
    case 'maps.addVault':
      return button('Add a folder on an external drive…', () =>
        actions.addDataVault().then((r) => setNote(r.added ? `Added ${r.added}.` : r.issues.join('; ') || null)),
      );
    case 'maps.openMap':
      return button('Show the map', async () => {
        store.close();
        await actions.setMode('2D');
      });
    case 'maps.searchPlace':
      return <PlaceSearch />;
    case 'mesh.enable':
      return <SourceSwitch providerId={MESH_PROVIDER} />;
    case 'mesh.openSettings':
      return button('Open its settings', () => {
        store.close();
        actions.openSource(MESH_PROVIDER);
      });
    case 'mesh.showOnMap':
      return button('Show the map', () => store.close());
    case 'mesh.sendTest':
      return <MeshTest />;
    case 'sdr.enable':
      return (
        <span className="wv-cc-col">
          {RECEIVER_PROVIDERS.map((p) => (
            <SourceSwitch key={p} providerId={p} />
          ))}
        </span>
      );
    case 'sdr.openSettings':
      return (
        <span className="wv-cc-action">
          {RECEIVER_PROVIDERS.map((p) => (
            <Button
              key={p}
              size="sm"
              onClick={() => {
                store.close();
                actions.openSource(p);
              }}
            >
              {p === 'readsb-local' ? 'Aircraft receiver settings' : 'Ship receiver settings'}
            </Button>
          ))}
        </span>
      );
    case 'services.refresh':
      return button(cc.servicesBusy ? 'Looking…' : 'Look again', () => store.refreshServices());
    case 'ai.runTest':
      return <AiTest />;
    case 'ai.openSection':
      return button('Choose in Local Intelligence', () => store.show('intelligence'));
    case 'library.open':
      return button('Open the library', () => store.openService('kiwix'));
    case 'library.search':
      return <LibrarySearch />;
    case 'library.openKnowledge':
      return button('Open Knowledge', () => store.show('knowledge'));
    case 'library.downloadReferences':
      return button(
        cc.libraryDownload.phase === 'downloading' ? 'Downloading…' : 'Download the emergency references',
        () =>
          store
            .startLibraryDownload({ kind: 'references' })
            .then(() => setNote('Downloading: progress is in Knowledge.')),
      );
    case 'library.find':
      return <LibraryFind />;
    case 'learning.open':
      return button('Open Kolibri', () => store.openService('kolibri'));
    case 'prep.openInventory':
      return button('Open the inventory', () => store.show('prepare'));
    case 'prep.addStarter':
      return button('Add a starter list', () =>
        addStarter().then((n) => setNote(n ? `${n} added: count them in the inventory.` : 'Already there.')),
      );
    case 'prep.exportChecklist':
      return button('Save as a checklist (CSV)…', () =>
        store.exportPrep('csv').then((p) => setNote(p ? `Saved to ${p}.` : null)),
      );
  }
}
