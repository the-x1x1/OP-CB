import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, testing } from '@opcb/provider-sdk';
import { HttpClient } from './http.js';
import { LoggerHub, RingBufferSink } from './logger.js';

const { VirtualClock } = testing;

/**
 * A source's key is put into the request by the HTTP layer, in whichever place the service
 * wants it: a query parameter of any name, a header, a bearer token, a part of the path, an
 * XML body. Whatever then goes wrong — a refusal, a redirect that repeats the address, a
 * network error whose text quotes it, a timeout — the key is in nothing the layer says: not
 * the error a source is given, not what that error records as its cause, not a log line.
 */
const SECRET = 'Qz7hPk2mVn9sXj4wRt8yBc3dLf6gUa5e';
const noSleep = async () => {};

const MODES = [
  {
    name: 'a query parameter',
    credential: { key: 'k', as: 'query' as const, name: 'appid' },
    url: 'https://api.example.org/v1/data?q=1',
  },
  {
    name: 'the default query parameter',
    credential: { key: 'k', as: 'query' as const },
    url: 'https://api.example.org/v1/data',
  },
  {
    name: 'an oddly named query parameter',
    credential: { key: 'k', as: 'query' as const, name: 'subscription-key' },
    url: 'https://api.example.org/v1/data',
  },
  {
    name: 'a header',
    credential: { key: 'k', as: 'header' as const, name: 'Ocp-Apim-Subscription-Key' },
    url: 'https://api.example.org/v1/data',
  },
  { name: 'a bearer token', credential: { key: 'k', as: 'bearer' as const }, url: 'https://api.example.org/v1/data' },
  {
    name: 'a part of the path',
    credential: { key: 'k', as: 'path' as const, name: 'TOKEN' },
    url: 'https://api.example.org/v1/{TOKEN}/data.json',
  },
  {
    name: 'an XML body',
    credential: { key: 'k', as: 'xml-body' as const, name: 'TOKEN' },
    url: 'https://api.example.org/v1/query',
    method: 'POST' as const,
    body: '<REQUEST><LOGIN authenticationkey="{TOKEN}"/></REQUEST>',
  },
];

type Outcome = (url: string, init: RequestInit) => Response | Promise<Response>;
const text = (init: RequestInit): string =>
  `${JSON.stringify(init.headers ?? {})} ${typeof init.body === 'string' ? init.body : ''}`;
const OUTCOMES: Array<{ name: string; respond: Outcome }> = [
  {
    name: 'HTTP 401 quoting the request',
    respond: (url, init) => new Response(`bad key in ${url} ${text(init)}`, { status: 401 }),
  },
  { name: 'HTTP 403', respond: () => new Response('forbidden', { status: 403 }) },
  { name: 'HTTP 404 quoting the address', respond: (url) => new Response(`no such page ${url}`, { status: 404 }) },
  { name: 'HTTP 429', respond: () => new Response('', { status: 429, headers: { 'retry-after': '5' } }) },
  {
    name: 'HTTP 500 quoting the request',
    respond: (url, init) => new Response(`error handling ${url} ${text(init)}`, { status: 500 }),
  },
  {
    name: 'a redirect to the same address elsewhere',
    respond: (url) =>
      new Response('', { status: 302, headers: { location: url.replace('api.example.org', 'evil.example') } }),
  },
  {
    name: 'a redirect that repeats the address',
    respond: (url) => new Response('', { status: 301, headers: { location: `${url}&again=1` } }),
  },
  {
    name: 'a network error that quotes the address',
    respond: (url, init) => {
      throw Object.assign(new TypeError(`fetch failed: getaddrinfo ENOTFOUND for ${url} ${text(init)}`), {
        cause: new Error(`connect ECONNREFUSED ${url}`),
      });
    },
  },
  {
    name: 'an abort that quotes the address',
    respond: (url) => {
      throw Object.assign(new Error(`The operation was aborted: ${url}`), { name: 'AbortError' });
    },
  },
  {
    name: 'a timeout that quotes the address',
    respond: (url) => {
      throw Object.assign(new Error(`timed out fetching ${url}`), { name: 'TimeoutError' });
    },
  },
  { name: 'a body too large', respond: () => new Response('x'.repeat(5000), { status: 200 }) },
  {
    name: 'a body that is not what was asked for',
    respond: (url) => new Response(`<html>${url}</html>`, { status: 200 }),
  },
];

/** Everything an error carries, down its causes. */
function everything(error: unknown, depth = 0): string {
  if (depth > 5 || error === null || error === undefined) return '';
  if (typeof error !== 'object') return String(error);
  const e = error as Record<string, unknown> & { message?: unknown; stack?: unknown; cause?: unknown };
  let own = `${String(e.message ?? '')} ${String(e.stack ?? '')} `;
  try {
    own += JSON.stringify(
      error,
      Object.getOwnPropertyNames(error).filter((k) => k !== 'cause'),
    );
  } catch {
    /* an error that cannot be written out has nothing more to show */
  }
  if (error instanceof ProviderError) own += ` ${JSON.stringify(error.toInfo('2026-11-20T00:00:00.000Z'))}`;
  return `${own} ${everything(e.cause, depth + 1)}`;
}

test('the key a request carries is in no error and no log line, wherever it was put and whatever went wrong', async () => {
  let sent = 0;
  for (const mode of MODES)
    for (const outcome of OUTCOMES) {
      const sink = new RingBufferSink(500);
      const hub = new LoggerHub({ level: 'debug', sinks: [sink], now: () => 0 });
      let carried = false;
      const client = new HttpClient({
        allowedHosts: ['api.example.org'],
        clock: new VirtualClock(Date.parse('2026-11-20T00:00:00Z')),
        logger: hub.logger('provider', { providerId: 'x' }),
        maxRetries: 1,
        sleep: noSleep,
        credentials: { get: async () => SECRET },
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (`${url} ${text(init ?? {})}`.includes(SECRET)) carried = true;
          return outcome.respond(url, init ?? {});
        }) as typeof fetch,
      });
      const where = `${mode.name}, ${outcome.name}`;
      let said = '';
      try {
        const response = await client.request({
          url: mode.url,
          credential: mode.credential,
          ...(mode.method ? { method: mode.method } : {}),
          ...(mode.body ? { body: mode.body } : {}),
          maxBytes: 2000,
        });
        // What a source is handed back about the request itself (the body is the service's own words).
        said = `${response.status} ${JSON.stringify({ ...response, headers: undefined })}`;
      } catch (error) {
        assert.ok(error instanceof ProviderError, `${where}: threw ${String(error)}`);
        said = everything(error);
      }
      assert.ok(carried, `${where}: the request did carry the key`);
      sent++;
      assert.ok(!said.includes(SECRET), `${where}: the key is in what the source was given: ${said.slice(0, 400)}`);
      const logged = JSON.stringify(sink.records);
      assert.ok(!logged.includes(SECRET), `${where}: the key is in the log: ${logged.slice(0, 400)}`);
    }
  assert.equal(sent, MODES.length * OUTCOMES.length);
});
