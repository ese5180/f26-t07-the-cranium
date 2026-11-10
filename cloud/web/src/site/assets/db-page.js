/**
 * The Database page (docs/database.md), under Developer: the console's three DynamoDB tables (state,
 * audit, events), for release managers. Read only. Through the console's own API
 * (cloud/api/src/handlers/db.mjs), which never sends a secret field: a token's digest, a key, a passphrase
 * or a certificate reads "hidden", for everybody.
 *
 *   #/database          the state table
 *   #/database/<table>  that table: its rough size, a page of items with filters, Load more, and Export
 *
 * A page is read when it is asked for, never by a timer: each read costs DynamoDB a Query of one
 * partition or a Scan of one page. An item opens on this page with all its fields. An export is the
 * filtered items as CSV or JSON, up to the server's cap, and goes on record in the activity log; in an
 * app with the share bridge (file.share) the file goes to the share sheet or a save dialog, on the website
 * it is downloaded.
 *
 * Every answer of the server is checked here before it is drawn. The script is fetched when the page is
 * first opened (app.js), and draws with views.js.
 */

import { ApiError, isThing, plural } from './core.js';
import {
  badge,
  button,
  card,
  developerTabs,
  empty,
  failure,
  freshness,
  h,
  icon,
  loading,
  mono,
  notice,
  pageHead,
} from './views.js';

export const TABLES = ['state', 'audit', 'events'];
export const PAGE = 50;
const MAX_TEXT = 100;

let tools = null;

function resource() {
  return { value: null, error: null, loadedAt: 0, loading: false };
}

// What the page holds: the tables, and for each table its filters and the pages read so far.
const tables = resource();
const views = new Map();
// The item open on the page, if any: { table, key, resource }.
let opened = null;
// An export under way, or the last one's outcome: { busy, error, done }.
const exporting = { busy: false, error: null, done: null };

/** app.js hands over what the page needs: { state, api, load, draw, share }, share null where there is none. */
export function connect(given) {
  tools = given;
}

function viewOf(table) {
  if (!views.has(table)) {
    views.set(table, {
      form: { kind: '', partition: '', board: '', from: '', to: '', text: '' },
      applied: {},
      rows: [],
      read: 0,
      cursor: null,
      reading: null,
      partition: null,
      stopped: false,
      list: resource(),
      more: false,
    });
  }
  return views.get(table);
}

export function tableOf(route) {
  return TABLES.includes(route?.table) ? route.table : 'state';
}

// Reading the server's answers.

const object = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value, max = 200) => (typeof value === 'string' ? value.replace(/[\p{C}]/gu, '').slice(0, max) : '');
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

function unreadable() {
  return new ApiError(0, 'unreadable', 'The server sent a reply the console could not read.');
}

export function readTables(raw) {
  const value = object(raw);
  if (!Array.isArray(value.tables)) throw unreadable();
  return {
    exportLimit: count(value.exportLimit) ?? 0,
    tables: value.tables
      .map(object)
      .filter((one) => TABLES.includes(one.name))
      .map((one) => ({
        name: one.name,
        label: text(one.label, 40) || one.name,
        about: text(one.about, 300),
        items: count(one.items),
        bytes: count(one.bytes),
        kinds: list(one.kinds)
          .map(object)
          .filter((kind) => /^[A-Za-z]{1,16}$/.test(kind.id ?? ''))
          .map((kind) => ({
            id: kind.id,
            label: text(kind.label, 60) || kind.id,
            board: kind.board === true,
            timed: kind.timed === true,
          })),
      })),
  };
}

function readKey(raw) {
  const key = object(raw);
  return typeof key.pk === 'string' && typeof key.sk === 'string' ? { pk: key.pk, sk: key.sk } : null;
}

export function readPage(raw) {
  const value = object(raw);
  if (!Array.isArray(value.rows)) throw unreadable();
  return {
    reading: value.reading === 'query' ? 'query' : 'scan',
    partition: typeof value.partition === 'string' ? value.partition : null,
    rows: value.rows.map(object).map((row) => ({ key: readKey(row.key), item: object(row.item) })),
    read: count(value.read) ?? 0,
    cursor: typeof value.cursor === 'string' && /^[A-Za-z0-9_-]{1,1600}$/.test(value.cursor) ? value.cursor : null,
    stopped: value.stopped === true,
  };
}

