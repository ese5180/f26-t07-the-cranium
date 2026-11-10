/**
 * The copy rules of the redesign, read from the sources: every page's lede (the line under its title) is one short
 * sentence of at most 15 words, on the console and on the customer site, and what used to follow it is in the page's
 * "How … works". app.test.mjs checks the same of the pages as drawn, and that the pages people use name no script,
 * key path or AWS service outside a Details; this file covers the pages whose scripts that harness does not load.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const SITE = new URL('../src/site/assets/', import.meta.url);
const CUSTOMER = new URL('../src/customer/assets/', import.meta.url);
const LIMIT = 15;

const sources = (folder) =>
  readdirSync(folder)
    .filter((name) => name.endsWith('.js') && !/leaflet|qrcode|photos/.test(name))
    .map((name) => ({ name, text: readFileSync(new URL(name, folder), 'utf8') }));

/** A run of string literals joined with +, as the words read: '…' + '…'. */
const STRINGS = String.raw`'(?:[^'\\]|\\.)*'(?:\s*\+\s*'(?:[^'\\]|\\.)*')*`;
const words = (literal) =>
  [...literal.matchAll(/'((?:[^'\\]|\\.)*)'/g)]
    .map((match) => match[1].replace(/\\'/g, "'"))
    .join('')
    .split(/\s+/)
    .filter(Boolean);

/** Every lede written as words: `lede: '…'`, and `lede: NAME` for a `const NAME = '…'` of the same file. */
function ledesOf({ name, text }) {
  const found = [];
  for (const match of text.matchAll(new RegExp(String.raw`\blede:\s*(${STRINGS})`, 'g'))) {
    found.push({ where: name, words: words(match[1]) });
  }
  for (const match of text.matchAll(/\blede:\s*([A-Z][A-Z_]+)\b/g)) {
    const constant = text.match(new RegExp(String.raw`const ${match[1]} =\s*(${STRINGS})`));
    if (constant) found.push({ where: `${name} ${match[1]}`, words: words(constant[1]) });
  }
  return found;
}

test("every page's lede on the console is one sentence of at most 15 words", () => {
  const ledes = sources(SITE).flatMap(ledesOf);
  // Overview, Devices, Firmware, Board setup, Serial, Map, Reports, Apps, Team, Customers, Memfault and more.
  assert.ok(ledes.length >= 15, `${ledes.length} ledes found`);
  for (const lede of ledes) {
    assert.ok(lede.words.length <= LIMIT, `${lede.where}: "${lede.words.join(' ')}" is ${lede.words.length} words`);
    const text = lede.words.join(' ');
    // One sentence: no full stop before the end.
    assert.doesNotMatch(text.replace(/\.$/, ''), /\.\s/, `${lede.where}: "${text}" is one sentence`);
  }
});

test("every page's lede on the customer site, and each Mixes tab's line, is at most 15 words", () => {
  const core = readFileSync(new URL('customer-core.js', CUSTOMER), 'utf8');
  const constant = (name) => words(core.match(new RegExp(String.raw`export const ${name} = (${STRINGS})`))[1]);
  // The Overview's lede is a greeting, "Hello, <name>." or "Welcome back.", and then MIXES_LEDE.
  assert.ok(constant('MIXES_LEDE').length + 2 <= LIMIT, 'Hello, Ada. + MIXES_LEDE');
  assert.ok(constant('WELCOME').length + constant('MIXES_LEDE').length <= LIMIT);
  const views = readFileSync(new URL('customer-views.js', CUSTOMER), 'utf8');
  const mixWords = views.slice(views.indexOf('const MIX_WORDS'), views.indexOf('const MIX_PAGES'));
  const lines = [...mixWords.matchAll(new RegExp(String.raw`text:\s*(${STRINGS})`, 'g'))].map((match) =>
    words(match[1])
  );
  assert.equal(lines.length, 5, 'one line for each Mixes tab');
  const ledes = [...sources(CUSTOMER).flatMap(ledesOf), ...lines.map((line) => ({ where: 'MIX_WORDS', words: line }))];
  for (const lede of ledes) {
    assert.ok(lede.words.length <= LIMIT, `${lede.where}: "${lede.words.join(' ')}" is ${lede.words.length} words`);
  }
});

test('a page with more to say than its lede says it under "How … works", closed until opened', () => {
  const views = readFileSync(new URL('views.js', SITE), 'utf8');
  assert.match(views, /function howItWorks\(how\)/);
  assert.match(views, /'details',\s*\{ class: 'page-how' \}/);
  const hows = sources(SITE).flatMap(({ name, text }) =>
    [...text.matchAll(/title: '(How [^']+)'/g)].map((match) => `${name}: ${match[1]}`)
  );
  for (const page of [
    'deployments',
    'the activity log',
    'events',
    'board setup',
    'the team',
    'customers',
    'Memfault',
    'tokens',
    'diagnostics',
  ]) {
    assert.ok(
      hows.some((how) => how.includes(`How ${page} work`)),
      `"How ${page} work…" in ${hows.join('; ')}`
    );
  }
});
