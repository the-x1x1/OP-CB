import {
  EventTypes,
  ObjectTypes,
  classifyConfidence,
  isIsoTimestamp,
  makeEventId,
  parseObjectId,
  positionToGeometry,
  type JsonValue,
  type WorldEvent,
  type WorldObject,
} from '@opcb/world-model';
import { derivedProvenance, refsOf, shortUtc, stringProp, type ObjectRule, type RuleContext } from './types.js';

/**
 * launchRule — one INFO event per launch object (when a launch provider exists).
 *
 *   id       event:launch:<namespace>:<value>
 *   startAt  properties.net | windowStart | observedAt;  endAt = properties.windowEnd (when present)
 *   title    labels.name | properties.mission | "Launch"
 *   summary  the time no more precise than properties.netPrecision (LL2's Day, Month, …) says
 */
export const launchRule: ObjectRule = {
  id: 'launch',
  objectTypes: [ObjectTypes.Launch],
  eventTypes: [EventTypes.Launch],
  scope: 'changed',
  evaluate(objects, ctx) {
    const out: WorldEvent[] = [];
    for (const o of objects) {
      if (o.type !== ObjectTypes.Launch) continue;
      const e = launchEvent(o, ctx);
      if (e) out.push(e);
    }
    return out;
  },
};

function isoProp(o: WorldObject, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o.properties[k];
    if (typeof v === 'string' && isIsoTimestamp(v)) return v;
  }
  return undefined;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * The time a launch is held for, said no more precisely than the source knows it (LL2
 * `net_precision`): a launch known to the month is "October 2026", not a minute in it.
 */
export function netText(at: string, precision: string | undefined): string {
  const d = new Date(at);
  if (!precision || ['Second', 'Minute'].includes(precision) || !Number.isFinite(d.getTime())) return shortUtc(at);
  const iso = d.toISOString();
  const day = iso.slice(0, 10);
  const year = d.getUTCFullYear();
  if (precision === 'Hour') return `${day} ${iso.slice(11, 13)}:00 UTC (the hour only)`;
  if (precision === 'Day') return `${day} (the day only)`;
  if (precision === 'Morning') return `${day}, some time in the morning`;
  if (precision === 'Afternoon') return `${day}, some time in the afternoon`;
  if (precision === 'Week') return `the week of ${day} (the week only)`;
  if (precision === 'Month') return `${MONTHS[d.getUTCMonth()]} ${year} (the month only)`;
  // LL2's /config/netprecision: "Quarter 1"…"Quarter 4", "Year Half 1"/"2", "Year", "Fiscal
  // Year", "Decade" — the time it holds is the start of that span.
  if (precision.startsWith('Quarter')) return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${year} (the quarter only)`;
  if (precision.startsWith('Year Half'))
    return `${d.getUTCMonth() < 6 ? 'first' : 'second'} half of ${year} (the half-year only)`;
  if (precision === 'Year') return `${year} (the year only)`;
  if (precision === 'Fiscal Year') return `fiscal year ${year} (only)`;
  if (precision === 'Decade') return `the ${Math.floor(year / 10) * 10}s (the decade only)`;
  // A name not known here: the date, and the source's own word for how precise it is.
  return `${day} (${precision.slice(0, 40)})`;
}

function launchEvent(o: WorldObject, ctx: RuleContext): WorldEvent | undefined {
  const parsed = parseObjectId(o.id);
  if (!parsed) return undefined;
  const name = stringProp(o, 'name') ?? stringProp(o, 'mission') ?? 'Launch';
  const provider = stringProp(o, 'launchProvider', 'agency', 'operator');
  const vehicle = stringProp(o, 'vehicle', 'rocket');
  const pad = stringProp(o, 'pad', 'site', 'place');
  const status = stringProp(o, 'status');
  const startAt = isoProp(o, 'net', 'windowStart', 'launchAt') ?? o.observedAt;
  const endAt = isoProp(o, 'windowEnd');
  const parts: string[] = [];
  if (vehicle) parts.push(vehicle);
  if (provider) parts.push(`by ${provider}`);
  if (pad) parts.push(`from ${pad}`);
  parts.push(`NET ${netText(startAt, stringProp(o, 'netPrecision'))}`);
  let summary = parts.join(' ') + '.';
  if (status) summary += ` Status: ${status}.`;
  const properties: Record<string, JsonValue> = {};
  if (provider) properties['launchProvider'] = provider;
  if (vehicle) properties['vehicle'] = vehicle;
  if (pad) properties['pad'] = pad;
  if (status) properties['status'] = status;
  const event: WorldEvent = {
    id: makeEventId(EventTypes.Launch, parsed.namespace, parsed.value),
    type: EventTypes.Launch,
    title: `Launch — ${name}`,
    startAt,
    objectIds: [o.id],
    observationRefs: refsOf([o]),
    confidence: classifyConfidence(o.confidence),
    severity: 'INFO',
    summary,
    properties,
    provenance: derivedProvenance([o], ctx.nowIso, refsOf([o])),
  };
  if (endAt) event.endAt = endAt;
  if (o.position) event.geometry = positionToGeometry(o.position);
  else if (o.geometry) event.geometry = o.geometry;
  return event;
}
