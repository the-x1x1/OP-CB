/**
 * The Guided Setup Engine's vocabulary (the Command Center, 2026-10-30). A walkthrough is data:
 * an ordered list of steps, each with its words, its links, the real control it offers (an
 * action) and the check that proves it worked. The engine (guide-engine.ts) moves through it;
 * the checks (checks.ts) ask the runtime what is really there; the runner draws it.
 *
 * Every walkthrough answers five questions: what does this do, what do I need, how do I set it
 * up, how do I use it, how do I know it works. Its words are bundled with the app, so a guide
 * reads the same with no network; a step that needs the internet says so before the operator
 * goes offline.
 */

/** The Command Center's sections. */
export type SectionId = 'overview' | 'world' | 'knowledge' | 'intelligence' | 'comms' | 'prepare' | 'resources';

/**
 * A check a step can run. Each asks the runtime (or the world the shell mirrors) for evidence
 * and answers pass or fail with what it saw; none passes because a button was pressed.
 */
export type CheckId =
  | 'mode.offline'
  | 'maps.packActive'
  | 'maps.vaultReady'
  | 'maps.offlineMap'
  | 'maps.searchOffline'
  | 'mesh.sourceOn'
  | 'mesh.nodeConnected'
  | 'mesh.ownFix'
  | 'mesh.otherNodeHeard'
  | 'mesh.messageAcked'
  | 'mesh.onMap'
  | 'sdr.sourceOn'
  | 'sdr.receiving'
  | 'ai.running'
  | 'ai.modelInstalled'
  | 'ai.inference'
  | 'library.running'
  | 'library.hasBooks'
  | 'library.search'
  | 'learning.running'
  | 'prep.hasItems'
  | 'prep.hasWaterAndMedical'
  | 'prep.hasContact';

/**
 * A real control a step offers: it does the thing (asks the runtime), it does not pretend to.
 * Anything that changes the operator's computer or radio beyond WorldView's own settings is
 * not an action here: the guide says how to do it in the right tool.
 */
export type ActionId =
  | 'mode.offline'
  | 'mode.online'
  | 'maps.installPack'
  | 'maps.addVault'
  | 'maps.openMap'
  | 'maps.searchPlace'
  | 'mesh.enable'
  | 'mesh.openSettings'
  | 'mesh.showOnMap'
  | 'mesh.sendTest'
  | 'sdr.enable'
  | 'sdr.openSettings'
  | 'services.refresh'
  | 'ai.runTest'
  | 'ai.openSection'
  | 'library.open'
  | 'library.search'
  | 'learning.open'
  | 'prep.openInventory'
  | 'prep.addStarter'
  | 'prep.exportChecklist';

export interface GuideLink {
  label: string;
  /** https only, on a host the app allows (external-links.ts). */
  url: string;
}

export interface GuideChoice {
  id: string;
  label: string;
  /** One line on what it means or what follows from choosing it. */
  detail?: string;
  /** Marks an option that cannot work as asked (generic LoRa boards, a receive-only radio). */
  unsupported?: boolean;
}

export interface Troubleshoot {
  problem: string;
  fix: string;
}

export interface GuideStep {
  id: string;
  title: string;
  /** Paragraphs, plain words; a technical term is explained where it first appears. */
  body: readonly string[];
  bullets?: readonly string[];
  /** Words shown only after a choice was made, keyed by the choice's id. */
  byChoice?: Readonly<Record<string, readonly string[]>>;
  /** The step whose choice `byChoice` reads (default: this one). */
  choiceFrom?: string;
  /** Pages to read, opened in the browser: always marked as needing the internet. */
  links?: readonly GuideLink[];
  /** Said before the operator goes offline: what this step needs the internet for. */
  needsInternet?: string;
  choice?: { prompt: string; options: readonly GuideChoice[] };
  actions?: readonly ActionId[];
  check?: CheckId;
  troubleshooting?: readonly Troubleshoot[];
  /** May be skipped; skipping a step with a check leaves the guide unverified. */
  optional?: boolean;
  /** The final functional test: the guide is verified only if this passed. */
  final?: boolean;
}

export interface GuideDefinition {
  id: string;
  /** Bumped when the steps change meaning: older progress starts again. */
  version: number;
  section: SectionId;
  title: string;
  /** One line: what this sets up. */
  summary: string;
  /** What it is for, before any step. */
  whatItDoes: string;
  /** What the operator needs before starting. */
  prerequisites: readonly string[];
  /** Equipment that helps, by kind (optional). */
  equipment?: readonly { kind: string; items: readonly string[] }[];
  steps: readonly GuideStep[];
}

export interface CheckResult {
  status: 'pass' | 'fail' | 'unavailable';
  /** What was found, in words. */
  message: string;
  /** For a pass: what the evidence was (kept with the progress). */
  evidence?: string;
}
