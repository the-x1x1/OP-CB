import type {
  AiTestAnswer,
  GuideProgress,
  LibrarySearchAnswer,
  LocalServiceStatus,
  MeshTestAnswer,
  ModeState,
  OperatingMode,
  PrepRecord,
  WorldClient,
} from '@worldview/ipc-contract';
import type { WorldObject } from '@worldview/world-model';
import { MESH_PROVIDER, RECEIVER_PROVIDERS, type LastSearch } from './checks.js';
import type { SectionId } from './guide-types.js';

/**
 * The Command Center's own state, beside the shell's store: whether it is open and where, the
 * mode, the local services, walkthrough progress, the inventory, and the last results of the
 * tests a walkthrough checks (a place search, a library search, an AI answer, a test message).
 * The runtime holds everything that lasts; this keeps what the page needs to draw it.
 */
export interface CommandCenterState {
  open: boolean;
  section: SectionId;
  /** The walkthrough open over the section, if any. */
  guideId: string | null;
  mode: ModeState | null;
  modeError: string | null;
  services: LocalServiceStatus[] | null;
  servicesBusy: boolean;
  guides: GuideProgress[];
  prep: PrepRecord[];
  meshNodes: WorldObject[] | null;
  receiverObjects: number | null;
  lastPlaceSearch?: LastSearch;
  lastLibrarySearch?: LastSearch & { book: string; answer: LibrarySearchAnswer };
  lastAiTest?: { offline: boolean; answer: AiTestAnswer };
  aiBusy: boolean;
  lastMeshTest?: { to: string; name: string; answer: MeshTestAnswer };
  meshBusy: boolean;
}

export const INITIAL_CC_STATE: CommandCenterState = {
  open: false,
  section: 'overview',
  guideId: null,
  mode: null,
  modeError: null,
  services: null,
  servicesBusy: false,
  guides: [],
  prep: [],
  meshNodes: null,
  receiverObjects: null,
  aiBusy: false,
  meshBusy: false,
};

type Listener = () => void;

export class CommandCenterStore {
  private state: CommandCenterState = INITIAL_CC_STATE;
  private readonly listeners = new Set<Listener>();
  private started = false;

  constructor(
    private readonly client: WorldClient,
    private readonly now: () => number = Date.now,
  ) {}

