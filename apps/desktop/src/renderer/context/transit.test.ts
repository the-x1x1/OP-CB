import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gtfsWords, transitStop, transitTripStart } from './sections.js';

test('transit: the feed’s codes in words', () => {
  assert.equal(gtfsWords('MANY_SEATS_AVAILABLE'), 'Many seats available');
  assert.equal(gtfsWords('STOP_AND_GO'), 'Stop and go');
  assert.equal(gtfsWords(''), undefined);
  assert.equal(gtfsWords(undefined), undefined);
});

test('transit: where the vehicle is on its trip', () => {
  // MBTA's bus y1832 and Orange Line train O-548CA387, read live 2026-11-11 (fixture recorded/mbta-vehicles.pb).
  assert.equal(transitStop('STOPPED_AT', '899', 1), "Stopped at stop 899 (the trip's 1st)");
  assert.equal(transitStop('STOPPED_AT', '70279', 160), "Stopped at stop 70279 (the trip's 160th)");
  assert.equal(transitStop('IN_TRANSIT_TO', '9146', 23), "On its way to stop 9146 (the trip's 23rd)");
  assert.equal(transitStop('INCOMING_AT', 'place-dwnxg', 12), "Arriving at stop place-dwnxg (the trip's 12th)");
  assert.equal(transitStop(undefined, '5', undefined), 'At or near stop 5');
  assert.equal(transitStop('IN_TRANSIT_TO', undefined, undefined), 'In transit to', 'a status with no stop');
  assert.equal(transitStop(undefined, undefined, 3), undefined);
});

test('transit: when the trip starts, in the agency’s time', () => {
  assert.equal(transitTripStart('20261110 22:50:00'), '2026-11-10 22:50 (local time)');
  assert.equal(transitTripStart('20261110'), '2026-11-10 (local time)');
  assert.equal(transitTripStart('25:10:00'), '25:10:00', 'not a date: as given');
  assert.equal(transitTripStart(undefined), undefined);
});

test('transit: the section for MBTA bus y1832 as its feed gave it, unknowns left out', async () => {
  const { createElement, Fragment } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { contextRegistry } = await import('./index.js');
  const section = contextRegistry.sectionsFor('transit-vehicle').find((s) => s.id === 'transit-vehicle')!;
  const object = {
    id: 'transit-vehicle:mbta-gtfs-rt:y1832',
    type: 'transit-vehicle',
    labels: { name: '1832', route: '60' },
    properties: {
      routeId: '60',
      tripId: '78181228',
      directionId: 0,
      tripStart: '20261110 22:50:00',
      scheduleRelationship: 'SCHEDULED',
      stopId: '899',
      stopSequence: 1,
      stopStatus: 'STOPPED_AT',
      occupancy: 'MANY_SEATS_AVAILABLE',
      occupancyPercent: 0,
      congestion: 'UNKNOWN_CONGESTION_LEVEL',
    },
  } as never;
  const html = renderToStaticMarkup(createElement(Fragment, null, section.render({ object } as never)));
  const text = html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|').replace(/&#x27;/g, "'");
  for (const want of [
    '|Route|60|',
    "|Where|Stopped at stop 899 (the trip's 1st)|",
    '|Trip|78181228|',
    '|Direction|0|',
    '|Trip starts|2026-11-10 22:50 (local time)|',
    '|Timetable|On the timetable|',
    '|How full|Many seats available (0 % full)|',
  ])
    assert.ok(text.includes(want), `${want} in ${text}`);
  assert.ok(!text.includes('Traffic'), 'the feed not knowing the traffic is not a row');
  assert.ok(!text.includes('Wheelchair') && !text.includes('Plate'));
});
