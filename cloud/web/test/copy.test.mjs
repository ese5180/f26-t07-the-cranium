/**
 * The copy rules of the redesign, read from the sources: every page's lede (the line under its title) is one short
 * sentence of at most 15 words, on the console and on the customer site, and what used to follow it is in the page's
 * "How … works". app.test.mjs checks the same of the pages as drawn, and that the pages people use name no script,
 * key path or AWS service outside a Details; this file covers the pages whose scripts that harness does not load.
 * It also holds Help to those rules: the apps' apps/shared/help.json and the customer site's Help page.
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

// Help: apps/shared/help.json, which the iPhone and Android apps show, and the customer site's Help page.
const HELP_FILE = new URL('../../../apps/shared/help.json', import.meta.url);
/** What a page may name only under Details or on a Developer page: a file, a script, a cloud service, an ID. */
const HELP_INTERNALS =
  /deploy\.sh|DynamoDB|Cognito|~\/|scripts\/|\bAWS\b|\bS3\b|CustomerDomainName|\.(?:sh|py|bin|md|mjs|js|kt|swift)\b|\/dev\/|\/api\/|-D\w|\b[a-z]+_[a-z_]+\b|MCUboot|SHA-256|ECDSA|\b403\b/;
const sentences = (text) => text.split(/[.?!](?:\s|$)/).filter((part) => part.trim()).length;
/** Every piece of words a topic shows, each with where it is. */
const helpWords = (topic) => [
  [`${topic.id} title`, topic.title],
  [`${topic.id} summary`, topic.summary],
  ...topic.blocks.flatMap((block, index) => {
    const where = `${topic.id} block ${index}`;
    if (block.rows)
      return block.rows.flatMap(([label, text]) => [
        [where, label],
        [where, text],
      ]);
    for (const kind of ['steps', 'list']) if (block[kind]) return block[kind].map((item) => [where, item]);
    for (const kind of ['heading', 'text', 'note']) if (block[kind]) return [[where, block[kind]]];
    return [];
  }),
];

test('Help in the apps names no file, script, cloud service or ID outside its Developer section, in short answers', () => {
  const book = JSON.parse(readFileSync(HELP_FILE, 'utf8'));
  const developer = new Set(book.sections.find((section) => section.title === 'Developer').topics);
  // The topics that are about scripts and cables are there, and only those.
  assert.deepEqual([...developer].sort(), ['api-tokens', 'keep-the-app', 'resend-wifi', 'serial-console']);
  const named = [];
  const long = [];
  for (const topic of book.topics.filter((each) => !developer.has(each.id))) {
    for (const [where, text] of helpWords(topic)) {
      const found = text.match(HELP_INTERNALS);
      if (found) named.push(`${where}: "${found[0]}" in "${text}"`);
      if (sentences(text) > 3) long.push(`${where}: "${text}"`);
    }
  }
  assert.deepEqual(named, []);
  assert.deepEqual(long, []);
});

test("Help says a board's state in the same words as the pages", () => {
  const book = JSON.parse(readFileSync(HELP_FILE, 'utf8'));
  const rows = Object.fromEntries(
    book.topics.find((topic) => topic.id === 'board-states').blocks.find((block) => block.rows).rows
  );
  const views = readFileSync(new URL('views.js', SITE), 'utf8');
  const neverReported = views.match(/const NEVER_REPORTED = '([^']+)'/)[1];
  assert.equal(rows['Never connected'], neverReported);
  for (const state of ['Online', 'Offline', 'On trial', 'Confirmed', 'Rolled back']) {
    assert.ok(rows[state], `the row of ${state}`);
  }
  assert.match(views, /'Never connected'/);
  // The Wi-Fi update's steps begin with the names the console gives them (core.js STEPS).
  const core = readFileSync(new URL('core.js', SITE), 'utf8');
  const steps = book.topics.find((topic) => topic.id === 'wifi-update').blocks.find((block) => block.steps).steps;
  for (const step of steps) assert.match(core, new RegExp(String.raw`name: '${step.split(':')[0]}'`), step);
  const offline = book.topics.find((topic) => topic.id === 'trouble-offline').blocks.find((block) => block.list).list;
  const help = views.match(/const NEVER_REPORTED_HELP = '([^']+)'/)[1];
  assert.ok(
    offline.some((item) => item.includes(help.replace(/^Power/, 'power'))),
    `"${help}" in the offline topic`
  );
});

test("the customer site's Help answers in short plain words, and a board's state as its page says it", () => {
  const views = readFileSync(new URL('customer-views.js', CUSTOMER), 'utf8');
  const help = views.slice(views.indexOf('const HELP = ['), views.indexOf('export function helpView'));
  const answers = [...help.matchAll(new RegExp(STRINGS, 'g'))].map((match) => words(match[0]).join(' '));
  assert.ok(answers.length >= 20, `${answers.length} questions and answers`);
  for (const text of answers) {
    assert.doesNotMatch(text, HELP_INTERNALS);
    assert.ok(sentences(text) <= 3, `"${text}"`);
  }
  const core = readFileSync(new URL('customer-core.js', CUSTOMER), 'utf8');
  const label = core.match(/new: \{[^}]*label: '([^']+)'/)[1];
  const text = core.match(/new: '([^']+)'/)[1];
  assert.ok(answers.includes(`My board shows ${label}.`), label);
  assert.ok(answers.includes(text), text);
});

test('Help keeps the facts people act on, in plain words', () => {
  const book = JSON.parse(readFileSync(HELP_FILE, 'utf8'));
  const said = (id) =>
    helpWords(book.topics.find((topic) => topic.id === id))
      .map(([, text]) => text)
      .join(' ');
  for (const [id, fact] of [
    // Who starts a deployment on their own, and what is not listed.
    [
      'deployments',
      /firmware 1\.7\.2 or newer starts a deployment on its own\. Older firmware waits for someone to press Button 1/,
    ],
    ['deployments', /started outside the console is not listed here; its board's page shows it/],
    // What revoking does.
    ['board-states', /open deployments are cancelled, and boards refuse it/],
    ['board-states', /restarting stays online for 240 s/],
    ['board-states', /2 minutes, 5 minutes, 30 minutes and 2 hours/],
    // Bluetooth: no send without the console, and an image nobody installs is erased.
    ['bluetooth-update', /Without the console's yes nothing is sent, also when the console cannot be reached/],
    ['bluetooth-update', /with no press it is erased/],
    ['bluetooth-update', /after 120 s/],
    // An offline board: the Wi-Fi network again over USB, and its certificate.
    ['trouble-offline', /Wi-Fi network again, connect it by USB/],
    ['trouble-offline', /its certificate must be attached to it\. Its page lists its certificates/],
    ['resend-wifi', /python tools\/provision_device\.py --wifi/],
    // What a board's page shows.
    ['boards-and-diagnostics', /Excellent from −55 dBm, Good from −67, Fair from −75/],
    ['boards-and-diagnostics', /From firmware 1\.11\.4 a board shows its own device ID, with its thing name under it/],
  ]) {
    assert.match(said(id), fact, id);
  }
});
