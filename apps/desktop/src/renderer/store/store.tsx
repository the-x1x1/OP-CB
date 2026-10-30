import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
} from 'react';
import type { WorldClient } from '@worldview/ipc-contract';
import { initialState, rootReducer } from './reducer.js';
import type { RootAction, RootState } from './types.js';
import { createActions, type ShellActions } from './actions.js';
import { bindClient } from './sync.js';
import type { RendererHostLike } from '../renderer-host-like.js';

/**
 * Store = useReducer + context. Components read state with `useAppState()` and trigger
 * side effects through `useActions()` (typed wrappers around WorldClient requests that
 * dispatch results). `bindClient` subscribes to runtime events for the provider's lifetime.
 *
 * `useAppState()` hands out the whole state, so every component that calls it renders on every
 * world change — which is what the perf log's `shellParts` showed (2026-10-20: 55–156 ms of
 * "wait" before the shell's first part on the test laptop, the whole tree reconciling for a
 * delta that changed nothing it shows). `useAppSlice(selector)` renders a component only when
 * what it selects changes: the same state, read through a small external store beside the
 * reducer, with `useSyncExternalStore`. The parts of the shell that redraw often — the top
 * strip, the lens rail, the timeline bar — read through it.
 */
export interface HostRegistry {
  get(): RendererHostLike | null;
  set(host: RendererHostLike | null): void;
}

interface StoreContextValue {
  state: RootState;
  dispatch: Dispatch<RootAction>;
  actions: ShellActions;
  client: WorldClient;
  hosts: HostRegistry;
  /** The same state as an external store, for `useAppSlice`. */
  slices: SliceStore;
}

/** The state published to selector subscribers: the current value, and who to tell when it changes. */
export interface SliceStore {
  get(): RootState;
  subscribe(listener: () => void): () => void;
  /** The state changed: every subscriber re-runs its selector (and renders only if that differs). */
  notify(): void;
}

/** Exported for the test: the store `useAppSlice` reads, over whatever `get` returns now. */
export function createSliceStore(get: () => RootState): SliceStore {
  const listeners = new Set<() => void>();
  return {
    get,
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    notify: () => {
      for (const l of [...listeners]) l();
    },
  };
}

const StoreContext = createContext<StoreContextValue | null>(null);

export interface StoreProviderProps {
  client: WorldClient;
  children?: ReactNode | undefined;
  /** Pre-built state for static rendering/tests; when given no runtime binding happens. */
  initial?: RootState | undefined;
  /** Injected clock for tests. */
  now?: (() => number) | undefined;
  /** Renderer host to expose to the map (the map component may also set one at mount). */
  host?: RendererHostLike | undefined;
}

export function StoreProvider({ client, children, initial, now, host }: StoreProviderProps) {
  const clock = now ?? Date.now;
  const [state, dispatch] = useReducer(rootReducer, undefined, () => {
    const base = initial ?? initialState(clock());
    const supports3D = host ? (host.supportsMode ? host.supportsMode('3D') : true) : base.ui.supports3D;
    return supports3D === base.ui.supports3D ? base : rootReducer(base, { type: 'ui/hostCapabilities', supports3D });
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  // The external store for `useAppSlice`: subscribers are told after each render that
  // carried a new state, so their selectors run against what the reducer produced.
  const slices = useMemo(() => createSliceStore(() => stateRef.current), []);
  useEffect(() => slices.notify(), [state, slices]);
  const hostRef = useRef<RendererHostLike | null>(host ?? null);
  const hosts = useMemo<HostRegistry>(
    () => ({
      get: () => hostRef.current,
      set: (h) => {
        hostRef.current = h;
      },
    }),
    [],
  );
  const actions = useMemo(
    () => createActions({ client, dispatch, getState: () => stateRef.current, hosts, now: clock }),
    [client, hosts, clock],
  );

  useEffect(() => {
    if (initial) return;
    return bindClient({ client, dispatch, getState: () => stateRef.current, now: clock });
  }, [client, initial, clock]);

  const value = useMemo<StoreContextValue>(
    () => ({ state, dispatch, actions, client, hosts, slices }),
    [state, actions, client, hosts, slices],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

function useStoreContext(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('StoreProvider is missing above this component');
  return ctx;
}

export function useAppState(): RootState {
  return useStoreContext().state;
}

/**
 * The part of the state a component shows, rendered again only when that part changes
 * (`Object.is` on the selected value, so select a slice or a primitive, not a fresh object).
 * Read from the store directly, not the context value, so a world change that leaves the
 * selection as it was does not render the component at all.
 */
export function useAppSlice<T>(selector: (state: RootState) => T): T {
  const { slices } = useStoreContext();
  return useSyncExternalStore(
    slices.subscribe,
    () => selector(slices.get()),
    () => selector(slices.get()),
  );
}
export function useDispatch(): Dispatch<RootAction> {
  return useStoreContext().dispatch;
}
export function useActions(): ShellActions {
  return useStoreContext().actions;
}
export function useClient(): WorldClient {
  return useStoreContext().client;
}
export function useHosts(): HostRegistry {
  return useStoreContext().hosts;
}