  get = (): CommandCenterState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<CommandCenterState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }

  /** Read what lasts, once; the mode again whenever settings change (Work offline in Settings). */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.refreshMode();
    void this.loadRecords();
    this.client.on('settings.changed', () => void this.refreshMode());
  }

  isOffline(): boolean {
    return this.state.mode?.chosen === 'offline';
  }

  // ---- navigation --------------------------------------------------------------------------
  openAt(section: SectionId = this.state.section, guideId: string | null = null): void {
    this.set({ open: true, section, guideId });
    void this.refreshServices();
  }
  close(): void {
    this.set({ open: false, guideId: null });
  }
  show(section: SectionId): void {
    this.set({ section, guideId: null });
  }
  openGuide(guideId: string | null): void {
    this.set({ guideId });
  }

  // ---- the mode ----------------------------------------------------------------------------
  async refreshMode(): Promise<void> {
    try {
      this.set({ mode: await this.client.request('mode.state', undefined), modeError: null });
    } catch (err) {
      this.set({ modeError: err instanceof Error ? err.message : 'the runtime did not answer' });
    }
  }

  async chooseMode(mode: OperatingMode): Promise<boolean> {
    try {
      this.set({ mode: await this.client.request('mode.choose', { mode }), modeError: null });
      return true;
    } catch (err) {
      this.set({ modeError: err instanceof Error ? err.message : 'the mode was not set' });
      return false;
    }
  }

  // ---- local services ----------------------------------------------------------------------
  async refreshServices(): Promise<void> {
    if (this.state.servicesBusy) return;
    this.set({ servicesBusy: true });
    try {
      this.set({ services: await this.client.request('services.status', undefined) });
    } catch {
      this.set({ services: [] });
    } finally {
      this.set({ servicesBusy: false });
    }
  }

  async openService(id: LocalServiceStatus['id'], path?: string): Promise<boolean> {
    try {
      return (await this.client.request('services.open', path ? { id, path } : { id })).opened;
    } catch {
      return false;
    }
  }

  async librarySearch(book: string, pattern: string): Promise<LibrarySearchAnswer> {
    const offline = this.isOffline();
    const answer = await this.client.request('library.search', { book, pattern });
    this.set({
      lastLibrarySearch: { offline, text: pattern, count: answer.hits.length, at: this.now(), book, answer },
    });
    return answer;
  }

  async aiTest(model: string, prompt: string): Promise<AiTestAnswer> {
    const offline = this.isOffline();
    this.set({ aiBusy: true });
    try {
      const answer = await this.client.request('ai.test', { model, prompt });
      this.set({ lastAiTest: { offline, answer } });
      return answer;
    } finally {
      this.set({ aiBusy: false });
    }
  }

  async meshTest(to: string, name: string, text: string): Promise<MeshTestAnswer> {
    this.set({ meshBusy: true });
    try {
      const answer = await this.client.request('mesh.sendTest', { to, text });
      this.set({ lastMeshTest: { to, name, answer } });
      return answer;
    } finally {
      this.set({ meshBusy: false });
    }
  }

  notePlaceSearch(text: string, count: number): void {
    this.set({ lastPlaceSearch: { offline: this.isOffline(), text, count, at: this.now() } });
  }

  // ---- what the checks fetch -----------------------------------------------------------------
  async refreshMeshNodes(): Promise<WorldObject[]> {
    try {
      const r = await this.client.request('world.query', { providerIds: [MESH_PROVIDER], limit: 500 });
      this.set({ meshNodes: r.items });
      return r.items;
    } catch {
      this.set({ meshNodes: [] });
      return [];
    }
  }

  async refreshReceivers(): Promise<number> {
    try {
      const r = await this.client.request('world.query', { providerIds: [...RECEIVER_PROVIDERS], limit: 1 });
      this.set({ receiverObjects: r.total });
      return r.total;
    } catch {
      this.set({ receiverObjects: 0 });
      return 0;
    }
  }

  // ---- records -------------------------------------------------------------------------------
  async loadRecords(): Promise<void> {
    try {
      const [guides, prep] = await Promise.all([
        this.client.request('guides.list', undefined),
        this.client.request('prep.list', undefined),
      ]);
      this.set({ guides, prep });
    } catch {
      /* the Command Center shows what it has */
    }
  }

  async saveGuide(progress: GuideProgress): Promise<void> {
    // Shown at once; written behind.
    this.set({ guides: [...this.state.guides.filter((g) => g.id !== progress.id), progress] });
    try {
      this.set({ guides: await this.client.request('guides.save', progress) });
    } catch {
      /* kept for this session; the next save tries again */
    }
  }

  async resetGuide(id: string): Promise<void> {
    try {
      this.set({ guides: await this.client.request('guides.reset', { id }) });
    } catch {
      this.set({ guides: this.state.guides.filter((g) => g.id !== id) });
    }
  }

  async savePrep(record: PrepRecord): Promise<boolean> {
    try {
      this.set({ prep: await this.client.request('prep.save', record) });
      return true;
    } catch {
      return false;
    }
  }

  async deletePrep(id: string): Promise<void> {
    try {
      this.set({ prep: await this.client.request('prep.delete', { id }) });
    } catch {
      /* unchanged */
    }
  }

  async exportPrep(format: 'csv' | 'json'): Promise<string | null> {
    try {
      const r = await this.client.request('prep.export', { format });
      return 'cancelled' in r ? null : r.path;
    } catch {
      return null;
    }
  }
}

const stores = new WeakMap<WorldClient, CommandCenterStore>();

/** One store per client (the window's), made on first use. */
export function commandCenterStoreFor(client: WorldClient): CommandCenterStore {
  let s = stores.get(client);
  if (!s) {
    s = new CommandCenterStore(client);
    stores.set(client, s);
  }
  return s;
}