export function readExport(raw) {
  const value = object(raw);
  if (typeof value.content !== 'string' || !/^cranium-[a-z]+-\d{8}T\d{6}Z\.(?:csv|json)$/.test(value.name ?? '')) {
    throw unreadable();
  }
  return {
    name: value.name,
    type: value.type === 'application/json' ? 'application/json' : 'text/csv',
    content: value.content,
    count: count(value.count) ?? 0,
    capped: ['items', 'size', 'reads', 'time'].includes(value.capped) ? value.capped : null,
  };
}

// The filters, as the query string of the API.

/** The filters of the form, checked: { query, problem }. Times are the browser's own, sent in UTC. */
export function filtersOf(form) {
  const query = {};
  if (form.kind) query.kind = form.kind;
  if (form.partition.trim()) query.partition = form.partition.trim();
  if (form.board.trim()) {
    if (!isThing(form.board.trim())) return { query, problem: 'A board is named like cranium-0123456789abcdef.' };
    query.board = form.board.trim();
  }
  for (const name of ['from', 'to']) {
    if (!form[name]) continue;
    const ms = Date.parse(form[name]);
    if (!Number.isFinite(ms)) return { query, problem: `The “${name}” time is not one the console can read.` };
    query[name] = new Date(ms).toISOString();
  }
  if (query.from && query.to && !(query.from < query.to)) return { query, problem: '“From” must be before “to”.' };
  if (form.text.trim()) {
    if (form.text.trim().length > MAX_TEXT) return { query, problem: `Look for at most ${MAX_TEXT} characters.` };
    query.text = form.text.trim();
  }
  return { query, problem: null };
}

/** A path of the API with its query, each part encoded as a URI component (a space as %20, never +). */
export function pathOf(table, rest = '', query = {}) {
  const search = Object.entries(query)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&');
  return `/api/db/${table}${rest}${search ? `?${search}` : ''}`;
}

// Loading.

export function databaseResources(state) {
  const table = tableOf(state.route);
  return [tables, viewOf(table).list];
}

function canRead(state) {
  return state.me?.canWrite === true;
}

async function readFirst(table) {
  const view = viewOf(table);
  const answer = readPage(await tools.api.dbRequest(pathOf(table, '', { ...view.applied, limit: String(PAGE) })));
  Object.assign(view, answer, { rows: answer.rows });
  return answer;
}

/** The tables, and the first page of the table on show. A refresh by hand reads that page again. */
export async function refreshDatabase(full) {
  const { state, load } = tools;
  if (!canRead(state)) return;
  const table = tableOf(state.route);
  const view = viewOf(table);
  await Promise.all([
    full || tables.loadedAt === 0
      ? load(tables, async () => readTables(await tools.api.dbRequest('/api/db/tables')))
      : null,
    full || view.list.loadedAt === 0 ? load(view.list, () => readFirst(table)) : null,
  ]);
}

/** Nothing is read again by itself: the page holds still while anything is under way or typed. */
export function holdStill() {
  return exporting.busy || opened !== null || [...views.values()].some((view) => view.more || view.rows.length > PAGE);
}

async function apply(table) {
  const view = viewOf(table);
  const { query, problem } = filtersOf(view.form);
  view.problem = problem;
  if (problem !== null) return tools.draw();
  view.applied = query;
  opened = null;
  exporting.done = null;
  await tools.load(view.list, () => readFirst(table));
  tools.draw();
}

async function more(table) {
  const view = viewOf(table);
  if (view.more || view.cursor === null) return;
  view.more = true;
  tools.draw();
  try {
    const answer = readPage(
      await tools.api.dbRequest(pathOf(table, '', { ...view.applied, limit: String(PAGE), cursor: view.cursor }))
    );
    view.rows = [...view.rows, ...answer.rows];
    view.read += answer.read;
    view.cursor = answer.cursor;
    view.stopped = answer.stopped;
    view.list.error = null;
  } catch (error) {
    view.list.error = error;
  } finally {
    view.more = false;
    tools.draw();
  }
}

