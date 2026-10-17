/**
 * Graphics quality: how much GPU work the renderers are allowed to spend per frame, as a
 * setting the operator chooses (Settings → Map → Graphics quality) or leaves on Auto.
 *
 * The performance governor (performance.ts) trades *what* is drawn against the frame rate:
 * icons become markers, markers become points. It cannot change *how* a frame is drawn —
 * multisampling, the pixel density of the canvas, how sharp the terrain and imagery tiles
 * have to be — and on an integrated GPU those are where the frame goes. A Radeon 740M
 * drawing the globe at 1.25× device pixels with 4× MSAA spends most of each frame on fill
 * rate before a single marker is placed. Those settings are fixed when the canvas is created
 * or cheap to change, so they belong to a setting, not to the per-second governor.
 */

export type GraphicsQuality = 'high' | 'balanced' | 'low';
export type GraphicsSetting = 'auto' | GraphicsQuality;

export const GRAPHICS_SETTINGS: readonly GraphicsSetting[] = ['auto', 'high', 'balanced', 'low'];

export interface GraphicsProfile {
  quality: GraphicsQuality;
  /** MSAA samples for the globe (1 = off). */
  msaaSamples: 1 | 2 | 4;
  /** FXAA post-process, the cheap substitute when MSAA is off. */
  fxaa: boolean;
  /** Highest canvas pixel density drawn, in device pixels per CSS pixel. */
  maxPixelRatio: number;
  /**
   * Cesium's `globe.maximumScreenSpaceError`: how many pixels of error a terrain/imagery tile
   * may show before a finer one is fetched. 2 is Cesium's default; 4 fetches roughly a
   * quarter of the tiles at the same view.
   */
  maximumScreenSpaceError: number;
  /** Globe tiles kept resident beyond those in view. */
  tileCacheSize: number;
  /**
   * Draw nearby aircraft and ships as 3D models when the globe's camera is close in
   * (render-cesium layers/models.ts). A few dozen textured meshes are cheap on any GPU that
   * runs the balanced profile, but each is a draw call of its own and a pass through the
   * PBR shader, which is exactly where Low exists to save. The operator's "3D models when
   * close" switch (Settings → Map) overrides it either way: `withModels`.
   */
  models3d: boolean;
}

const PROFILES: Readonly<Record<GraphicsQuality, GraphicsProfile>> = Object.freeze({
  high: {
    quality: 'high',
    msaaSamples: 4,
    fxaa: false,
    maxPixelRatio: 2,
    maximumScreenSpaceError: 2,
    tileCacheSize: 400,
    models3d: true,
  },
  balanced: {
    quality: 'balanced',
    msaaSamples: 2,
    fxaa: false,
    maxPixelRatio: 1.25,
    maximumScreenSpaceError: 3,
    tileCacheSize: 300,
    models3d: true,
  },
  low: {
    quality: 'low',
    msaaSamples: 1,
    fxaa: true,
    maxPixelRatio: 1,
    maximumScreenSpaceError: 4,
    tileCacheSize: 200,
    models3d: false,
  },
});

export function graphicsProfile(quality: GraphicsQuality): GraphicsProfile {
  return PROFILES[quality];
}

/**
 * A profile with the operator's "3D models when close" choice applied: `undefined` (never
 * chosen) keeps the profile's own default — on for High and Balanced, off for Low — and a
 * boolean replaces it. The profile objects are frozen and shared, so a changed one is a copy.
 */
export function withModels(profile: GraphicsProfile, models3d: boolean | undefined): GraphicsProfile {
  if (models3d === undefined || models3d === profile.models3d) return profile;
  return { ...profile, models3d };
}

export type GpuClass = 'discrete' | 'integrated' | 'software' | 'unknown';

/**
 * Classify the GPU from the WebGL renderer string (`WEBGL_debug_renderer_info`), which on
 * Windows reads like `ANGLE (AMD, AMD Radeon(TM) 740M Graphics (0x000015BF) Direct3D11 …)`.
 *
 * The string is a hint, not a measurement — the governor still watches the real frame rate —
 * so the rules are conservative: a name is only called discrete when it is a known discrete
 * family, and anything unrecognised is `unknown`, which Auto treats like integrated. Guessing
 * low on a fast machine costs some sharpness until the operator picks High; guessing high on
 * a slow one costs a stuttering map, which is the worse failure.
 */
export function classifyGpu(renderer: string | undefined | null): GpuClass {
  if (!renderer) return 'unknown';
  const s = renderer.toLowerCase();
  if (/swiftshader|llvmpipe|softpipe|microsoft basic render|software/.test(s)) return 'software';
  // Discrete families first: "Radeon RX", "Radeon Pro W", NVIDIA GeForce/RTX/Quadro, Intel Arc.
  if (/geforce|\brtx\b|quadro|nvidia|tesla|radeon (rx|pro)|radeon\(tm\) (rx|pro)|intel\(r\) arc|\barc a\d/.test(s))
    return 'discrete';
  // Integrated: Intel UHD/Iris/HD, AMD APU graphics ("Radeon(TM) 740M", "Radeon Graphics",
  // "Vega 8"), Apple silicon, mobile GPUs.
  if (
    /intel|iris|uhd graphics|hd graphics|radeon\(tm\) \d{3}m|radeon \d{3}m|radeon\(tm\) graphics|radeon graphics|vega \d|apple m\d|apple gpu|adreno|mali|powervr/.test(
      s,
    )
  )
    return 'integrated';
  return 'unknown';
}

