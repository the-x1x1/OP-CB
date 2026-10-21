import { formatUtcDateTime } from '@worldview/ui';

/**
 * An event's end as the panel shows it: "Ended" once it is past; before then "Ends", or
 * "Kept until" when the end is only how long its reading stays fresh (weather-alert
 * `endFromFreshness`): the source may list it again, or stop listing it sooner.
 */
export function endRow(
  ev: { endAt?: string; properties?: Readonly<Record<string, unknown>> },
  nowMs: number,
): { label: string; value: string | undefined } {
  if (!ev.endAt) return { label: 'Ended', value: undefined };
  const value = formatUtcDateTime(ev.endAt);
  if (!(Date.parse(ev.endAt) > nowMs)) return { label: 'Ended', value };
  if (ev.properties?.['endFromFreshness'] === true)
    return { label: 'Kept until', value: `${value} (unless read again)` };
  return { label: 'Ends', value };
}
