import type {
  AiTestAnswer,
  CatalogAnswer,
  CatalogRequest,
  GuideProgress,
  LibraryDownloadRequest,
  LibraryDownloadStatus,
  LibraryFindAnswer,
  LibraryFindRequest,
  LibraryOpenRequest,
  LibraryShelf,
  LibrarySearchAnswer,
  LocalServiceStatus,
  MapDownloadRequest,
  MapDownloadStatus,
  MeshTestAnswer,
  ModeState,
  OperatingMode,
  PrepRecord,
  WorldClient,
} from '@opcb/ipc-contract';
import type { WorldObject } from '@opcb/world-model';
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
  /** The map download, as the runtime last said (polled while it runs). */
  mapDownload: MapDownloadStatus;
  /** The built-in library: books, references, and the download into it (polled while it runs). */
  shelf: LibraryShelf | null;
  libraryDownload: LibraryDownloadStatus;
  lastLibraryFind?: LastSearch;
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
  mapDownload: { phase: 'idle' },
  shelf: null,
  libraryDownload: { phase: 'idle' },
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
    void this.refreshShelf();
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

  // ---- map download --------------------------------------------------------------------------
  private mapTimer: ReturnType<typeof setInterval> | undefined;

  private watchMap(): void {
    if (this.mapTimer) return;
    this.mapTimer = setInterval(() => void this.refreshMap(), 1000);
  }

  async refreshMap(): Promise<MapDownloadStatus> {
    try {
      const st = await this.client.request('maps.download.status', undefined);
      this.set({ mapDownload: st });
      if (!['planning', 'downloading', 'verifying', 'installing'].includes(st.phase) && this.mapTimer) {
        clearInterval(this.mapTimer);
        this.mapTimer = undefined;
      }
      return st;
    } catch {
      return this.state.mapDownload;
    }
  }

  async planMap(req: MapDownloadRequest): Promise<void> {
    try {
      this.set({ mapDownload: await this.client.request('maps.download.plan', req) });
      this.watchMap();
    } catch (err) {
      this.set({
        mapDownload: { phase: 'failed', request: req, message: err instanceof Error ? err.message : 'refused' },
      });
    }
  }

  async startMap(): Promise<void> {
    this.set({ mapDownload: await this.client.request('maps.download.start', undefined) });
    this.watchMap();
  }

  async cancelMap(): Promise<void> {
    this.set({ mapDownload: await this.client.request('maps.download.cancel', undefined) });
    this.watchMap();
  }

  // ---- the built-in library -----------------------------------------------------------------
  private libraryTimer: ReturnType<typeof setInterval> | undefined;

  async refreshShelf(): Promise<LibraryShelf | null> {
    try {
      const shelf = await this.client.request('library.shelf', undefined);
      this.set({ shelf });
      return shelf;
    } catch {
      return this.state.shelf;
    }
  }

  async findInLibrary(req: LibraryFindRequest): Promise<LibraryFindAnswer> {
    const offline = this.isOffline();
    const answer = await this.client.request('library.find', req);
    this.set({ lastLibraryFind: { offline, text: req.query, count: answer.hits.length, at: this.now() } });
    return answer;
  }

  async openLibrary(req: LibraryOpenRequest): Promise<{ opened: boolean; message?: string }> {
    try {
      return await this.client.request('library.open', req);
    } catch (err) {
      return { opened: false, message: err instanceof Error ? err.message : 'not opened' };
    }
  }

  async searchCatalog(req: CatalogRequest): Promise<CatalogAnswer> {
    try {
      return await this.client.request('library.catalog', req);
    } catch (err) {
      return { ok: false, entries: [], message: err instanceof Error ? err.message : 'the catalogue did not answer' };
    }
  }

  private watchLibrary(): void {
    if (this.libraryTimer) return;
    this.libraryTimer = setInterval(() => void this.refreshLibraryDownload(), 1000);
  }

  async refreshLibraryDownload(): Promise<LibraryDownloadStatus> {
    try {
      const st = await this.client.request('library.download.status', undefined);
      const was = this.state.libraryDownload.phase;
      this.set({ libraryDownload: st });
      if (st.phase !== 'downloading' && st.phase !== 'verifying') {
        if (this.libraryTimer) clearInterval(this.libraryTimer);
        this.libraryTimer = undefined;
        if (was === 'downloading' || was === 'verifying') void this.refreshShelf();
      }
      return st;
    } catch {
      return this.state.libraryDownload;
    }
  }

  async startLibraryDownload(req: LibraryDownloadRequest): Promise<void> {
    try {
      this.set({ libraryDownload: await this.client.request('library.download.start', req) });
      this.watchLibrary();
    } catch (err) {
      this.set({ libraryDownload: { phase: 'failed', message: err instanceof Error ? err.message : 'refused' } });
    }
  }

  async cancelLibraryDownload(): Promise<void> {
    this.set({ libraryDownload: await this.client.request('library.download.cancel', undefined) });
    this.watchLibrary();
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
