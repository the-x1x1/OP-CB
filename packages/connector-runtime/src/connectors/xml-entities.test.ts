import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities as decodeFileEntities } from './files/xml.js';
import { decodeEntities as decodeOgcEntities } from './ogc/xml.js';

for (const [name, decode] of [
  ['files', decodeFileEntities],
  ['ogc', decodeOgcEntities],
] as const) {
  test(`${name} XML: the five named entities and numeric references decode`, () => {
    assert.equal(decode('a &lt; b &amp;&amp; c &gt; d &quot;e&quot; &apos;f&apos;'), 'a < b && c > d "e" \'f\'');
    assert.equal(decode('&#65;&#x42;&#x1F30B;'), 'AB\u{1F30B}');
    assert.equal(decode('no entities'), 'no entities');
    assert.equal(decode(''), '');
    // Decoded once: the text "&lt;" written as &amp;lt; stays "&lt;".
    assert.equal(decode('&amp;lt;'), '&lt;');
  });

  test(`${name} XML: what is not an entity is left exactly as written`, () => {
    for (const text of [
      '&unknown;',
      '&constructor;',
      '&toString;',
      '&valueOf;',
      '&nbsp;',
      'AT&T',
      '&;',
      '&#;',
      '&#x;',
      '&#xD800;',
      '&#0;',
      '&#99999999;',
      '&#x110000;',
    ])
      assert.equal(decode(text), text, text);
  });
}
