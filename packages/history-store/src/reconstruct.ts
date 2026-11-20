import { computeConfidence, type WorldObject } from '@opcb/world-model';
import { extractLabels, extractMotion } from '@opcb/state-engine';
import type { IdentityResolver } from '@opcb/identity';
import { rowToObservation, type HistoryRow, type RowToObservationOptions } from './row.js';

/**
 * Rebuild a WorldObject from one history row. Identity is resolved with the same
 * deterministic resolver the live state uses (ADR-011), so a replayed object has the
 * same id as its live counterpart. Freshness is always HISTORICAL and provenance
 * origin 'historical' — replayed data never masquerades as live. Labels and motion are read
 * from the payload by the live state's own functions, so an object reads the same replayed
 * as it did live.
 */
export type ProviderInfoResolver = (providerId: string) => RowToObservationOptions | undefined;

export function rowToWorldObject(
  row: HistoryRow,
  identity: IdentityResolver,
  providerInfo?: ProviderInfoResolver,
): WorldObject {
  const obs = rowToObservation(row, providerInfo?.(row.providerId));
  const resolution = identity.resolve(obs);
  const obj: WorldObject = {
    id: resolution.objectId,
    type: obs.objectType,
    sourceRefs: [{ observationId: obs.id, providerId: obs.providerId, observedAt: obs.observedAt }],
    observedAt: obs.observedAt,
    updatedAt: obs.observedAt,
    freshness: 'HISTORICAL',
    confidence: computeConfidence({
      sourceQuality: obs.quality.sourceQuality,
      freshness: 'HISTORICAL',
      providerCount: 1,
      identityAuthoritative: resolution.authoritative,
    }),
    labels: extractLabels(obs.payload),
    properties: { ...obs.payload },
    provenance: obs.provenance,
  };
  if (obs.position) obj.position = obs.position;
  if (obs.geometry) obj.geometry = obs.geometry;
  const motion = extractMotion(obs.payload);
  if (motion) obj.motion = motion;
  return obj;
}