/** What Auto means on this GPU. */
export function autoGraphicsQuality(gpu: GpuClass): GraphicsQuality {
  switch (gpu) {
    case 'discrete':
      return 'high';
    case 'software':
      return 'low';
    default:
      return 'balanced';
  }
}

export function resolveGraphicsQuality(
  setting: GraphicsSetting | undefined,
  gpuRenderer: string | undefined,
): GraphicsQuality {
  if (setting === 'high' || setting === 'balanced' || setting === 'low') return setting;
  return autoGraphicsQuality(classifyGpu(gpuRenderer));
}

/** The canvas pixel density to draw at on this display, under a profile. */
export function pixelRatioFor(profile: GraphicsProfile, devicePixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, profile.maxPixelRatio);
}

/**
 * Sharpness on Auto: the profile Auto picks is a floor, not a ceiling. Balanced on an
 * integrated GPU draws the globe at 1.25 device pixels and lets tiles show 3 px of error; on
 * a 2× laptop screen that is a canvas at 0.625 of the display, upscaled, with imagery a
 * level coarser than it could be — the map looked soft while the frame rate sat at 60. Each
 * step up draws a quarter of a device pixel more (to the display's own density, at most 2)
 * and asks half a pixel less of tile error (to Cesium's default of 2). MSAA is not touched:
 * changing it rebuilds the WebGL context.
 */
export const SHARPNESS_PIXEL_STEP = 0.25;
export const SHARPNESS_ERROR_STEP = 0.5;

/** The profile `step` steps sharper than `base` on a display of `devicePixelRatio`. */
export function sharperProfile(base: GraphicsProfile, step: number, devicePixelRatio: number): GraphicsProfile {
  if (step <= 0) return base;
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const pixelCap = Math.max(base.maxPixelRatio, Math.min(dpr, 2));
  return {
    ...base,
    maxPixelRatio: Math.min(pixelCap, base.maxPixelRatio + step * SHARPNESS_PIXEL_STEP),
    maximumScreenSpaceError: Math.max(
      Math.min(2, base.maximumScreenSpaceError),
      base.maximumScreenSpaceError - step * SHARPNESS_ERROR_STEP,
    ),
  };
}

/** How many steps up from `base` still change something on this display. */
export function maxSharpnessStep(base: GraphicsProfile, devicePixelRatio: number): number {
  let step = 0;
  while (step < 16) {
    const here = sharperProfile(base, step, devicePixelRatio);
    const next = sharperProfile(base, step + 1, devicePixelRatio);
    if (next.maxPixelRatio === here.maxPixelRatio && next.maximumScreenSpaceError === here.maximumScreenSpaceError)
      break;
    step++;
  }
  return step;
}

export interface SharpnessSample {
  /** The window's average and lowest frame rate (the shell's 10 s perf window). */
  fpsAvg: number;
  fpsMin: number;
}

/**
 * Walks the sharpness steps on the frame rate, like the presentation governor
 * (performance.ts): up slowly — three good windows in a row, more for each time a step
 * failed — and down at once. The window after a change is not judged: it holds the new
 * tiles arriving. A step that has failed twice is not tried again.
 */
export class SharpnessGovernor {
  private stepNow = 0;
  private good = 0;
  private settle = 1;
  private readonly failures = new Map<number, number>();
  private readonly maxStep: number;

  constructor(
    private readonly base: GraphicsProfile,
    private readonly devicePixelRatio: number,
    private readonly opts: { goodAvg?: number; goodMin?: number; badAvg?: number; badMin?: number } = {},
  ) {
    this.maxStep = maxSharpnessStep(base, devicePixelRatio);
  }

  get step(): number {
    return this.stepNow;
  }

  profile(): GraphicsProfile {
    return sharperProfile(this.base, this.stepNow, this.devicePixelRatio);
  }

  /** A closed window; true when the step changed (apply `profile()`). */
  sample(s: SharpnessSample): boolean {
    if (!Number.isFinite(s.fpsAvg) || !Number.isFinite(s.fpsMin)) return false;
    if (this.settle > 0) {
      this.settle--;
      return false;
    }
    const bad = s.fpsAvg < (this.opts.badAvg ?? 50) || s.fpsMin < (this.opts.badMin ?? 30);
    if (bad) {
      this.good = 0;
      if (this.stepNow === 0) return false;
      this.failures.set(this.stepNow, (this.failures.get(this.stepNow) ?? 0) + 1);
      this.stepNow--;
      this.settle = 1;
      return true;
    }
    const good = s.fpsAvg >= (this.opts.goodAvg ?? 58) && s.fpsMin >= (this.opts.goodMin ?? 45);
    if (!good) {
      this.good = 0;
      return false;
    }
    this.good++;
    const next = this.stepNow + 1;
    const failed = this.failures.get(next) ?? 0;
    if (next > this.maxStep || failed >= 2 || this.good < 3 + 3 * failed) return false;
    this.stepNow = next;
    this.good = 0;
    this.settle = 1;
    return true;
  }

  /** The mode changed: frames from the one left say nothing about the one arriving. */
  resetRuns(): void {
    this.good = 0;
    this.settle = 1;
  }
}
