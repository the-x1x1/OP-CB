import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuiltinGazetteer } from './builtin-gazetteer.js';
import { parseSearch } from './parse-search.js';
import { T0 } from './test-fixtures.js';

/**
 * A property of the search box: whatever is typed, parsing gives an answer — it does not
 * throw, does not take long, and what it gives is well formed (a place on the globe, a time
 * range that runs forward, a region with finite numbers). Text is generated from a fixed seed
 * out of the words the grammar knows, numbers, punctuation and junk.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'aircraft',
  'planes',
  'ships',
  'vessels',
  'earthquakes',
  'quakes',
  'fires',
  'satellites',
  'storms',
  'cameras',
  'alerts',
  'iss',
  'near',
  'in',
  'within',
  'around',
  'over',
  'above',
  'below',
  'between',
  'and',
  'or',
  'not',
  'from',
  'to',
  'at',
  'of',
  'the',
  'last',
  'past',
  'next',
  'since',
  'before',
  'after',
  'today',
  'yesterday',
  'tomorrow',
  'now',
  'ago',
  'hours',
  'hour',
  'days',
  'day',
  'minutes',
  'week',
  'month',
  'year',
  'honolulu',
  'hawaii',
  'tokyo',
  'japan',
  'hnl',
  'phnl',
  'london',
  'pacific',
  'km',
  'mi',
  'nm',
  'm',
  'ft',
  'kt',
  'magnitude',
  'mag',
  'altitude',
  'speed',
  'callsign',
  'military',
  'fly',
  'go',
  'take',
  'me',
  'zoom',
  'show',
  'hide',
  'where',
  'is',
  'what',
  'changed',
  'constructor',
  'toString',
  '__proto__',
  'hasOwnProperty',
  'valueOf',
  'prototype',
  '>',
  '<',
  '>=',
  '<=',
  '=',
  '!=',
  ':',
  ',',
  ';',
  '-',
  '+',
  '/',
  '(',
  ')',
  '"',
  "'",
  '°',
  '′',
  '″',
  'N',
  'S',
  'E',
  'W',
  '0',
  '1',
  '5',
  '24',
  '90',
  '180',
  '-180',
  '360',
  '1e9',
  '1e999',
  '-0',
  '0x10',
  '21.3',
  '-157.9',
  '999999999999999999999',
  '.5',
  '5.',
  '٣',
  '１２',
];
const JUNK = [
  '\t',
  '\n',
  '\u0000',
  '\u200B',
  '\u202E',
  '🌋',
  'é',
  'ñ',
  '東京',
  '%',
  '\\',
  '{',
  '}',
  '[',
  ']',
  '*',
  '?',
  '|',
  '^',
  '$',
  '.',
];

function makeText(next: () => number): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const n = 1 + Math.floor(next() * 12);
  let out = '';
  for (let i = 0; i < n; i++) {
    const roll = next();
    out +=
      roll < 0.75
        ? pick(WORDS)
        : roll < 0.85
          ? pick(JUNK)
          : roll < 0.95
            ? String((next() * 2 - 1) * 10 ** Math.floor(next() * 6))
            : pick(WORDS).repeat(1 + Math.floor(next() * 4));
    out += next() < 0.8 ? ' ' : '';
  }
  return out;
}

const finite = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n);

function problems(text: string, parsed: ReturnType<typeof parseSearch>): string[] {
  const out: string[] = [];
  if (typeof parsed.text !== 'string' || !Array.isArray(parsed.intents) || !Array.isArray(parsed.notes))
    return ['not a parsed search'];
  for (const note of parsed.notes) if (typeof note !== 'string') out.push('a note that is not text');
  for (const intent of parsed.intents) {
    if (typeof intent.title !== 'string') out.push(`${intent.kind}: no title`);
    const p = intent.place?.position;
    if (p && !(finite(p.latitude) && finite(p.longitude) && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180))
      out.push(`place off the globe ${JSON.stringify(p)}`);
    const walk = (v: unknown, path: string, depth: number): void => {
      if (depth > 8 || v === null || v === undefined) return;
      if (typeof v === 'number' && !Number.isFinite(v)) out.push(`${path} is ${v}`);
      else if (typeof v === 'function') out.push(`${path} is a function`);
      else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, depth + 1);
    };
    walk(intent, intent.kind, 0);
    const time = (intent as { query?: { time?: { start?: string; end?: string } } }).query?.time;
    if (time?.start !== undefined && time.end !== undefined) {
      const a = Date.parse(time.start),
        b = Date.parse(time.end);
      if (!finite(a) || !finite(b)) out.push(`a time that is not one: ${JSON.stringify(time)}`);
      else if (a > b) out.push(`a time range that runs backwards: ${JSON.stringify(time)}`);
    }
  }
  return out.map((p) => `${JSON.stringify(text)}: ${p}`);
}

test('parseSearch: generated text never throws, never stalls, and never gives a malformed answer', () => {
  const ctx = { gazetteer: new BuiltinGazetteer(), now: () => T0 };
  const next = rng(20261120);
  const found: string[] = [];
  let slowest = { ms: 0, text: '' };
  let withIntents = 0;
  for (let i = 0; i < 4000; i++) {
    const text = makeText(next);
    const started = performance.now();
    let parsed: ReturnType<typeof parseSearch>;
    try {
      parsed = parseSearch(text, ctx);
    } catch (err) {
      found.push(`${JSON.stringify(text)}: threw ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
      continue;
    }
    const ms = performance.now() - started;
    if (ms > slowest.ms) slowest = { ms, text };
    if (parsed.intents.length) withIntents++;
    found.push(...problems(text, parsed));
  }
  assert.deepEqual(found.slice(0, 15), [], `${found.length} problems`);
  assert.ok(slowest.ms < 250, `${Math.round(slowest.ms)} ms for ${JSON.stringify(slowest.text)}`);
  assert.ok(
    withIntents > 1000,
    `${withIntents} of 4000 gave an intent: the generator is saying things the grammar reads`,
  );
});

/** The longest text the search is given: the handler cuts it there, and the IPC schema refuses more. */
const MAX_SEARCH_TEXT = 500;

test('parseSearch: the longest text it is ever given, of any one thing repeated, is read at once', () => {
  const ctx = { gazetteer: new BuiltinGazetteer(), now: () => T0 };
  const units = [
    'near ',
    'last 5 ',
    '21.3,',
    'a',
    ' ',
    '-',
    '\u00B0',
    'aircraft and ',
    '> 5 ',
    '"',
    'fly to ',
    'honolulu ',
    'in hawaii ',
    'between 1 and ',
    '5 km of ',
    'constructor ',
  ];
  parseSearch('warm up', ctx);
  for (const unit of units) {
    const text = unit.repeat(Math.ceil(MAX_SEARCH_TEXT / unit.length)).slice(0, MAX_SEARCH_TEXT);
    const started = performance.now();
    const parsed = parseSearch(text, ctx);
    const ms = performance.now() - started;
    assert.ok(Array.isArray(parsed.intents));
    assert.ok(ms < 200, `${JSON.stringify(unit)} repeated to ${MAX_SEARCH_TEXT} characters took ${Math.round(ms)} ms`);
  }
});
