import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { AppSettings } from '@opcb/ipc-contract';
import { useActions, useAppSlice, useClient } from '../store/store.js';
import { commandCenterStoreFor, type CommandCenterState, type CommandCenterStore } from './cc-store.js';
import { checkNeeds, runCheck, type CheckData } from './checks.js';
import type { CheckId, CheckResult } from './guide-types.js';
import { evaluateReadiness, type ReadinessItem } from './readiness.js';

/** The Command Center's store for this window, started on first use. */
export function useCCStore(): CommandCenterStore {
  const client = useClient();
  const store = useMemo(() => commandCenterStoreFor(client), [client]);
  useEffect(() => store.start(), [store]);
  return store;
}

export function useCC(): [CommandCenterState, CommandCenterStore] {
  const store = useCCStore();
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  return [state, store];
}

/** What the checks read from the shell's own store. */
export function useShellFacts() {
  const offline = useAppSlice((s) => s.offline.status);
  const field = useAppSlice((s) => s.offline.field);
  const sources = useAppSlice((s) => s.sources.entries);
  const settings = useAppSlice((s) => s.session.settings);
  return { offline, field, sources, settings };
}

export function checkData(cc: CommandCenterState, facts: ReturnType<typeof useShellFacts>, nowMs: number): CheckData {
  return {
    nowMs,
    mode: cc.mode,
    offline: facts.offline,
    sources: facts.sources,
    services: cc.services,
    aiModel: facts.settings?.services?.aiModel,
    prep: cc.prep,
    ...(cc.meshNodes ? { meshNodes: cc.meshNodes } : {}),
    ...(cc.receiverObjects !== null ? { receiverObjects: cc.receiverObjects } : {}),
    ...(cc.lastPlaceSearch ? { lastPlaceSearch: cc.lastPlaceSearch } : {}),
    ...(cc.lastLibrarySearch ? { lastLibrarySearch: cc.lastLibrarySearch } : {}),
    shelf: cc.shelf,
    ...(cc.lastLibraryFind ? { lastLibraryFind: cc.lastLibraryFind } : {}),
    ...(cc.lastAiTest ? { lastAiTest: cc.lastAiTest } : {}),
    ...(cc.lastMeshTest ? { lastMeshTest: cc.lastMeshTest } : {}),
  };
}

/** Run a check now: fetch what it needs that the shell does not already hold, then judge. */
export function useRunCheck(): (id: CheckId) => Promise<CheckResult> {
  const [, store] = useCC();
  const facts = useShellFacts();
  const actions = useActions();
  return useCallback(
    async (id: CheckId) => {
      const needs = checkNeeds(id);
      const work: Promise<unknown>[] = [store.refreshMode(), actions.refreshFieldStatus()];
      if (needs.meshNodes) work.push(store.refreshMeshNodes());
      if (needs.receivers) work.push(store.refreshReceivers());
      if (needs.services) work.push(store.refreshServices());
      if (needs.shelf) work.push(store.refreshShelf());
      await Promise.all(work);
      // Read the store after the fetches: the hook's state is the render's, not the newest.
      return runCheck(id, checkData(store.get(), facts, Date.now()));
    },
    [store, facts, actions],
  );
}

export function useReadiness(): ReadinessItem[] {
  const [cc] = useCC();
  const facts = useShellFacts();
  return useMemo(
    () => evaluateReadiness({ ...checkData(cc, facts, Date.now()), guides: cc.guides, field: facts.field }),
    [cc, facts],
  );
}

/** Save part of the settings and let the runtime say what it kept. */
export function useSaveSettings(): (patch: Partial<AppSettings>) => Promise<boolean> {
  const client = useClient();
  const actions = useActions();
  return useCallback(
    async (patch) => {
      try {
        await client.request('settings.set', patch);
        return true;
      } catch (err) {
        actions.notify('Not saved', err instanceof Error ? err.message : 'the setting was refused', 'MINOR');
        return false;
      }
    },
    [client, actions],
  );
}