async function open(table, key) {
  opened = { table, key, resource: resource() };
  tools.draw();
  await tools.load(opened.resource, async () => {
    const answer = object(await tools.api.dbRequest(pathOf(table, '/item', key)));
    return { key: readKey(answer.key), item: object(answer.item) };
  });
  tools.draw();
}

/** Text as base64, for the share bridge, which takes a file's bytes that way. */
export function base64Of(content) {
  const bytes = new TextEncoder().encode(content);
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

async function exportAs(table, format) {
  if (exporting.busy) return;
  Object.assign(exporting, { busy: format, error: null, done: null });
  tools.draw();
  try {
    const file = readExport(
      await tools.api.dbRequest(pathOf(table, '/export', { ...viewOf(table).applied, format }), { once: true })
    );
    if (tools.share) {
      await tools.share({ name: file.name, type: file.type, data: base64Of(file.content) });
    } else if (tools.inApp) {
      throw new ApiError(0, 'unavailable', 'This app cannot save a file. Export from the website instead.');
    } else {
      const address = URL.createObjectURL(new Blob([file.content], { type: file.type }));
      const link = document.createElement('a');
      link.href = address;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(address), 60_000);
    }
    exporting.done = file;
  } catch (error) {
    // Closing the share sheet is no failure: the export is on record all the same.
    if (error?.code !== 'cancelled') exporting.error = error;
  } finally {
    exporting.busy = false;
    tools.draw();
  }
}

// Drawing.

export function bytesWords(bytes) {
  if (bytes === null) return 'size not known';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The three tables as one group: a row each, its rough size under its name, the one on show marked. */
function tableTabs(current, known) {
  return card(
    { key: 'tables', title: 'Tables' },
    h(
      'ul',
      { class: 'rows db-tables', 'aria-label': 'Tables' },
      TABLES.map((name) => {
        const table = known.find((one) => one.name === name);
        return h(
          'li',
          { key: name, class: 'row db-table' },
          h(
            'div',
            { class: 'row-main' },
            h(
              'a',
              {
                class: 'row-title cover-link',
                href: name === 'state' ? '#/database' : `#/database/${name}`,
                'aria-current': name === current ? 'page' : null,
              },
              table?.label ?? name
            ),
            h(
              'span',
              { class: 'row-note dotted' },
              table
                ? [
                    h(
                      'span',
                      { key: 'items' },
                      `${table.items === null ? '?' : `about ${table.items.toLocaleString('en-US')}`} items`
                    ),
                    h('span', { key: 'bytes' }, bytesWords(table.bytes)),
                  ]
                : null
            )
          ),
          name === current ? badge('good', 'check', 'Shown') : h('span', { class: 'row-chevron' }, icon('arrow-right'))
        );
      })
    )
  );
}

function field(label, input, hint) {
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'field-label' }, label),
    input,
    hint ? h('span', { class: 'field-hint' }, hint) : null
  );
}

