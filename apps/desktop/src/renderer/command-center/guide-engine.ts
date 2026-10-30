import type { GuideProgress, GuideStepRecord } from '@worldview/ipc-contract';
import type { CheckResult, GuideDefinition, GuideStep } from './guide-types.js';

/**
 * The Guided Setup Engine: where a walkthrough is and what may happen next. Pure — every rule is
 * tested without a screen.
 *
 * The rules that keep it honest:
 *  - a step with a check is finished only by a check that passed (`verified`), never by Next;
 *  - it may be skipped (the operator's call), but a skipped or failed check leaves the whole
 *    guide `unverified`, and the final test must have passed for `verified`;
 *  - progress made against an older version of the guide is not carried over.
 */

export type GuideCompletion = 'not-started' | 'in-progress' | 'verified' | 'unverified';

const iso = (ms: number) => new Date(ms).toISOString();

/** The progress, if it belongs to this version of the guide. */
export function currentProgress(def: GuideDefinition, saved: GuideProgress | undefined): GuideProgress | undefined {
  if (!saved || saved.id !== def.id || saved.guideVersion !== def.version) return undefined;
  if (!def.steps.some((s) => s.id === saved.currentStepId)) return undefined;
  return saved;
}

export function startGuide(def: GuideDefinition, nowMs: number): GuideProgress {
  const at = iso(nowMs);
  return {
    id: def.id,
    guideVersion: def.version,
    currentStepId: def.steps[0]!.id,
    steps: {},
    startedAt: at,
    updatedAt: at,
  };
}

export function stepIndex(def: GuideDefinition, stepId: string): number {
  return def.steps.findIndex((s) => s.id === stepId);
}

export function currentStep(def: GuideDefinition, p: GuideProgress): GuideStep {
  return def.steps[Math.max(0, stepIndex(def, p.currentStepId))]!;
}

/** Whether Next is open on a step: a check must have passed; a choice must have been made. */
export function canAdvance(step: GuideStep, record: GuideStepRecord | undefined): boolean {
  if (step.check) return record?.outcome === 'verified';
  if (step.choice) return record?.choice !== undefined;
  return true;
}

/** Skip is offered on a step that is optional or has a check (the operator may not have the hardware yet). */
export function canSkip(step: GuideStep): boolean {
  return step.optional === true || (step.check !== undefined && !step.final);
}

function withStep(p: GuideProgress, stepId: string, rec: GuideStepRecord, nowMs: number): GuideProgress {
  return { ...p, steps: { ...p.steps, [stepId]: rec }, updatedAt: iso(nowMs) };
}

function moveTo(def: GuideDefinition, p: GuideProgress, index: number, nowMs: number): GuideProgress {
  if (index >= def.steps.length) {
    const { completedAt: _old, ...rest } = p;
    return { ...rest, completedAt: iso(nowMs), updatedAt: iso(nowMs) };
  }
  const { completedAt: _done, ...rest } = p;
  return { ...rest, currentStepId: def.steps[Math.max(0, index)]!.id, updatedAt: iso(nowMs) };
}

/** A check ran on the current step: its outcome is kept, pass or fail, with what it saw. */
export function recordCheck(def: GuideDefinition, p: GuideProgress, result: CheckResult, nowMs: number): GuideProgress {
  const step = currentStep(def, p);
  if (!step.check) return p;
  const prior = p.steps[step.id];
  const evidence = (result.status === 'pass' ? (result.evidence ?? result.message) : result.message).slice(0, 500);
  return withStep(
    p,
    step.id,
    {
      outcome: result.status === 'pass' ? 'verified' : 'failed',
      at: iso(nowMs),
      evidence,
      ...(prior?.choice !== undefined ? { choice: prior.choice } : {}),
    },
    nowMs,
  );
}

/** The operator chose an option on the current step. */
export function recordChoice(def: GuideDefinition, p: GuideProgress, choice: string, nowMs: number): GuideProgress {
  const step = currentStep(def, p);
  if (!step.choice?.options.some((o) => o.id === choice)) return p;
  const prior = p.steps[step.id];
  return withStep(
    p,
    step.id,
    {
      ...(prior ?? { outcome: 'done' }),
      outcome: prior?.outcome === 'verified' ? 'verified' : 'done',
      at: iso(nowMs),
      choice,
    },
    nowMs,
  );
}

/** Next: only when `canAdvance`. A step with nothing to check is recorded `done` as it is left. */
export function next(def: GuideDefinition, p: GuideProgress, nowMs: number): GuideProgress {
  const step = currentStep(def, p);
  const rec = p.steps[step.id];
  if (!canAdvance(step, rec)) return p;
  const marked = step.check || rec ? p : withStep(p, step.id, { outcome: 'done', at: iso(nowMs) }, nowMs);
  return moveTo(def, marked, stepIndex(def, step.id) + 1, nowMs);
}

/** Skip: recorded as skipped (a check that had passed stays verified), then on. */
export function skip(def: GuideDefinition, p: GuideProgress, nowMs: number): GuideProgress {
  const step = currentStep(def, p);
  if (!canSkip(step)) return p;
  const rec = p.steps[step.id];
  const marked =
    rec?.outcome === 'verified'
      ? p
      : withStep(
          p,
          step.id,
          { outcome: 'skipped', at: iso(nowMs), ...(rec?.choice !== undefined ? { choice: rec.choice } : {}) },
          nowMs,
        );
  return moveTo(def, marked, stepIndex(def, step.id) + 1, nowMs);
}

export function back(def: GuideDefinition, p: GuideProgress, nowMs: number): GuideProgress {
  const i = stepIndex(def, p.currentStepId);
  return i <= 0 ? p : moveTo(def, p, i - 1, nowMs);
}

/** Open a finished guide again at a step (to look again, or re-run a test). */
export function goTo(def: GuideDefinition, p: GuideProgress, stepId: string, nowMs: number): GuideProgress {
  const i = stepIndex(def, stepId);
  return i < 0 ? p : moveTo(def, p, i, nowMs);
}

/**
 * Where the guide stands. `verified`: finished, every check step verified and the final test
 * passed. `unverified`: finished with a check skipped or failed. Progress against another
 * version counts as not started.
 */
export function completion(def: GuideDefinition, saved: GuideProgress | undefined): GuideCompletion {
  const p = currentProgress(def, saved);
  if (!p) return 'not-started';
  if (!p.completedAt) return 'in-progress';
  const checked = def.steps.filter((s) => s.check);
  const allVerified = checked.every((s) => p.steps[s.id]?.outcome === 'verified');
  return allVerified ? 'verified' : 'unverified';
}

/** Whether one check step of a guide was verified (readiness reads the final tests this way). */
export function stepVerified(
  def: GuideDefinition,
  saved: GuideProgress | undefined,
  stepId: string,
): GuideStepRecord | undefined {
  const p = currentProgress(def, saved);
  const rec = p?.steps[stepId];
  return rec?.outcome === 'verified' ? rec : undefined;
}

/** The words a step shows for the choice made earlier (`byChoice`), if any. */
export function choiceWords(step: GuideStep, p: GuideProgress | undefined): readonly string[] {
  if (!step.byChoice || !p) return [];
  const choice = p.steps[step.choiceFrom ?? step.id]?.choice;
  return (choice !== undefined && step.byChoice[choice]) || [];
}

/** "Step 3 of 9". */
export function stepLabel(def: GuideDefinition, p: GuideProgress): string {
  return `Step ${stepIndex(def, p.currentStepId) + 1} of ${def.steps.length}`;
}
