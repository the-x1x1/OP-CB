/**
 * WorldView as an MCP server for AI clients on this computer (operator decision 2026-10-20,
 * ADR-014 amendment): a client — Formicaria's tools, any Model Context Protocol client —
 * starts WorldView's own executable as a stdio server (`worldview-mcp.ts`), and each tool it
 * offers is one read of the local API (`/v1/…`), which the running app serves only while
 * Settings → Local API is on. Read-only: no tool changes anything, and what the local API will
 * not give (a source whose data may not leave the app, the household's people, this computer's
 * position without its own permission) the tools cannot give either.
 *
 * JSON-RPC 2.0, one message per line (the MCP stdio transport), written here by hand: the
 * protocol needs four methods, and no dependency is added for them.
 */

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_SERVER_NAME = 'worldview';

/** One GET of the local API: `{ status, body }`, or a thrown error when the app is not there. */
export type LocalApiGet = (path: string) => Promise<{ status: number; body: unknown }>;

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The local API path for the arguments, or why they will not do. */
  path: (args: Record<string, unknown>) => string | { error: string };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const text = q.toString();
  return text ? `?${text}` : '';
}

export const MCP_TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'worldview_status',
    title: 'OP-CB status',
    description:
      'Whether OP-CB is running and connected: online or offline, how many of its sources are live, whether what it shows is recorded (demo) data, and the app version.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/v1/health',
  },
  {
    name: 'worldview_sources',
    title: 'OP-CB sources',
    description:
      'Every data source OP-CB has (aircraft, ships, satellites, earthquakes, weather, alerts, local receivers…): on or off, its state, and — when its licence lets its data out of the app — how many objects it has and when it last reported.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/v1/sources',
  },
  {
    name: 'worldview_objects',
    title: 'Objects on OP-CB’s map',
    description:
      'Objects OP-CB holds now — aircraft, vessels, satellites, earthquakes, storms, weather stations, fires, sensors and more — optionally within a radius of a place and of given types. Each comes with its position, labels, freshness and source. Only objects every source of which allows its data out of the app are listed. Page with `cursor`.',
    inputSchema: {
      type: 'object',
      properties: {
        latitude: { type: 'number', minimum: -90, maximum: 90, description: 'Centre, decimal degrees' },
        longitude: { type: 'number', minimum: -180, maximum: 180, description: 'Centre, decimal degrees' },
        radiusKm: { type: 'number', minimum: 0.01, maximum: 500, description: 'Radius around the centre (default 50)' },
        types: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 8,
          description: 'Object types, e.g. aircraft, vessel, satellite, earthquake, storm, weather-alert, sensor',
        },
        since: { type: 'string', description: 'Only objects observed at or after this ISO 8601 time' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'At most this many (default 100)' },
        cursor: { type: 'string', description: 'The `next` of the previous page' },
      },
      additionalProperties: false,
    },
    path: (a) => {
      const lat = num(a['latitude']);
      const lon = num(a['longitude']);
      if ((lat === undefined) !== (lon === undefined)) return { error: 'latitude and longitude go together' };
      const types = Array.isArray(a['types']) ? a['types'].filter((t): t is string => typeof t === 'string') : [];
      return `/v1/objects${query({
        lat,
        lon,
        radiusKm: num(a['radiusKm']),
        type: types.length ? types.join(',') : undefined,
        since: str(a['since']),
        limit: num(a['limit']),
        cursor: str(a['cursor']),
      })}`;
    },
  },
  {
    name: 'worldview_track',
    title: 'An object’s track',
    description:
      'Where one object (by its id from worldview_objects) has been: its recorded positions over a time range of up to 24 hours (default the last hour), when its sources allow keeping and sharing them.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Object id, as worldview_objects gives it' },
        from: { type: 'string', description: 'ISO 8601 start (default an hour before `to`)' },
        to: { type: 'string', description: 'ISO 8601 end (default now)' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    path: (a) => {
      const id = str(a['id']);
      if (!id) return { error: 'id is required' };
      return `/v1/track${query({ id, from: str(a['from']), to: str(a['to']) })}`;
    },
  },
  {
    name: 'worldview_offline',
    title: 'OP-CB offline readiness',
    description:
      'What OP-CB can do without the internet now: the connection, whether Work offline is on, what works locally, the offline packs installed and the data vaults.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/v1/offline',
  },
  {
    name: 'worldview_own_position',
    title: 'This computer’s position',
    description:
      'This computer’s own GPS position, from a receiver plugged into it, with its fix time and accuracy — only when the operator has allowed it in Settings → Local API, and no coordinates without a fix.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/v1/own-position',
  },
]);

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

type Reply = Record<string, unknown> | undefined;

const rpcError = (id: unknown, code: number, message: string): Reply => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

/** A tool's answer: the local API's JSON as text, an error as a tool error the model can read. */
function toolText(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

const NOT_RUNNING =
  'OP-CB is not running, or its local API is off. Open OP-CB and turn on Settings → Local API ("Let other programs on this computer read OP-CB").';

/**
 * One message in, at most one message out (none for a notification). Unknown methods are
 * JSON-RPC errors; a tool that fails says why in its result, as MCP asks.
 */
export async function handleMcpMessage(raw: unknown, get: LocalApiGet, info: { version: string }): Promise<Reply> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return rpcError(null, -32600, 'invalid request');
  const msg = raw as JsonRpcRequest;
  const isNotification = msg.id === undefined;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
  if (msg.jsonrpc !== '2.0' || !method) return isNotification ? undefined : rpcError(msg.id, -32600, 'invalid request');
  const ok = (result: Record<string, unknown>): Reply => ({ jsonrpc: '2.0', id: msg.id, result });

  switch (method) {
    case 'initialize': {
      const asked = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
      const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : MCP_PROTOCOL_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, title: 'OP-CB', version: info.version },
        instructions:
          'Read-only access to what OP-CB, a map of the live physical world, holds on this computer: its sources, objects near a place, tracks and offline readiness. Positions are WGS 84 decimal degrees; times are ISO 8601 UTC.',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined;
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: MCP_TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const name = typeof params['name'] === 'string' ? params['name'] : '';
      const tool = MCP_TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(msg.id, -32602, `unknown tool: ${name.slice(0, 64)}`);
      const args = (
        params['arguments'] && typeof params['arguments'] === 'object' ? params['arguments'] : {}
      ) as Record<string, unknown>;
      const path = tool.path(args);
      if (typeof path !== 'string') return ok(toolText(path.error, true));
      try {
        const { status, body } = await get(path);
        const text = JSON.stringify(body, null, 2);
        return ok(toolText(text, status >= 400));
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return ok(
          toolText(/ENOENT|ECONNREFUSED|not running/i.test(why) ? NOT_RUNNING : `OP-CB did not answer: ${why}`, true),
        );
      }
    }
    default:
      return isNotification ? undefined : rpcError(msg.id, -32601, `method not found: ${method.slice(0, 64)}`);
  }
}
