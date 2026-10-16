import type { WorldProvider } from './provider.js';

/**
 * The value of a drawn overlay at one point, on demand (ADR-003 amendment 2026-10-15) —
 * optional and additive, like object-details.ts: no existing type changed, `WorldProvider`
 * untouched. A provider that publishes a raster overlay (`overlays()`) and whose service can
 * say what lies under one pixel of it — a WMS layer's GetFeatureInfo — implements
 * `overlayValue`. The host asks it only when the operator asks about a point (What's here),
 * and only for an overlay the shell is drawing; a provider never sweeps an area.
 *
 * The answer is what the service says, named as the service names it (a radar mosaic's
 * `GRAY_INDEX`, a band's name): the overlay is a picture, and only its source knows what its
 * colours stand for. `undefined` means nothing there — outside the layer, no data at that
 * pixel, or a service that does not answer such questions.
 */
export interface OverlayValueRequest {
  /** The id of the overlay the shell is drawing (`RasterOverlay.id`), one this provider published. */
  overlayId: string;
  /** The point asked about. */
  position: { latitude: number; longitude: number };
  signal: AbortSignal;
}

export interface OverlayValue {
  /**
   * The value's name: the service's own (`Band1`, `temperature`), or the one the source's
   * definition gives it (`Reflectivity`) when the service's says nothing to a reader.
   */
  name: string;
  /** As the service gave it; a number stays a number. */
  value: string | number;
  /**
   * The unit, when the source's definition states it (additive, 2026-10-16): a service's
   * answer never says, and a unit is never guessed.
   */
  unit?: string;
}

export interface OverlayValueAnswer {
  /** The layer answered for, as the shell names the overlay (`Weather radar`). */
  label: string;
  /** The frame the answer is for (ISO 8601), when the layer has a time. */
  frame?: string;
  /** At most MAX_OVERLAY_VALUES, in the order the service gave them. */
  values: OverlayValue[];
  /** Licence/attribution line the source requires, shown with the values. */
  attribution?: string;
}

export interface OverlayValueSource {
  /**
   * Resolve undefined when there is nothing at the point. Throwing is allowed; the host logs
   * it and What's here shows the point without the answer.
   */
  overlayValue(request: OverlayValueRequest): Promise<OverlayValueAnswer | undefined>;
}

export function isOverlayValueSource(provider: WorldProvider): provider is WorldProvider & OverlayValueSource {
  return typeof (provider as Partial<OverlayValueSource>).overlayValue === 'function';
}

/** The most values one answer carries; the rest are dropped. */
export const MAX_OVERLAY_VALUES = 12;
/** The longest value name and string value kept. */
export const MAX_OVERLAY_VALUE_CHARS = 120;
