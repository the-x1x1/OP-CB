/**
 * Work offline (Settings → Network; `AppSettings.network.workOffline`): WorldView asks
 * nothing of the internet while it is on. One switch, applied at every door out of the app:
 *
 *  - the runtime's fetch (providers, the reachability probe, camera stills) — `gatedFetch`;
 *  - Electron's `net` in main (the tile cache, online place search, the updater) and every
 *    request the page makes (map tiles, imagery) — `blockInternetRequests` on the session;
 *  - the connectivity signal the runtime folds into its verdict reads offline, so sources
 *    pause as they do when the cable is out and the shell says so.
 *
 * Requests to this computer stay allowed (the camera relay, go2rtc, a local receiver), and so
 * do the app's own schemes (`worldview:`, `file:`, `data:`, `blob:`).
 *
 * The operator's own network (2026-10-30, the Command Center): a request to another device on
 * the LAN is stopped like any other unless the operator approved that one host
 * (`network.localHosts`; command-center.ts `localHostProblem` takes only private and
 * link-local addresses and local-only names). No range is ever trusted as a whole. Sources that
 * hold their own connection (MQTT, a Meshtastic node over TCP) are not fetches and keep running
 * either way, as before.
 *
 * What this is: WorldView's own doors. It is not a firewall, and says nothing about other
 * programs on the computer.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Whether a URL leaves this computer for the network: http(s) or ws(s) to a non-loopback host. */
export function leavesThisComputer(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  return !(LOOPBACK.has(host) || host.endsWith('.localhost') || /^127\./.test(host));
}

export class WorkingOfflineError extends Error {
  constructor(url: string) {
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      /* keep the text */
    }
    super(`working offline: ${host} not asked`);
    this.name = 'WorkingOfflineError';
  }
}

/** The hosts approved for offline use, as the gate compares them. */
export type ApprovedHosts = () => ReadonlySet<string>;
const NONE: ApprovedHosts = () => new Set();

/** Whether a request to `url` is stopped while offline: it leaves this computer, for a host not approved. */
export function blockedOffline(url: string, approved: ApprovedHosts = NONE): boolean {
  if (!leavesThisComputer(url)) return false;
  let host: string;
  try {
    host = new URL(url).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
  } catch {
    return true;
  }
  return !approved().has(host);
}

/** A fetch that refuses, without sending anything, every request that would leave this computer while offline. */
export function gatedFetch(
  inner: typeof fetch,
  workingOffline: () => boolean,
  approved: ApprovedHosts = NONE,
): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (workingOffline() && blockedOffline(url, approved)) return Promise.reject(new WorkingOfflineError(url));
    return inner(input, init);
  }) as typeof fetch;
}

/** The part of Electron's session this needs. */
export interface RequestFilterSession {
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: (details: { url: string }, callback: (response: { cancel?: boolean }) => void) => void,
    ): void;
  };
}

/** Cancel, on the session, every page and `net` request that would leave this computer while offline. */
export function blockInternetRequests(
  session: RequestFilterSession,
  workingOffline: () => boolean,
  onBlocked?: (url: string) => void,
  approved: ApprovedHosts = NONE,
): void {
  session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      const cancel = workingOffline() && blockedOffline(details.url, approved);
      if (cancel) onBlocked?.(details.url);
      callback(cancel ? { cancel: true } : {});
    },
  );
}