function filterForm(table, spec) {
  const view = viewOf(table);
  const { form } = view;
  const input = (name, props = {}) =>
    h('input', {
      class: 'input',
      type: 'text',
      value: form[name],
      autocomplete: 'off',
      spellcheck: 'false',
      ...props,
      onInput: (event) => {
        form[name] = event.target.value;
      },
    });
  return h(
    'form',
    {
      class: 'db-filters',
      key: 'filters',
      novalidate: true,
      onSubmit(event) {
        event.preventDefault();
        apply(table);
      },
    },
    field(
      'Kind',
      h(
        'select',
        {
          class: 'input',
          value: form.kind,
          onChange: (event) => {
            form.kind = event.target.value;
          },
        },
        h('option', { value: '' }, 'Any'),
        (spec?.kinds ?? []).map((kind) => h('option', { key: kind.id, value: kind.id }, kind.label))
      )
    ),
    field('Partition', input('partition', { maxlength: '1024', placeholder: 'pk, exactly' })),
    field('Board', input('board', { maxlength: '24', placeholder: 'cranium-0123456789abcdef' })),
    field('From', input('from', { type: 'datetime-local' })),
    field('To', input('to', { type: 'datetime-local' })),
    field('Text', input('text', { maxlength: String(MAX_TEXT), placeholder: 'in what is shown' })),
    h(
      'div',
      { class: 'button-row db-filter-buttons' },
      h('button', { type: 'submit', class: 'btn is-primary' }, icon('list'), 'Apply'),
      button(
        'is-quiet',
        () => {
          Object.assign(form, { kind: '', partition: '', board: '', from: '', to: '', text: '' });
          apply(table);
        },
        'Clear'
      )
    ),
    view.problem ? notice('warn', 'alert', view.problem) : null
  );
}

/** A value of an item, as text: JSON for a list or a map, "hidden" set apart. */
function valueView(value) {
  if (value === 'hidden')
    return badge('idle', 'lock', 'hidden', 'Never shown: a credential or something as good as one');
  if (value === null) return h('span', { class: 'quiet' }, 'null');
  if (typeof value === 'object') return h('code', { class: 'code db-json' }, JSON.stringify(value, null, 2));
  return mono(String(value));
}

function fields(item) {
  return h(
    'dl',
    { class: 'facts db-fields' },
    Object.keys(item).map((name) =>
      h('div', { class: 'fact', key: name }, h('dt', null, mono(name)), h('dd', null, valueView(item[name])))
    )
  );
}

function summary(item) {
  return Object.entries(item)
    .filter(([name]) => name !== 'pk' && name !== 'sk')
    .slice(0, 4)
    .map(
      ([name, value]) => `${name}: ${value !== null && typeof value === 'object' ? '…' : String(value).slice(0, 60)}`
    );
}

/**
 * An item as a row of the group, in the console's grouped look: its key as the title, a few of its fields
 * under it, and a chevron where the whole row opens its page. An item whose key is secret has no page:
 * its fields open in place.
 */
function rowView(table, row, index) {
  const { item, key } = row;
  const title = [mono(String(item.pk ?? '')), ' ', mono(String(item.sk ?? ''), 'quiet')];
  return h(
    'li',
    { class: 'row db-row', key: key ? `${key.pk}\u0000${key.sk}` : `hidden-${index}` },
    h(
      'div',
      { class: 'row-main' },
      key
        ? h('button', { type: 'button', class: 'row-title cover-link db-open', onClick: () => open(table, key) }, title)
        : h('span', { class: 'row-title' }, title),
      h(
        'span',
        { class: 'row-note dotted' },
        summary(item).map((part, at) => h('span', { key: String(at) }, part))
      ),
      key ? null : h('details', { class: 'db-inline' }, h('summary', null, 'Fields'), fields(item))
    ),
    key ? h('span', { class: 'row-chevron' }, icon('arrow-right')) : null
  );
}

function itemView(ctx) {
  const { table, key, resource: item } = opened;
  return h(
    'div',
    { class: 'page', key: 'page' },
    developerTabs('database'),
    pageHead({
      eyebrow: `${table} table`,
      title: h('span', { class: 'mono' }, key.sk),
      meta: [mono(key.pk)],
      tools: button(
        'is-quiet',
        () => {
          opened = null;
          tools.draw();
        },
        icon('arrow-left'),
        'Back to the list'
      ),
    }),
    item.error ? failure('The item could not be read.', item.error) : null,
    card(
      { key: 'item', title: 'Fields' },
      item.value ? fields(item.value.item) : item.error ? null : loading('the item'),
      h(
        'p',
        { class: 'card-note' },
        'Fields that hold a credential, or something as good as one, read hidden for everybody.'
      )
    )
  );
}

