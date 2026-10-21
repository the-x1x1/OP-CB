/**
 * The Connections tab (operator decision 2026-10-20): the operator's own receivers and servers
 * in one place — the radios (an RTL-SDR's ADS-B and AIS, a Meshtastic node), the boat, the
 * weather station and air sensor, and Home Assistant — each with its address, its switch and
 * whether it is answering. Pure: what the panel lists, and how a Home Assistant address reads.
 */

export interface ConnectionGroup {
  id: string;
  title: string;
  /** One line under the title: what plugs in here. */
  hint: string;
  providerIds: readonly string[];
}

export const HOME_ASSISTANT_PROVIDERS = Object.freeze([
  'home-assistant-zones',
  'home-assistant-weather',
  'home-assistant-sensors',
  'home-assistant-people',
] as const);

export const HOME_ASSISTANT_TOKEN_KEY = 'home-assistant-token';

export const CONNECTION_GROUPS: readonly ConnectionGroup[] = Object.freeze([
  {
    id: 'radios',
    title: 'Radios',
    hint: 'An RTL-SDR decoding aircraft (readsb, dump1090) or ships (an AIS decoder), and a Meshtastic node by USB or on the network. Receive only.',
    providerIds: ['readsb-local', 'ais-local', 'meshtastic-local'],
  },
  {
    id: 'boat',
    title: 'Boat',
    hint: 'NMEA 2000 through your gateway: the boat and the ships its AIS hears.',
    providerIds: ['nmea2000-local'],
  },
  {
    id: 'sensors',
    title: 'Weather station and air',
    hint: 'A Davis WeatherLink Live and a PurpleAir sensor on your network.',
    providerIds: ['weatherlink-local', 'purpleair-local'],
  },
]);

export interface HaAddress {
  host: string;
  port: number;
  tls: boolean;
}

/**
 * What the operator types for their Home Assistant — `homeassistant.local`,
 * `192.168.1.20:8123`, `http://ha.lan:8123/`, `https://ha.lan` — as the connector's host, port
 * and TLS settings. A path, a user, a query or a fragment is refused: the connector names one
 * host and asks it for /api only.
 */
export function readHaAddress(text: string): { ok: true; address: HaAddress } | { ok: false; reason: string } {
  const raw = text.trim();
  if (!raw) return { ok: false, reason: 'enter the address of your Home Assistant' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: 'that is not an address' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, reason: 'the address is http:// or https://' };
  if (url.username || url.password) return { ok: false, reason: 'no user name in the address: the token is the key' };
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash)
    return { ok: false, reason: 'just the host (and port): no path after it' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'the address has no host' };
  const tls = url.protocol === 'https:';
  const port = url.port ? Number(url.port) : /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? (tls ? 443 : 80) : 8123;
  return { ok: true, address: { host: host.toLowerCase(), port, tls } };
}

/** The address as the form shows it again, from the connector's settings. */
export function haAddressText(settings: Record<string, unknown> | undefined): string {
  const host = typeof settings?.['host'] === 'string' ? settings['host'] : '';
  if (!host) return '';
  const tls = settings?.['tls'] === true;
  const port = typeof settings?.['port'] === 'number' ? settings['port'] : 8123;
  return `${tls ? 'https' : 'http'}://${host}:${port}`;
}
