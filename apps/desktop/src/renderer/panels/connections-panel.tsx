import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { SourceHealthEntry } from '@worldview/source-health';
import { Button, EmptyState, Panel, StatusBadge, Toggle } from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';
import { getByPath } from '../store/actions.js';
import { CredentialField, ProviderSettingField } from './sources-panel.js';
import {
  CONNECTION_GROUPS,
  HOME_ASSISTANT_PROVIDERS,
  HOME_ASSISTANT_TOKEN_KEY,
  haAddressText,
  readHaAddress,
} from './connections-model.js';

/**
 * Connections (operator decision 2026-10-20): your own receivers and servers in one place —
 * the radios, the boat, the weather station and air sensor, and Home Assistant — with the
 * address each is read from, its switch and whether it is answering. Everything here is a
 * source in Sources too; this is the short way to plug them in.
 */
export function ConnectionsPanel() {
  const { sources } = useAppState();
  const byId = useMemo(() => new Map(sources.entries.map((e) => [e.providerId, e])), [sources.entries]);
  const groups = CONNECTION_GROUPS.map((g) => ({
    ...g,
    entries: g.providerIds.map((id) => byId.get(id)).filter((e): e is SourceHealthEntry => e !== undefined),
  })).filter((g) => g.entries.length);
  const homeAssistant = HOME_ASSISTANT_PROVIDERS.map((id) => byId.get(id)).filter(
    (e): e is SourceHealthEntry => e !== undefined,
  );
  if (!groups.length && !homeAssistant.length)
    return (
      <Panel title="Connections">
        <EmptyState title="No local connections in this build" description="Your own receivers appear here." />
      </Panel>
    );
  return (
    <Panel title="Connections">
      <p className="wv-ctx-muted wv-connections__intro">
        Your own receivers and servers. Only the address you give is contacted; nothing on your network is searched for.
      </p>
      {homeAssistant.length ? <HomeAssistantCard entries={homeAssistant} /> : null}
      {groups.map((g) => (
        <section key={g.id} className="wv-connections__group" aria-label={g.title}>
          <h3 className="wv-caps">{g.title}</h3>
          <p className="wv-ctx-muted">{g.hint}</p>
          {g.entries.map((e) => (
            <ConnectionCard key={e.providerId} entry={e} />
          ))}
        </section>
      ))}
    </Panel>
  );
}

function StatusLine({ entry }: { entry: SourceHealthEntry }) {
  return (
    <span className="wv-connections__status">
      {entry.enabled ? <StatusBadge kind="provider" value={entry.health.status} size="sm" /> : <span>Off</span>}
      {entry.enabled && entry.health.objectCount !== undefined ? (
        <span className="wv-num">{entry.health.objectCount} on the map</span>
      ) : null}
    </span>
  );
}

