/**
 * The Database page (docs/database.md): the console's three DynamoDB tables, for release managers only,
 * read only, and never a secret field (lib/db.mjs hideSecrets), not even to them.
 *
 *   GET /api/db/tables           -> { approximate: true, exportLimit, tables: [{ name, label, about, items,
 *                                     bytes, kinds: [{ id, label, board, timed }] }] }
 *                                   items and bytes are DescribeTable's, brought up to date by DynamoDB about
 *                                   every six hours: a rough size, said so on the page
 *   GET /api/db/{table}          -> { table, reading: 'query' | 'scan', partition, rows: [{ key, item }], read,
 *                                     cursor, stopped }
 *        ?kind=&partition=&board=&from=&to=&text=&limit=&cursor=
 *        One page: a Query of one partition where a filter names one, else a Scan of `limit` items from
 *        the cursor. Never a whole table for one view. `text` is looked for in what is shown, after the
 *        read, so a page may hold fewer rows than it read (`read`). `key` is null for an item whose own key
 *        is a credential's digest; such a key is never in a cursor either: the read goes on past it.
 *   GET /api/db/{table}/item?pk=&sk=  -> { table, key, item }       404 unknown_item
 *   GET /api/db/{table}/export?format=csv|json&<the filters>
 *                                -> { name, type, content, count, capped }        db.export, on record
 *        Every item of the filters up to EXPORT_MAX_ITEMS, as shown, in one file; `capped` says what stopped
 *        it early: items, size, reads or time, else null.
 *
 * Release managers, asked of Cognito now, on the website or in the apps; never with an API token (app.mjs).
 */

import { badRequest, notFound } from '../http.mjs';
import {
  EXPORT_MAX_CHARS,
  EXPORT_MAX_ITEMS,
  EXPORT_MAX_READS,
  TABLES,
  TABLE_NAMES,
  decodeCursor,
  describeFilters,
  encodeCursor,
  hideSecrets,
  keyOf,
  matchesText,
  planOf,
  readFilters,
  requireDbPage,
  requireFormat,
  requireKeyText,
  requireTable,
  secretKey,
  toCsv,
  toJson,
} from '../lib/db.mjs';

// Past a secret key: this many items a read, this many reads at most.
const SECRET_STEP = 25;
const SECRET_STEPS = 20;
// An export reads this many items at a time, and stops after this long, to leave the request time to answer.
const EXPORT_STEP = 1000;
const EXPORT_MAX_MS = 9000;
const TYPES = Object.freeze({ csv: 'text/csv', json: 'application/json' });

function stamp(ms) {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

export function createDbHandlers({ aws, now, directory }) {
  /**
   * One page of a plan, from `start`. A page that would end on a secret key goes on reading until it ends
   * on another, or the table does; after SECRET_STEPS more reads it stops (`stopped`), with no cursor.
   */
  async function page(table, plan, limit, start) {
    const items = [];
    let read = 0;
    let next = start;
    let reads = 0;
    do {
      const out = await aws.dbRead({ table, ...plan, limit: reads === 0 ? limit : SECRET_STEP, start: next });
      items.push(...out.items);
      read += out.read;
      next = out.next;
      reads += 1;
    } while (next !== null && secretKey(table, next) && reads <= SECRET_STEPS);
    const stopped = next !== null && secretKey(table, next);
    return { items, read, next: stopped ? null : next, stopped };
  }

  return {
    async tables({ caller }) {
      // A read, and still for release managers only, asked of Cognito now.
      await directory.requireLiveWriter(caller);
      const described = await Promise.all(TABLE_NAMES.map((name) => aws.dbDescribe(name)));
      return {
        body: {
          approximate: true,
          exportLimit: EXPORT_MAX_ITEMS,
          tables: TABLE_NAMES.map((name, index) => ({
            name,
            label: TABLES[name].label,
            about: TABLES[name].about,
            items: described[index].items,
            bytes: described[index].bytes,
            kinds: TABLES[name].kinds.map((kind) => ({
              id: kind.id,
              label: kind.label,
              board: kind.board === true,
              timed: kind.timed === true,
            })),
          })),
        },
      };
    },

    async list({ caller, params, query }) {
      await directory.requireLiveWriter(caller);
      const table = requireTable(params.table);
      const filters = readFilters(table, query);
      const limit = requireDbPage(query.limit);
      const start = decodeCursor(query.cursor);
      if (start !== null && secretKey(table, start)) {
        throw badRequest('invalid_cursor', '"cursor" is not one this console gave.');
      }
      const plan = planOf(table, filters);
      const got = await page(table, plan, limit, start);
      const rows = got.items
        .map((item) => ({ key: keyOf(table, item), item: hideSecrets(table, item) }))
        .filter((row) => matchesText(row.item, filters.text));
      return {
        body: {
          table,
          reading: plan.op,
          partition: plan.op === 'query' ? plan.pk : null,
          rows,
          read: got.read,
          cursor: encodeCursor(got.next),
          stopped: got.stopped,
        },
      };
    },

    async item({ caller, params, query }) {
      await directory.requireLiveWriter(caller);
      const table = requireTable(params.table);
      const pk = requireKeyText(query.pk, 'pk');
      const sk = requireKeyText(query.sk, 'sk');
      const out = await aws.dbRead({ table, op: 'query', pk, sk: { equals: sk }, where: [], limit: 1, start: null });
      const [item] = out.items;
      if (item === undefined) throw notFound('unknown_item', 'There is no item with that key in this table.');
      return { body: { table, key: keyOf(table, item), item: hideSecrets(table, item) } };
    },

    /** An export, on record (db.export): who, which table, which filters, how many items. */
    async exportItems({ params, query, entry }) {
      const table = requireTable(params.table);
      entry.target = table;
      const format = requireFormat(query.format);
      entry.detail.format = format;
      const filters = readFilters(table, query);
      const said = describeFilters(filters);
      if (said !== '') entry.detail.filters = said;
      const plan = planOf(table, filters);
      const began = now();
      const shown = [];
      let chars = 0;
      let reads = 0;
      let start = null;
      let capped = null;
      reading: for (;;) {
        if (reads >= EXPORT_MAX_READS) {
          capped = 'reads';
          break;
        }
        if (now() - began > EXPORT_MAX_MS) {
          capped = 'time';
          break;
        }
        const out = await aws.dbRead({ table, ...plan, limit: EXPORT_STEP, start });
        reads += 1;
        for (const item of out.items) {
          const one = hideSecrets(table, item);
          if (!matchesText(one, filters.text)) continue;
          if (shown.length >= EXPORT_MAX_ITEMS) {
            capped = 'items';
            break reading;
          }
          // What the item costs in the answer, where the file's text is itself in JSON.
          chars += JSON.stringify(JSON.stringify(one)).length;
          if (chars > EXPORT_MAX_CHARS) {
            capped = 'size';
            break reading;
          }
          shown.push(one);
        }
        start = out.next;
        if (start === null) break;
      }
      entry.detail.items = String(shown.length);
      if (capped !== null) entry.detail.capped = capped;
      return {
        body: {
          name: `cranium-${table}-${stamp(now())}.${format}`,
          type: TYPES[format],
          content: format === 'csv' ? toCsv(shown) : toJson(shown),
          count: shown.length,
          capped,
        },
      };
    },
  };
}
