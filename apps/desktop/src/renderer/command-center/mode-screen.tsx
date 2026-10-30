import { useEffect, useRef, useState, type Ref } from 'react';
import type { OperatingMode } from '@worldview/ipc-contract';
import { Button, Icon } from '@worldview/ui';
import { useAppSlice } from '../store/store.js';
import { useCC } from './use-cc.js';

/**
 * The start screen (the Command Center, 2026-10-30): Online or Offline, chosen by the operator
 * every start. The last choice is offered first; the computer's own view of the network is
 * shown as information and never chooses. Until a mode is chosen nothing is sent to the
 * internet (main.ts). Then the Command Center opens.
 */
export function ModeScreen() {
  const [cc, store] = useCC();
  const demo = useAppSlice((s) => s.session.appInfo?.demoMode ?? false);
  const [pick, setPick] = useState<OperatingMode | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  const remembered = cc.mode?.remembered ?? null;
  const selected = pick ?? remembered;

  const ready = cc.mode !== null;
  useEffect(() => {
    if (ready) first.current?.focus();
  }, [ready]);

  if (!cc.mode || cc.mode.chosen !== null) {
    if (cc.modeError && !cc.mode)
      return (
        <div className="wv-cc-start" role="dialog" aria-modal="true" aria-label="Start OP-CB">
          <div className="wv-cc-start__panel">
            <p className="wv-cc-start__problem">The runtime did not answer: {cc.modeError}</p>
            <Button onClick={() => void store.refreshMode()}>Try again</Button>
          </div>
        </div>
      );
    return null;
  }

  const enter = async () => {
    if (!selected) return;
    setBusy(true);
    const ok = await store.chooseMode(selected);
    setBusy(false);
    if (ok) store.openAt('overview');
  };

  const option = (mode: OperatingMode, title: string, lines: string[], ref?: Ref<HTMLButtonElement>) => (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected === mode}
      className={`wv-cc-mode${selected === mode ? ' wv-cc-mode--on' : ''}`}
      onClick={() => setPick(mode)}
      onDoubleClick={() => {
        setPick(mode);
        void store.chooseMode(mode).then((ok) => ok && store.openAt('overview'));
      }}
    >
      <span className="wv-cc-mode__head">
        <Icon name={mode === 'online' ? 'globe' : 'offline'} size={18} />
        <span className="wv-cc-mode__title">{title}</span>
        {remembered === mode ? <span className="wv-cc-chip wv-cc-chip--muted">Last used</span> : null}
      </span>
      <ul>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </button>
  );

  return (
    <div className="wv-cc-start" role="dialog" aria-modal="true" aria-labelledby="wv-cc-start-title">
      <div className="wv-cc-start__panel">
        <div className="wv-cc-start__brand">
          <span className="wv-brand-wordmark wv-cc-start__wordmark" role="img" aria-label="OP-CB" />
          <span className="wv-brand-caption">Operation Civilization Backup</span>
        </div>
        <h1 id="wv-cc-start-title" className="wv-cc-start__title">
          How will you work today?
        </h1>
        <div className="wv-cc-start__modes" role="radiogroup" aria-label="Operating mode">
          {option(
            'online',
            'Online',
            [
              'Live aircraft, ships, satellites, weather and hazards from the internet',
              'Map tiles, updates and downloads',
              'Everything on this computer as well',
            ],
            first,
          )}
          {option('offline', 'Offline', [
            'Nothing is sent to the internet',
            'Installed maps, library, history and saved places',
            'Your own radios, receivers and GPS; local AI if installed',
          ])}
        </div>
        <p className="wv-cc-start__net">
          <span className={`wv-cc-dot wv-cc-dot--${cc.mode.osOnline ? 'ok' : 'off'}`} aria-hidden="true" />
          This computer reports {cc.mode.osOnline ? 'a network connection' : 'no network connection'}. That is for your
          information; the choice is yours.
          {demo ? ' Demo build: recorded data only, in either mode.' : ''}
        </p>
        <p className="wv-cc-start__note">
          Offline stops OP-CB&apos;s own requests. It is not a firewall: other programs on this computer are not
          affected. You can switch at any time from the Command Center without restarting.
        </p>
        {cc.modeError ? <p className="wv-cc-start__problem">{cc.modeError}</p> : null}
        <div className="wv-cc-start__actions">
          <Button variant="primary" onClick={() => void enter()} disabled={!selected || busy}>
            {selected ? `Start ${selected === 'online' ? 'online' : 'offline'}` : 'Choose a mode'}
          </Button>
        </div>
      </div>
    </div>
  );
}