/** One receiver: its switch, its own settings (the address first) and any key it needs. */
function ConnectionCard({ entry }: { entry: SourceHealthEntry }) {
  const { sources } = useAppState();
  const actions = useActions();
  const manifest = sources.manifests[entry.providerId];
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void actions.loadManifest(entry.providerId);
  }, [entry.providerId, actions]);
  const settingsLoaded = sources.providerSettings[entry.providerId] !== undefined;
  useEffect(() => {
    if (open && !settingsLoaded) void actions.loadProviderSettings(entry.providerId);
  }, [open, settingsLoaded, entry.providerId, actions]);
  return (
    <div className="wv-connections__card">
      <div className="wv-connections__head">
        <Toggle
          size="sm"
          label={entry.name}
          checked={entry.enabled}
          onChange={(v) => void actions.setSourceEnabled(entry.providerId, v)}
        />
        <StatusLine entry={entry} />
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Done' : 'Address'}
        </Button>
      </div>
      {entry.enabled && entry.health.message ? <p className="wv-connections__message">{entry.health.message}</p> : null}
      {open ? (
        <div className="wv-connections__settings">
          {(manifest?.settings ?? []).map((def) => (
            <ProviderSettingField
              key={def.key}
              providerId={entry.providerId}
              def={def}
              value={getByPath(sources.providerSettings[entry.providerId] ?? {}, def.key)}
            />
          ))}
          {entry.meta.credentialsRequired.map((key) => (
            <CredentialField
              key={key}
              credentialKey={key}
              providerId={entry.providerId}
              present={sources.credentials[key] ?? false}
              label={manifest?.credentials.find((c) => c.key === key)?.label ?? key}
              helpUrl={manifest?.credentials.find((c) => c.key === key)?.helpUrl}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const HA_LABELS: Record<string, string> = {
  'home-assistant-zones': 'Zones',
  'home-assistant-weather': 'Weather',
  'home-assistant-sensors': 'Sensors',
  'home-assistant-people': 'People and their phones',
};

/** Home Assistant in one form: the address and the token once, for all of its sources. */
function HomeAssistantCard({ entries }: { entries: SourceHealthEntry[] }) {
  const { sources } = useAppState();
  const actions = useActions();
  const first = entries[0]!.providerId;
  const saved = haAddressText(sources.providerSettings[first]);
  const [address, setAddress] = useState(saved);
  const [token, setToken] = useState('');
  const [pick, setPick] = useState<Set<string>>(
    () =>
      new Set(entries.filter((e) => e.enabled || e.providerId !== 'home-assistant-people').map((e) => e.providerId)),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tokenStored = sources.credentials[HOME_ASSISTANT_TOKEN_KEY] ?? false;
  useEffect(() => {
    void actions.checkCredential(HOME_ASSISTANT_TOKEN_KEY);
    if (sources.providerSettings[first] === undefined) void actions.loadProviderSettings(first);
  }, [actions, first, sources.providerSettings]);
  useEffect(() => {
    if (saved && !address) setAddress(saved);
    // Only the first time the saved address arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const read = readHaAddress(address);
    if (!read.ok) {
      setProblem(read.reason);
      return;
    }
    if (!tokenStored && !token.trim()) {
      setProblem('a long-lived access token is needed (Home Assistant → your profile → Security)');
      return;
    }
    setProblem(null);
    setBusy(true);
    const ok = await actions.connectHomeAssistant({
      address: read.address,
      ...(token.trim() ? { token } : {}),
      enable: [...pick],
      providerIds: entries.map((x) => x.providerId),
    });
    setBusy(false);
    if (ok) setToken('');
  };

  return (
    <section className="wv-connections__group" aria-label="Home Assistant">
      <h3 className="wv-caps">Home Assistant</h3>
      <form className="wv-connections__card wv-connections__ha" onSubmit={(e) => void submit(e)}>
        <label className="wv-field">
          <span className="wv-field__label">Address</span>
          <input
            className="wv-input"
            placeholder="http://homeassistant.local:8123"
            value={address}
            spellCheck={false}
            onChange={(e) => setAddress(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="wv-field">
          <span className="wv-field__label">Long-lived access token</span>
          <input
            className="wv-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={tokenStored ? 'Stored — enter a new one to replace it' : 'Paste the token'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={busy}
          />
        </label>
        <fieldset className="wv-connections__pick">
          <legend className="wv-field__label">Show</legend>
          {entries.map((e) => (
            <div key={e.providerId} className="wv-connections__pickrow">
              <Toggle
                size="sm"
                label={HA_LABELS[e.providerId] ?? e.name}
                checked={pick.has(e.providerId)}
                onChange={(v) =>
                  setPick((prev) => {
                    const next = new Set(prev);
                    if (v) next.add(e.providerId);
                    else next.delete(e.providerId);
                    return next;
                  })
                }
              />
              <StatusLine entry={e} />
            </div>
          ))}
          {pick.has('home-assistant-people') ? (
            <p className="wv-ctx-muted">
              People and their phones: where Home Assistant places your household. Not kept in history. Keep it off
              unless they agree.
            </p>
          ) : null}
        </fieldset>
        {problem ? (
          <p className="wv-connections__message" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="wv-ctx-actions">
          <Button size="sm" type="submit" variant="primary" disabled={busy}>
            Connect
          </Button>
        </div>
      </form>
    </section>
  );
}
