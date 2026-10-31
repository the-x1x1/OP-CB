import type { WorldProvider } from '@opcb/provider-sdk';
import { createProvider as createCamerasLocal } from '@opcb/provider-cameras-local';
import {
  createProvider as createPublicCameras,
  createUnverifiedProvider as createUnverifiedCameras,
  createSingaporeProvider as createSingaporeCameras,
} from '@opcb/provider-cctv-public';

/**
 * Camera workstream factories (partial registry map). The registry index merges the
 * per-workstream maps into the full `providerFactories` record.
 */
export const cameraProviderFactories: Readonly<Record<string, () => WorldProvider>> = Object.freeze({
  'cameras-local': createCamerasLocal,
  'public-cameras': createPublicCameras,
  'public-cameras-unverified': createUnverifiedCameras,
  'public-cameras-singapore': createSingaporeCameras,
});
