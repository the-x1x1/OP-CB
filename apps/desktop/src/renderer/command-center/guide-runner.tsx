import { useEffect, useState } from 'react';
import { Button, Icon } from '@worldview/ui';
import { useActions } from '../store/store.js';
import type { CheckResult, GuideDefinition } from './guide-types.js';
import {
  back,
  canAdvance,
  canSkip,
  choiceWords,
  completion,
  currentProgress,
  currentStep,
  goTo,
  next,
  recordCheck,
  recordChoice,
  skip,
  startGuide,
  stepIndex,
  stepLabel,
  type GuideCompletion,
} from './guide-engine.js';
import { StepActions } from './widgets.js';
import { useCC, useRunCheck } from './use-cc.js';

export const COMPLETION_LABEL: Record<GuideCompletion, string> = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  verified: 'Verified',
  unverified: 'Finished, not verified',
};

/**
 * One walkthrough, step by step: the words, the real controls, the check, what to do when it
 * fails. Progress is saved as it goes and picked up where it was left; a finished walkthrough
 * opens on its last step and can be started again.
 */
export function GuideRunner({ def }: { def: GuideDefinition }) {
  const [cc, store] = useCC();
  const actions = useActions();
  const runCheck = useRunCheck();
  const saved = currentProgress(
    def,
    cc.guides.find((g) => g.id === def.id),
  );
  const [result, setResult] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const progress = saved ?? startGuide(def, Date.now());
  const step = currentStep(def, progress);
  const record = progress.steps[step.id];
  const status = completion(def, saved);
  const words = choiceWords(step, progress);
  const offline = cc.mode?.chosen === 'offline';

  useEffect(() => setResult(null), [step.id]);

  const save = (p: typeof progress) => void store.saveGuide(p);
  const check = async () => {
    if (!step.check) return;
    setChecking(true);
    try {
      const r = await runCheck(step.check);
      setResult(r);
      save(recordCheck(def, progress, r, Date.now()));
    } finally {
      setChecking(false);
    }
  };

  const shown =
    result ??
    (record?.outcome === 'verified' || record?.outcome === 'failed'
      ? { status: record.outcome === 'verified' ? 'pass' : 'fail', message: record.evidence ?? '' }
      : null);

  return (
    <article className="wv-cc-guide" aria-label={def.title}>
      <header className="wv-cc-guide__head">
        <div>
          <div className="wv-cc-caps">Walkthrough · {COMPLETION_LABEL[status]}</div>
          <h2 className="wv-cc-guide__title">{def.title}</h2>
        </div>
        <div className="wv-cc-guide__tools">
          <ConfirmRestart onRestart={() => void store.resetGuide(def.id)} />
          <Button size="sm" variant="ghost" icon="close" onClick={() => store.openGuide(null)}>
            Close
          </Button>
        </div>
      </header>

      <ol className="wv-cc-steps" aria-label="Steps">
        {def.steps.map((s, i) => {
          const r = progress.steps[s.id];
          const here = s.id === step.id;
          const mark =
            r?.outcome === 'verified'
              ? 'ok'
              : r?.outcome === 'failed'
                ? 'bad'
                : r?.outcome === 'skipped'
                  ? 'skip'
                  : r
                    ? 'done'
                    : 'todo';
          return (
            <li
              key={s.id}
              className={`wv-cc-steps__item wv-cc-steps__item--${mark}${here ? ' wv-cc-steps__item--here' : ''}`}
            >
              <button
                type="button"
                onClick={() => save(goTo(def, progress, s.id, Date.now()))}
                aria-current={here ? 'step' : undefined}
              >
                <span className="wv-cc-steps__n">{i + 1}</span>
                <span>{s.title}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <section className="wv-cc-guide__body">
        {stepIndex(def, step.id) === 0 && !saved ? (
          <div className="wv-cc-guide__intro">
            <p className="wv-cc-lead">{def.whatItDoes}</p>
            {def.prerequisites.length ? (
              <>
                <h4>You need</h4>
                <ul>
                  {def.prerequisites.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {def.equipment?.length ? (
              <details>
                <summary>Equipment that helps</summary>
                <dl className="wv-cc-equip">
                  {def.equipment.map((e) => (
                    <div key={e.kind}>
                      <dt>{e.kind}</dt>
                      <dd>{e.items.join(' · ')}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            ) : null}
          </div>
        ) : null}

        <div className="wv-cc-caps">{stepLabel(def, progress)}</div>
        <h3 className="wv-cc-step__title">{step.title}</h3>
        {step.needsInternet ? (
          <p className={`wv-cc-callout${offline ? ' wv-cc-callout--warn' : ''}`}>
            <Icon name="download" size={14} /> {step.needsInternet}
            {offline ? ' You are in Offline mode now.' : ''}
          </p>
        ) : null}
        {step.body.map((p) => (
          <p key={p}>{p}</p>
        ))}
        {words.map((p) => (
          <p key={p} className="wv-cc-callout">
            {p}
          </p>
        ))}
        {step.bullets?.length ? (
          <ul>
            {step.bullets.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        ) : null}
        {step.links?.length ? (
          <p className="wv-cc-links">
            {step.links.map((l) => (
              <button
                key={l.url}
                type="button"
                className="wv-cc-link"
                disabled={offline}
                title={offline ? 'Needs the internet: switch to Online to open it' : l.url}
                onClick={() => void actions.openExternal(l.url)}
              >
                {l.label} <Icon name="external" size={12} />
              </button>
            ))}
            <span className="wv-cc-muted">(opens in your browser; needs the internet)</span>
          </p>
        ) : null}

        {step.choice ? (
          <fieldset className="wv-cc-choice">
            <legend>{step.choice.prompt}</legend>
            {step.choice.options.map((o) => (
              <label key={o.id} className={`wv-cc-choice__opt${o.unsupported ? ' wv-cc-choice__opt--no' : ''}`}>
                <input
                  type="radio"
                  name={`${def.id}-${step.id}`}
                  checked={record?.choice === o.id}
                  onChange={() => save(recordChoice(def, progress, o.id, Date.now()))}
                />
                <span>
                  <strong>{o.label}</strong>
                  {o.detail ? <span className="wv-cc-muted"> — {o.detail}</span> : null}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}

        {step.actions?.length ? <StepActions ids={step.actions} /> : null}

        {step.check ? (
          <div className="wv-cc-check">
            <Button
              size="sm"
              variant={record?.outcome === 'verified' ? 'secondary' : 'primary'}
              onClick={() => void check()}
              disabled={checking}
            >
              {checking
                ? 'Checking…'
                : record?.outcome === 'verified'
                  ? 'Check again'
                  : step.final
                    ? 'Run the test'
                    : 'Check'}
            </Button>
            {shown ? (
              <p className={`wv-cc-check__result wv-cc-check__result--${shown.status}`} role="status">
                {shown.status === 'pass' ? '✓ ' : shown.status === 'fail' ? '✕ ' : ''}
                {shown.message}
              </p>
            ) : (
              <p className="wv-cc-muted">Not checked yet. Next opens once the check passes.</p>
            )}
          </div>
        ) : null}

        {step.troubleshooting?.length ? (
          <details className="wv-cc-trouble" open={shown?.status === 'fail'}>
            <summary>Troubleshooting</summary>
            <dl>
              {step.troubleshooting.map((t) => (
                <div key={t.problem}>
                  <dt>{t.problem}</dt>
                  <dd>{t.fix}</dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
      </section>

      <footer className="wv-cc-guide__foot">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => save(back(def, progress, Date.now()))}
          disabled={stepIndex(def, step.id) === 0}
        >
          Back
        </Button>
        <span className="wv-cc-grow" />
        {canSkip(step) ? (
          <Button size="sm" variant="ghost" onClick={() => save(skip(def, progress, Date.now()))}>
            Skip{step.check ? ' (stays unverified)' : ''}
          </Button>
        ) : null}
        {progress.completedAt && stepIndex(def, step.id) === def.steps.length - 1 ? (
          <span className="wv-cc-chip wv-cc-chip--ok">{COMPLETION_LABEL[status]}</span>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={!canAdvance(step, record)}
            onClick={() => save(next(def, progress, Date.now()))}
          >
            {stepIndex(def, step.id) === def.steps.length - 1 ? 'Finish' : 'Next'}
          </Button>
        )}
      </footer>
    </article>
  );
}

function ConfirmRestart({ onRestart }: { onRestart: () => void }) {
  const [armed, setArmed] = useState(false);
  return armed ? (
    <span className="wv-cc-confirm">
      <Button size="sm" variant="danger" onClick={() => (setArmed(false), onRestart())}>
        Start again
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setArmed(false)}>
        Keep
      </Button>
    </span>
  ) : (
    <Button size="sm" variant="ghost" onClick={() => setArmed(true)}>
      Restart
    </Button>
  );
}
