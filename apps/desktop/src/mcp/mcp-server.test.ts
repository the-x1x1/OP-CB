import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_TOOLS, handleMcpMessage, type LocalApiGet } from './mcp-server.js';

const asked: string[] = [];
const get: LocalApiGet = async (path) => {
  asked.push(path);
  if (path.startsWith('/v1/track')) return { status: 403, body: { error: { code: 'forbidden', message: 'no' } } };
  return { status: 200, body: { at: '2026-10-20T08:00:00.000Z', path } };
};
const info = { version: '0.6.0' };
const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
  handleMcpMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, get, info);

test('mcp: initialize answers a version the client knows, and the tools are read-only', async () => {
  const r = await handleMcpMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    get,
    info,
  );
  assert.equal((r?.result as { protocolVersion: string }).protocolVersion, '2025-03-26');
  const unknown = await handleMcpMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    get,
    info,
  );
  assert.equal((unknown?.result as { protocolVersion: string }).protocolVersion, '2025-06-18');
  assert.equal(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, get, info), undefined);
  const list = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, get, info);
  const tools = (list?.result as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> }).tools;
  assert.deepEqual(
    tools.map((t) => t.name),
    MCP_TOOLS.map((t) => t.name),
  );
  assert.ok(tools.every((t) => t.annotations.readOnlyHint));
});

test('mcp: each tool is one read of the local API, with its arguments as query parameters', async () => {
  asked.length = 0;
  await call(3, 'opcb_status');
  await call(4, 'opcb_objects', {
    latitude: 21.3,
    longitude: -157.86,
    radiusKm: 25,
    types: ['aircraft', 'vessel'],
    limit: 10,
  });
  await call(5, 'opcb_track', { id: 'aircraft:adsb-lol:a1b2c3', from: '2026-10-20T07:00:00Z' });
  await call(6, 'opcb_own_position');
  assert.deepEqual(asked, [
    '/v1/health',
    '/v1/objects?lat=21.3&lon=-157.86&radiusKm=25&type=aircraft%2Cvessel&limit=10',
    '/v1/track?id=aircraft%3Aadsb-lol%3Aa1b2c3&from=2026-10-20T07%3A00%3A00Z',
    '/v1/own-position',
  ]);
});

test('mcp: refusals and failures are tool errors the model can read, not protocol errors', async () => {
  const forbidden = await call(7, 'opcb_track', { id: 'x' });
  assert.equal((forbidden?.result as { isError?: boolean }).isError, true);
  const half = await call(8, 'opcb_objects', { latitude: 1 });
  assert.match(JSON.stringify(half?.result), /longitude go together/);
  const noId = await call(9, 'opcb_track', {});
  assert.match(JSON.stringify(noId?.result), /id is required/);
  const down = await handleMcpMessage(
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'opcb_status' } },
    async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    },
    info,
  );
  assert.match(JSON.stringify(down?.result), /OP-CB is not running, or its local API is off/);
  const unknown = await call(11, 'opcb_delete_everything');
  assert.equal((unknown?.error as { code: number }).code, -32602);
  const method = await handleMcpMessage({ jsonrpc: '2.0', id: 12, method: 'resources/list' }, get, info);
  assert.equal((method?.error as { code: number }).code, -32601);
  assert.equal((await handleMcpMessage('nonsense', get, info))?.error !== undefined, true);
});
