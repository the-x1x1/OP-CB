import type { GuideDefinition, SectionId } from '../guide-types.js';
import { MAPS_GUIDE } from './maps.js';
import { MESHTASTIC_GUIDE } from './meshtastic.js';
import { AI_GUIDE, LEARNING_GUIDE, LIBRARY_GUIDE, PREP_GUIDE, SDR_GUIDE, START_GUIDE } from './others.js';

/** Every walkthrough, in the order the Command Center lists them. */
export const GUIDES: readonly GuideDefinition[] = Object.freeze([
  START_GUIDE,
  MAPS_GUIDE,
  LIBRARY_GUIDE,
  LEARNING_GUIDE,
  AI_GUIDE,
  MESHTASTIC_GUIDE,
  SDR_GUIDE,
  PREP_GUIDE,
]);

export function guideById(id: string): GuideDefinition | undefined {
  return GUIDES.find((g) => g.id === id);
}

export function guidesFor(section: SectionId): GuideDefinition[] {
  return GUIDES.filter((g) => g.section === section);
}