function exportCard(table, limit) {
  const { busy, error, done } = exporting;
  return card(
    { key: 'export', title: 'Export' },
    h(
      'p',
      { class: 'card-note' },
      `The items of these filters, up to ${limit.toLocaleString('en-US')}, as they are shown here. `,
      'Each export goes in the activity log.',
      tools.share
        ? ' The app saves or shares the file.'
        : tools.inApp
          ? ' This app cannot save a file: export from the website.'
          : null
    ),
    h(
      'div',
      { class: 'button-row' },
      ['csv', 'json'].map((format) =>
        h(
          'button',
          {
            key: format,
            type: 'button',
            class: 'btn',
            disabled: busy !== false || (tools.inApp && !tools.share),
            onClick: () => exportAs(table, format),
          },
          icon('download'),
          busy === format ? 'Exporting…' : format.toUpperCase()
        )
      )
    ),
    error ? failure('Nothing was exported.', error) : null,
    done
      ? notice(
          done.capped ? 'warn' : 'good',
          done.capped ? 'alert' : 'check',
          `${done.name}: ${plural(done.count, 'item', 'items')}${done.capped ? `, stopped early (${CAPPED[done.capped]})` : ''}.`
        )
      : null
  );
}

const CAPPED = {
  items: 'the cap of items',
  size: 'the file grew too large for one answer',
  reads: 'too many reads of DynamoDB',
  time: 'time ran out',
};

export function databaseView(ctx) {
  const { state } = ctx;
  if (!canRead(state)) {
    return h(
      'div',
      { class: 'page', key: 'page' },
      developerTabs('database'),
      pageHead({ title: 'Database' }),
      empty({
        iconName: 'lock',
        title: 'Only release managers can browse the database.',
        text: 'The console’s tables hold every board, release and change. Ask a release manager.',
      })
    );
  }
  const table = tableOf(state.route);
  // An item stays open until Back, or until another table is chosen.
  if (opened !== null && opened.table !== table) opened = null;
  if (opened !== null) return itemView(ctx);
  const view = viewOf(table);
  const known = tables.value?.tables ?? [];
  const spec = known.find((one) => one.name === table);
  const page = view.list.value ? view : null;
  return h(
    'div',
    { class: 'page', key: 'page' },
    developerTabs('database'),
    pageHead({
      title: 'Database',
      lede: 'The console’s DynamoDB tables, read only.',
      how: {
        title: 'How the database page works',
        text: [
          'Secret fields read hidden, for everybody.',
          'Counts and sizes are DynamoDB’s, brought up to date about every six hours: rough.',
        ],
      },
      tools: freshness(view.list, ctx),
    }),
    tables.error ? failure('The tables could not be read.', tables.error) : null,
    tableTabs(table, known),
    spec?.about ? h('p', { class: 'db-about quiet', key: 'about' }, spec.about) : null,
    card({ key: 'filters', title: 'Filters' }, filterForm(table, spec)),
    card(
      { key: 'items', title: 'Items' },
      view.list.error ? failure('The items could not be read.', view.list.error) : null,
      page === null
        ? view.list.error
          ? null
          : loading('the items')
        : [
            h(
              'p',
              { class: 'card-note', key: 'how' },
              page.reading === 'query'
                ? ['A Query of the partition ', mono(page.partition ?? ''), '. ']
                : 'A Scan of one page of the table. ',
              `${plural(page.rows.length, 'item', 'items')} shown of ${page.read} read.`,
              page.stopped ? ' The rest could not be paged to: narrow the filters.' : null
            ),
            page.rows.length === 0
              ? h(
                  'p',
                  { class: 'quiet', key: 'none' },
                  page.cursor ? 'Nothing here matched on this page.' : 'Nothing matched.'
                )
              : h(
                  'ul',
                  { class: 'rows db-rows', key: 'rows' },
                  page.rows.map((row, index) => rowView(table, row, index))
                ),
            page.cursor
              ? h(
                  'div',
                  { class: 'button-row', key: 'more' },
                  button('', () => more(table), view.more ? 'Reading…' : 'Load more')
                )
              : null,
          ]
    ),
    exportCard(table, tables.value?.exportLimit || 10000)
  );
}
