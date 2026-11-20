import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultConnectorRegistry } from '@opcb/connector-runtime';
import { repoRoot, settle, startRuntime, tableFetch } from '../helpers/harness.js';

/**
 * Exports of objects whose names a source wrote: markup, the end of a CDATA section, quotes
 * and commas and line breaks, a formula, control characters, text in other scripts. What is
 * written must be a file of its kind that another program opens: XML that is well formed,
 * JSON that parses, a table with one row an object and a formula that stays text.
 */
const NAMES = [
  'Harbour',
  '<b>bold</b> & <script>alert(1)</script>',
  ']]><Placemark><name>injected</name></Placemark><![CDATA[',
  '</name></Placemark></Document></kml>',
  'quote " comma , semicolon ; tab \t',
  'line\nbreak\r\nand another',
  '=HYPERLINK("http://evil.example","x")',
  '+1+1',
  '-2',
  '@SUM(A1)',
  'null\u0000byte and \u0007 bell and \u001b escape',
  '\u202eright-to-left',
  '北駅 🚲 naïve',
  '&amp; &lt; &#x0; &bogus;',
  'x'.repeat(250),
];

/** Well-formed enough for any XML reader: tags balance, no stray < or &, no forbidden characters. */
function xmlProblem(xml: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- the characters XML 1.0 forbids
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(xml)) return 'a character XML forbids';
  const stack: string[] = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const text = xml.slice(i, lt < 0 ? xml.length : lt);
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text))
      return `a bare & in ${JSON.stringify(text.slice(0, 60))}`;
    if (text.includes(']]>')) return 'a CDATA end in text';
    if (lt < 0) break;
    if (xml.startsWith('<?', lt)) i = xml.indexOf('?>', lt) + 2;
    else if (xml.startsWith('<!--', lt)) i = xml.indexOf('-->', lt) + 3;
    else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      if (end < 0) return 'an unclosed CDATA section';
      i = end + 3;
    } else {
      const gt = xml.indexOf('>', lt);
      if (gt < 0) return 'an unclosed tag';
      const tag = xml.slice(lt + 1, gt);
      if (tag.includes('<')) return `a < inside a tag: ${tag.slice(0, 60)}`;
      if (tag.startsWith('/')) {
        const open = stack.pop();
        if (open !== tag.slice(1).trim()) return `</${tag.slice(1)}> closes <${open}>`;
      } else if (!tag.endsWith('/')) {
        const name = /^[A-Za-z_][\w:.-]*/.exec(tag)?.[0];
        if (!name) return `not a tag: <${tag.slice(0, 40)}>`;
        stack.push(name);
      }
      i = gt + 1;
    }
    if (i <= 0) return 'an unclosed construct';
  }
  return stack.length ? `<${stack.join('><')}> left open` : undefined;
}

/** A CSV file's records, by the usual rules (quotes doubled, line breaks inside quotes). */
function csvRecords(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

test('integration: objects with hostile names export as well-formed KML, GeoJSON, JSON and CSV', async () => {
  const example = JSON.parse(
    readFileSync(path.join(repoRoot, 'connectors', 'examples', 'citibike-stations-rest.json'), 'utf8'),
  ) as Record<string, unknown>;
  const checked = defaultConnectorRegistry.validate({
    ...example,
    id: 'hostile',
    review: 'bundled',
    enabled: true,
    dataPolicy: { ...(example['dataPolicy'] as object | undefined), exportAllowed: true },
  });
  assert.ok(checked.ok && checked.definition, JSON.stringify(checked));
  const stations = NAMES.map((name, i) => ({
    station_id: `s${i}`,
    name,
    short_name: name,
    lat: 40.7 + i * 0.001,
    lon: -74 - i * 0.001,
    capacity: i,
    region_id: '71',
  }));
  const { impl: fetchImpl } = tableFetch({
    'https://gbfs.citibikenyc.com/': () =>
      new Response(JSON.stringify({ data: { stations } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  const h = await startRuntime({
    fetchImpl,
    providerInstances: [defaultConnectorRegistry.createProvider(checked.definition)],
  });
  try {
    await h.client.request('sources.refresh', { providerId: 'hostile' });
    await settle(8);
    const found = await h.client.request('world.query', { objectTypes: ['infrastructure'] });
    assert.equal(found.items.length, NAMES.length);

    const written: Record<string, string> = {};
    for (const format of ['kml', 'geojson', 'json', 'csv'] as const) {
      const file = path.join(h.dataDir, `out.${format}`);
      h.host.saveQueue.push(file);
      const result = await h.client.request('export.objects', { query: { objectTypes: ['infrastructure'] }, format });
      assert.ok('path' in result, `${format}: ${JSON.stringify(result)}`);
      assert.deepEqual(result.skippedProviders, [], `${format}: nothing held back`);
      written[format] = await fs.readFile(file, 'utf8');
    }

    assert.equal(xmlProblem(written['kml']!), undefined, `KML: ${xmlProblem(written['kml']!)}`);
    assert.equal(
      (written['kml']!.match(/<Placemark[\s>]/g) ?? []).length,
      NAMES.length,
      'one placemark an object, none injected',
    );
    assert.ok(!/<script|<b>|<name>injected<\/name>/.test(written['kml']!.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')));

    const geojson = JSON.parse(written['geojson']!) as {
      type: string;
      features: Array<{ geometry: unknown; properties: unknown }>;
    };
    assert.equal(geojson.type, 'FeatureCollection');
    assert.equal(geojson.features.length, NAMES.length);
    assert.equal((JSON.parse(written['json']!) as unknown[] | { items: unknown[] }) !== null, true);

    const rows = csvRecords(written['csv']!.replace(/^\ufeff/, ''));
    assert.equal(rows.length, NAMES.length + 1, 'a header and one record an object, whatever line breaks a name holds');
    const width = rows[0]!.length;
    assert.ok(
      rows.every((r) => r.length === width),
      'every record has the header’s number of cells',
    );
    for (const r of rows.slice(1))
      for (const cell of r)
        assert.ok(
          !/^[=+@]/.test(cell) && !/^-\D/.test(cell),
          `a cell a spreadsheet would run: ${JSON.stringify(cell.slice(0, 40))}`,
        );
  } finally {
    await h.dispose();
  }
});
