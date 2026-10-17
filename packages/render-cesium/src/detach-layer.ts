import type { ImageryLayerLike } from './cesium-like.js';

/**
 * Take an imagery layer off the globe without destroying it. Cesium's
 * `ImageryLayer.destroy()` frees nothing of its own (it only marks the object destroyed), while
 * a globe tile that still holds one of the layer's imageries throws "This object was destroyed"
 * the next time it loads — and rendering stops for good. That happened on the test laptop on
 * 2026-10-17: ten weather overlays were switched off in 2D, the globe was opened again, and a
 * tile still loading an infrared frame touched its destroyed layer. Removed and not destroyed,
 * the layer's imageries are released as the tiles let go of them, and the layer is collected.
 */
export function detachImageryLayer(
  layers: { remove(layer: ImageryLayerLike, destroy?: boolean): boolean },
  layer: ImageryLayerLike,
): boolean {
  return layers.remove(layer, false);
}
