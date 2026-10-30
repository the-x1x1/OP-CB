import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '@worldview/config';
import type { AppSettings } from '@worldview/ipc-contract';
import { LocalServices, libraryPath, readKiwixCatalog, readKiwixSearch, readOllamaGenerate } from './local-services.js';

/*
 * The answers below are copied from each project's own documentation and tests (read
 * 2026-10-30), not recorded from a running copy:
 *  - Ollama: docs/api.md ("List Local Models", "Version", "Request (No streaming)").
 *  - kiwix-serve: libkiwix test/library_server.cpp (catalog entries) and test/server_search.cpp
 *    (search results as XML), trimmed to one entry / item each.
 *  - Kolibri: kolibri/core/device/utils.py get_device_info (the keys it returns).
 */
const OLLAMA_TAGS = {
  models: [
    {
      name: 'llama3.2:latest',
      model: 'llama3.2:latest',
      modified_at: '2025-05-04T17:37:44.706015396-07:00',
      size: 2019393189,
      digest: 'a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72',
      details: {
        parent_model: '',
        format: 'gguf',
        family: 'llama',
        families: ['llama'],
        parameter_size: '3.2B',
        quantization_level: 'Q4_K_M',
      },
    },
  ],
};
const OLLAMA_GENERATE = {
  model: 'llama3.2',
  created_at: '2023-08-04T19:22:45.499127Z',
  response: 'The sky is blue because it is the color of the sky.',
  done: true,
  context: [1, 2, 3],
  total_duration: 5043500667,
  load_duration: 5025959,
  prompt_eval_count: 26,
  prompt_eval_duration: 325953000,
  eval_count: 290,
  eval_duration: 4709213000,
};
const KIWIX_CATALOG = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:dc="http://purl.org/dc/terms/"
      xmlns:opds="https://specs.opds.io/opds-1.2">
  <id>12345678-90ab-cdef-1234-567890abcdef</id>
  <title>All zims</title>
  <entry>
    <id>urn:uuid:6f1d19d0-633f-087b-fb55-7ac324ff9baf</id>
    <title>Ray Charles</title>
    <updated>YYYY-MM-DDThh:mm:ssZ</updated>
    <summary>Wikipedia articles about Ray Charles</summary>
    <language>eng</language>
    <name>wikipedia_en_ray_charles</name>
    <flavour></flavour>
    <category>wikipedia</category>
    <tags>public_tag_without_a_value;_private_tag_without_a_value;wikipedia;_category:wikipedia;_pictures:no;_videos:no;_details:no</tags>
    <articleCount>284</articleCount>
    <mediaCount>2</mediaCount>
    <link type="text/html" href="/content/zimfile" />
    <author>
      <name>Wikipedia</name>
    </author>
    <publisher>
      <name>Kiwix</name>
    </publisher>
    <dc:issued>2020-03-31T00:00:00Z</dc:issued>
  </entry>
