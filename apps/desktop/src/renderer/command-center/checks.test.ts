import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import type { SourceHealthEntry } from '@worldview/source-health';
import type { ModeState, OfflineStatus } from '@worldview/ipc-contract';
import { runCheck, type CheckData } from './checks.js';
import { dueItems, evaluateReadiness, readinessSummary } from './readiness.js';
import { GUIDES } from './guides/index.js';
import { startGuide, recordCheck, next, goTo } from './guide-engine.js';

const NOW = Date.parse('2026-10-30T09:00:00.000Z');

function mesh(health: Partial<SourceHealthEntry['health']>, enabled = true): SourceHealthEntry {
  return {
    providerId: 'meshtastic-local',
    name: 'Meshtastic mesh',
    enabled,
    health: { status: 'LIVE', ...health },
    meta: { credentialsRequired: [] },
  } as unknown as SourceHealthEntry;
}

function node(props: Record<string, unknown>, position = true): WorldObject {
  return {
    id: `sensor:meshtastic-local:${String(props['name'])}`,
    type: 'sensor',
    properties: props,
    ...(position ? { position: { latitude: 21.3, longitude: -157.8 } } : {}),
  } as unknown as WorldObject;
}

function data(over: Partial<CheckData> = {}): CheckData {
  return { nowMs: NOW, mode: null, offline: null, sources: [], services: null, aiModel: undefined, prep: [], ...over };
}

const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

test('mesh: connected needs the node list, not just a live source', () => {
  assert.equal(
    runCheck('mesh.nodeConnected', data({ sources: [mesh({ message: 'waiting for the node list' })] })).status,
    'fail',
  );
  const ok = runCheck(
    'mesh.nodeConnected',
    data({ sources: [mesh({ message: '3 nodes on the mesh, 2 with a position; this node: Base (TBEAM)' })] }),
  );
  assert.equal(ok.status, 'pass');
  assert.match(ok.message, /this node: Base/);
  assert.equal(runCheck('mesh.nodeConnected', data({ sources: [mesh({}, false)] })).status, 'fail');
  assert.equal(runCheck('mesh.nodeConnected', data()).status, 'unavailable');
});

test('mesh: a second radio counts only when heard by radio, recently, and never this node', () => {
  const sources = [mesh({ message: '2 nodes on the mesh' })];
  const self = node({ name: 'Base', thisNode: true, lastHeardAt: iso(5_000) });
  const mqtt = node({ name: 'Far', viaMqtt: true, lastHeardAt: iso(60_000) });
  const old = node({ name: 'Old', lastHeardAt: iso(3 * 3600_000), hopsAway: 0 });
  assert.equal(runCheck('mesh.otherNodeHeard', data({ sources, meshNodes: [self] })).status, 'fail');
  const viaInternet = runCheck('mesh.otherNodeHeard', data({ sources, meshNodes: [self, mqtt] }));
  assert.match(viaInternet.message, /MQTT/);
  assert.equal(viaInternet.status, 'fail');
  assert.match(runCheck('mesh.otherNodeHeard', data({ sources, meshNodes: [self, old] })).message, /15 minutes/);
  const heard = runCheck(
    'mesh.otherNodeHeard',
    data({
      sources,
      meshNodes: [self, old, node({ name: 'Hiker', lastHeardAt: iso(40_000), hopsAway: 0, snrDb: 6.5 })],
    }),
  );
  assert.equal(heard.status, 'pass');
  assert.equal(heard.evidence, 'Hiker heard directly by radio, SNR 6.5 dB, 40 s ago');
  const relayed = runCheck(
    'mesh.otherNodeHeard',
    data({ meshNodes: [node({ name: 'Ridge', lastHeardAt: iso(120_000), hopsAway: 2 })] }),
  );
  assert.match(relayed.message, /over 2 hops, 2 min ago/);
});

test('own fix: only a GPS fix passes; manual, stale and no fix are said apart', () => {
  const fix = runCheck(
    'mesh.ownFix',
    data({ sources: [mesh({ ownPosition: { state: 'fix', fixType: '3D', satellites: 9, fixAt: iso(30_000) } })] }),
  );
  assert.equal(fix.message, 'GPS fix (3D), 9 satellites, 30 s ago.');
  assert.match(
    runCheck('mesh.ownFix', data({ sources: [mesh({ ownPosition: { state: 'manual' } })] })).message,
    /by hand/,
  );
  assert.match(
    runCheck('mesh.ownFix', data({ sources: [mesh({ ownPosition: { state: 'no-fix' } })] })).message,
    /NO FIX/,
  );
});

const status = (over: Partial<OfflineStatus> = {}): OfflineStatus =>
  ({
    connection: {},
    packs: [],
    capabilities: { localMap: false, localSearch: false, history: true, collections: true, localAircraft: false },
    ...over,
  }) as unknown as OfflineStatus;
const pack = {
  id: 'oahu',
  name: "O'ahu",
  version: '1.0.0',
  installedAt: iso(0),
  sizeBytes: 1,
  bounds: { west: 0, south: 0, east: 1, north: 1 },
  contents: [],
  status: 'active' as const,
};

