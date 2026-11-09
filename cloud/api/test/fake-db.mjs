// The Database page's reads (src/aws-db.mjs) in memory, for test/fake-aws.mjs: DescribeTable, and Query and
// Scan as DynamoDB does them. A page reads `limit` items, the filter leaves some out, and the key of the
// last item read is where the next page starts. The items are those the fake keeps in its own maps (a
// release, a token, an audit entry, an event), and any a test adds with fake.seedDb(table, item).

const TABLES = ['state', 'audit', 'events'];

function test(item, one) {
  if (one.any) return one.any.some((part) => test(item, part));
  if (one.equals) return item[one.equals[0]] === one.equals[1];
  if (one.contains) {
    const value = item[one.contains[0]];
    return typeof value === 'string' || Array.isArray(value) ? value.includes(one.contains[1]) : false;
  }
  if (one.begins) {
    const value = item[one.begins[0]];
    return typeof value === 'string' && value.startsWith(one.begins[1]);
  }
  if (one.between) {
    const value = item[one.between[0]];
    return typeof value === 'string' && value >= one.between[1] && value <= one.between[2];
  }
  throw new TypeError('Not a condition');
}

function onKey(sk, condition) {
  if (condition === null) return true;
  if (condition.equals !== undefined) return sk === condition.equals;
  if (condition.begins !== undefined) return sk.startsWith(condition.begins);
  return sk >= condition.between[0] && sk <= condition.between[1];
}

const order = (a, b) => (a.pk < b.pk ? -1 : a.pk > b.pk ? 1 : a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0);

/**
 * @param {object} options
 * @param {(table: string) => object[]} options.stored  the items the fake keeps of a table, each with pk and sk
 */
export function createFakeDb({ stored }) {
  const seeded = new Map(TABLES.map((table) => [table, new Map()]));
  const sizes = new Map();

  function itemsOf(table) {
    const all = new Map();
    for (const item of stored(table)) all.set(`${item.pk}\u0000${item.sk}`, item);
    for (const [key, item] of seeded.get(table)) all.set(key, item);
    return [...all.values()].map((item) => structuredClone(item)).sort(order);
  }

  const adapter = {
    async dbDescribe(table) {
      if (!TABLES.includes(table)) throw new TypeError('Not a table of the Database page');
      const items = itemsOf(table);
      return sizes.get(table) ?? { items: items.length, bytes: JSON.stringify(items).length };
    },

    async dbRead({ table, op, pk = null, sk = null, newestFirst = true, where = [], limit, start = null }) {
      if (!TABLES.includes(table)) throw new TypeError('Not a table of the Database page');
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('A read needs a Limit');
      let items = itemsOf(table);
      if (op === 'query') {
        if (
          where.some(function names(one) {
            return one.any ? one.any.some(names) : ['pk', 'sk'].includes(Object.values(one)[0][0]);
          })
        ) {
          throw new TypeError('A filter expression cannot contain the key of a Query');
        }
        items = items.filter((item) => item.pk === pk && onKey(item.sk, sk));
        if (newestFirst) items.reverse();
      } else if (op !== 'scan') {
        throw new TypeError(`No such read ${op}`);
      }
      let from = 0;
      if (start !== null) {
        const at = items.findIndex((item) => item.pk === start.pk && item.sk === start.sk);
        if (at < 0) throw new TypeError('The fake starts only after an item it has');
        from = at + 1;
      }
      const page = items.slice(from, from + limit);
      const last = page.at(-1);
      return {
        items: page.filter((item) => where.every((one) => test(item, one))),
        next: from + limit < items.length && last ? { pk: last.pk, sk: last.sk } : null,
        read: page.length,
      };
    },
  };

  const helpers = {
    /** Put an item into one of the tables as it would be stored. */
    seedDb(table, item) {
      seeded.get(table).set(`${item.pk}\u0000${item.sk}`, structuredClone(item));
    },
    /** What DescribeTable says of a table, in place of the count of what is there. */
    describeDb(table, size) {
      sizes.set(table, size);
    },
  };

  return { adapter, helpers };
}