</feed>`;
const KIWIX_SEARCH = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
     xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Search: ray charles</title>
    <opensearch:totalResults>1</opensearch:totalResults>
    <item>
      <title>Ray Charles</title>
      <link>/content/zimfile/A/Ray_Charles</link>
        <description>...<b>Ray</b> <b>Charles</b> was an American singer...</description>
        <book>
          <title>Ray Charles</title>
        </book>
        <wordCount>2915</wordCount>
    </item>
    <item>
      <title>Elsewhere</title>
      <link>https://example.com/A/x</link>
    </item>
  </channel>
</rss>`;
const KOLIBRI_INFO = {
  application: 'kolibri',
  kolibri_version: '0.17.0',
  instance_id: '0123456789abcdef0123456789abcdef',
  device_name: 'field-laptop',
  operating_system: 'Linux',
};

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function harness(routes: Record<string, Route>, settings: Partial<AppSettings> = {}) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    asked.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname}`);
    const route = routes[`${url.host}${url.pathname}`];
    if (!route) throw new TypeError('fetch failed: connect ECONNREFUSED');
    return route(url, init);
  }) as typeof fetch;
  const services = new LocalServices({
    fetchImpl,
    settings: () => ({ ...DEFAULT_SETTINGS, ...settings }) as AppSettings,
    now: () => Date.parse('2026-10-30T09:00:00.000Z'),
  });
  return { services, asked };
}

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });

test('local services: each found running on its loopback port, with what it lists', async () => {
  const { services, asked } = harness(
    {
      '127.0.0.1:11434/api/version': () => json({ version: '0.5.1' }),
      '127.0.0.1:11434/api/tags': () => json(OLLAMA_TAGS),
      '127.0.0.1:8080/catalog/v2/entries': () => new Response(KIWIX_CATALOG),
      '127.0.0.1:8081/api/public/info/': () => json(KOLIBRI_INFO),
    },
    { services: { ports: { kolibri: 8081 } } },
  );
  const [ollama, kiwix, kolibri] = await services.statusAll();
  assert.equal(ollama!.state, 'running');
  assert.equal(ollama!.version, '0.5.1');
  assert.deepEqual(ollama!.models, [
    { name: 'llama3.2:latest', sizeBytes: 2019393189, parameterSize: '3.2B', family: 'llama' },
  ]);
  assert.equal(ollama!.detail, '1 model installed');
  assert.equal(kiwix!.state, 'running');
  assert.deepEqual(kiwix!.books, [
    {
      id: '6f1d19d0-633f-087b-fb55-7ac324ff9baf',
      title: 'Ray Charles',
      name: 'wikipedia_en_ray_charles',
      language: 'eng',
    },
  ]);
  assert.equal(kolibri!.state, 'running');
  assert.equal(kolibri!.version, '0.17.0');
  assert.equal(kolibri!.endpoint, 'http://127.0.0.1:8081');
  assert.ok(
    asked.every((a) => a.includes('127.0.0.1:')),
    'only loopback is asked',
  );
});

test('local services: nothing on the port, something else on it, and an error are told apart', async () => {
  const { services } = harness({
    '127.0.0.1:11434/api/version': () => new Response('<html>a router page</html>'),
    '127.0.0.1:8080/catalog/v2/entries': () => new Response('nope', { status: 500 }),
  });
  const [ollama, kiwix, kolibri] = await services.statusAll();
  assert.equal(ollama!.state, 'other');
  assert.equal(kiwix!.state, 'error');
  assert.equal(kiwix!.detail, 'answered 500');
  assert.equal(kolibri!.state, 'not-found');
  // Kolibri's port is kiwix's by default: the kiwix server's catalogue is not Kolibri.
  const both = harness({ '127.0.0.1:8080/api/public/info/': () => json({ application: 'other' }) });
  assert.equal((await both.services.status('kolibri')).state, 'other');
});

test('ai test: the model answers alone, labelled not grounded, with its speed', async () => {
  let sent: unknown;
  const { services } = harness({
    '127.0.0.1:11434/api/generate': async (_u, init) => {
      sent = JSON.parse(String(init?.body));
      return json(OLLAMA_GENERATE);
    },
  });
  const answer = await services.aiTest({ model: 'llama3.2', prompt: 'Why is the sky blue?' });
  assert.equal(answer.ok, true);
  assert.equal(answer.grounded, false);
  assert.equal(answer.text, OLLAMA_GENERATE.response);
  assert.equal(answer.tokensPerSecond, 61.6);
  assert.deepEqual(sent, { model: 'llama3.2', prompt: 'Why is the sky blue?', stream: false });
  const missing = harness({ '127.0.0.1:11434/api/generate': () => new Response('{}', { status: 404 }) });
  const no = await missing.services.aiTest({ model: 'nope', prompt: 'x' });
  assert.equal(no.ok, false);
  assert.match(no.message ?? '', /no model called nope/);
  const down = await harness({}).services.aiTest({ model: 'llama3.2', prompt: 'x' });
  assert.equal(down.ok, false);
  assert.match(down.message ?? '', /did not answer/);
});

test('library search: hits with their pages; a link off the server is dropped', async () => {
  let query: URLSearchParams | undefined;
  const { services } = harness({
    '127.0.0.1:8080/search': (u) => {
      query = u.searchParams;
      return new Response(KIWIX_SEARCH);
    },
  });
  const answer = await services.librarySearch('wikipedia_en_ray_charles', 'ray charles');
  assert.equal(answer.ok, true);
  assert.equal(query?.get('format'), 'xml');
  assert.equal(query?.get('books.name'), 'wikipedia_en_ray_charles');
  assert.deepEqual(answer.hits, [
    {
      title: 'Ray Charles',
      path: '/content/zimfile/A/Ray_Charles',
      snippet: '...Ray Charles was an American singer...',
      book: 'Ray Charles',
    },
  ]);
});

test('readers refuse what is not the service', () => {
  assert.throws(() => readKiwixCatalog('<html></html>'));
  assert.throws(() => readKiwixSearch('<feed></feed>'));
  assert.throws(() => readOllamaGenerate({ done: true }));
  assert.equal(libraryPath('/content/wiki/A/Foo'), '/content/wiki/A/Foo');
  assert.equal(libraryPath('/root/content/wiki/A/Foo'), '/content/wiki/A/Foo');
  for (const bad of [
    'https://evil/content/x',
    '//evil/content/x',
    '/content/../../etc/passwd',
    '/content/%2e%2e/x',
    '/other/x',
  ])
    assert.equal(libraryPath(bad), undefined, bad);
});