test('maps: the offline test needs Offline mode and an active map; a search must run offline', () => {
  const online: ModeState = {
    chosen: 'online',
    remembered: 'online',
    osOnline: true,
    localHosts: [],
    enforcement: 'app',
  };
  const off: ModeState = { ...online, chosen: 'offline' };
  const withMap = status({
    packs: [pack],
    capabilities: { localMap: true, localSearch: true, history: true, collections: true, localAircraft: false },
  });
  assert.match(runCheck('maps.offlineMap', data({ mode: online, offline: withMap })).message, /Offline mode first/);
  assert.equal(runCheck('maps.offlineMap', data({ mode: off, offline: status() })).status, 'fail');
  assert.equal(runCheck('maps.offlineMap', data({ mode: off, offline: withMap })).status, 'pass');
  assert.equal(
    runCheck(
      'maps.packActive',
      data({ offline: status({ packs: [{ ...pack, status: 'invalid', message: 'vault not connected' }] }) }),
    ).message,
    `"O'ahu" is installed but not usable: vault not connected.`,
  );
  assert.equal(
    runCheck('maps.searchOffline', data({ lastPlaceSearch: { offline: false, text: 'Kailua', count: 3, at: NOW } }))
      .status,
    'fail',
  );
  assert.equal(
    runCheck('maps.searchOffline', data({ lastPlaceSearch: { offline: true, text: 'Kailua', count: 3, at: NOW } }))
      .status,
    'pass',
  );
});

test('preparedness: a listed item with no quantity is not counted', () => {
  const at = iso(0);
  const prep = [
    { id: 'w', kind: 'item' as const, category: 'water' as const, name: 'Water', updatedAt: at },
    { id: 'm', kind: 'item' as const, category: 'medical' as const, name: 'First aid kit', quantity: 1, updatedAt: at },
  ];
  assert.equal(runCheck('prep.hasItems', data({ prep })).status, 'pass');
  assert.match(runCheck('prep.hasWaterAndMedical', data({ prep })).message, /water/);
  const due = dueItems(
    [
      { id: 'a', kind: 'item', category: 'medical', name: 'Painkillers', expires: '2026-10-01', updatedAt: at },
      {
        id: 'b',
        kind: 'item',
        category: 'power',
        name: 'AA batteries',
        checkedOn: '2026-05-10',
        checkEveryDays: 180,
        updatedAt: at,
      },
      { id: 'c', kind: 'item', category: 'food', name: 'Rice', expires: '2028-01-01', updatedAt: at },
    ],
    NOW,
  );
  assert.deepEqual([due.expired.map((r) => r.id), due.soon.map((r) => r.id)], [['a'], ['b']]);
});

test('readiness: ready only with the final test passed; set up but untested says so; nothing invented', () => {
  const services = [
    {
      id: 'ollama' as const,
      name: 'Ollama',
      endpoint: 'http://127.0.0.1:11434',
      state: 'not-found' as const,
      checkedAt: iso(0),
    },
    {
      id: 'kiwix' as const,
      name: 'Kiwix',
      endpoint: 'http://127.0.0.1:8080',
      state: 'running' as const,
      books: [{ id: 'x', title: 'WikiMed' }],
      checkedAt: iso(0),
    },
    {
      id: 'kolibri' as const,
      name: 'Kolibri',
      endpoint: 'http://127.0.0.1:8080',
      state: 'other' as const,
      checkedAt: iso(0),
    },
  ];
  const offline = status({
    packs: [pack],
    capabilities: { localMap: true, localSearch: false, history: true, collections: true, localAircraft: false },
  });
  const base = { ...data({ offline, services, sources: [mesh({}, false)] }), guides: [], field: null };
  const items = evaluateReadiness(base);
  const by = (id: string) => items.find((i) => i.id === id)!;
  assert.equal(by('map').status, 'verification-required');
  assert.match(by('map').reason, /final test has not been run/);
  assert.equal(by('library').status, 'verification-required');
  assert.equal(by('ai').status, 'setup-required');
  assert.equal(by('mesh').status, 'setup-required');
  assert.equal(by('power').status, 'unavailable');
  assert.equal(by('gps').status, 'unavailable');

  // The maps guide's final test passed: the map is ready, with the evidence and its date.
  const maps = GUIDES.find((g) => g.id === 'offline-maps')!;
  let p = startGuide(maps, NOW);
  p = goTo(maps, p, 'offline-test', NOW);
  p = recordCheck(maps, p, { status: 'pass', message: 'Offline, with "O\'ahu" as the local map.' }, NOW);
  p = next(maps, p, NOW);
  const after = evaluateReadiness({ ...base, guides: [p] });
  assert.equal(after.find((i) => i.id === 'map')!.status, 'ready');
  assert.match(after.find((i) => i.id === 'map')!.reason, /tested 2026-10-30/);
  assert.deepEqual(readinessSummary(after), { ready: 1, total: 4, attention: 0 });
});

test('mesh message test: only an acknowledgement from the radio it was for passes', () => {
  const answer = (outcome: 'acknowledged' | 'relayed' | 'accepted' | 'refused', message = 'x') => ({
    outcome,
    evidence: {
      connected: true,
      accepted: true,
      relayed: outcome !== 'accepted',
      acknowledged: outcome === 'acknowledged',
    },
    message,
    at: '2026-10-30T09:00:12.000Z',
  });
  const t = (a: ReturnType<typeof answer>) =>
    runCheck('mesh.messageAcked', data({ lastMeshTest: { to: '!a1b2c3d4', name: 'Hiker', answer: a } }));
  assert.equal(t(answer('acknowledged')).status, 'pass');
  assert.equal(t(answer('acknowledged')).evidence, 'test message to Hiker acknowledged (09:00:12 UTC)');
  assert.match(t(answer('relayed')).message, /did not acknowledge/);
  assert.match(t(answer('accepted')).message, /queued/);
  assert.equal(t(answer('refused', "the radio's region is UNSET")).message, "The radio's region is UNSET.");
  assert.equal(runCheck('mesh.messageAcked', data()).status, 'fail');
});
