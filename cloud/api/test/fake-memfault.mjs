/**
 * A fake of Memfault's REST API for the tests: a real HTTP server on 127.0.0.1 that answers the GETs the
 * console makes (src/aws-memfault-api.mjs, src/handlers/memfault.mjs) with answers of the shapes Memfault
 * gave in November 2026, and a fetch that sends https://api.memfault.com to it. It checks the Basic
 * credentials as Memfault does, refuses every method but GET, and records every request.
 *
 * Nothing here is a test; the file only has exports.
 */

import { createServer } from 'node:http';

export const ORG = 'cranium-team';
export const PROJECT = 'cranium-boards';
export const TOKEN = 'oat_fake0123456789abcdefghijklmnop';
export const A = 'cranium-00000000000000aa';
export const B = 'cranium-00000000000000bb';
const PREFIX = `/api/v0/organizations/${ORG}/projects/${PROJECT}/`;

const version = (name) => ({ id: 1, version: name, archived: false, software_type: { id: 2, name: 'app' } });

/** What the fake holds at the start: two boards, a crash, reboots, heartbeats and an update event. */
export function memfaultWorld() {
  return {
    devices: [
      {
        id: 1,
        device_serial: A,
        hardware_version: { name: 'nrf7002dk' },
        cohort: { id: 1, name: 'default', slug: 'default' },
        first_seen: '2026-11-05T19:32:33.723000+00:00',
        last_seen: '2026-11-09T16:06:49.759000+00:00',
        last_seen_software_version: version('1.15.0+0'),
      },
      {
        id: 2,
        device_serial: 'bench-unit-1',
        hardware_version: { name: 'nrf5340dk' },
        cohort: { id: 1, name: 'default', slug: 'default' },
        first_seen: '2026-11-06T10:00:00+00:00',
        last_seen: '2026-11-06T11:00:00+00:00',
        last_seen_software_version: version('1.14.0+0'),
      },
    ],
    reboots: {
      [A]: [
        {
          time: '2026-11-09T16:06:49.759000+00:00',
          software_version: version('1.15.0+0'),
          type: 'memfault',
          reason: 3,
          mcu_reason_register: 2,
        },
        {
          time: '2026-11-09T16:01:28.151000+00:00',
          software_version: version('1.14.0+0'),
          type: 'memfault',
          reason: 0x8008,
          mcu_reason_register: 16,
        },
        {
          time: '2026-11-08T10:00:00+00:00',
          software_version: version('1.14.0+0'),
          type: 'memfault',
          reason: 0xa002,
          mcu_reason_register: null,
        },
      ],
    },
    issues: [
      {
        id: 11,
        title: 'Kernel panic at crash_demo_on_tick',
        status: 'open',
        trace_count: 2,
        device_count: 1,
        first_seen: '2026-11-09T16:01:28+00:00',
        last_seen: '2026-11-09T16:01:28+00:00',
        first_release: { id: 1, version: '1.14.0+1' },
        last_release: { id: 1, version: '1.14.0+1' },
        signature: 'sig-crash',
        counts: [0, 0, 1, 1],
      },
      {
        id: 12,
        title: 'update_failed',
        status: 'open',
        trace_count: 1,
        device_count: 1,
        first_seen: '2026-11-07T10:00:00+00:00',
        last_seen: '2026-11-07T10:00:00+00:00',
        signature: 'sig-update',
        counts: [1],
      },
    ],
    traces: [
      {
        id: 101,
        title: 'Kernel panic at crash_demo_on_tick',
        reason: 'KernelPanic',
        captured_date: '2026-11-09T16:01:27+00:00',
        received_date: '2026-11-09T16:01:30+00:00',
        device: { id: 1, device_serial: A, hardware_version: 'nrf7002dk' },
        release: { id: 1, version: '1.14.0+1' },
        signature: 'sig-crash',
        entries: {
          threads: [
            {
              tid: 2,
              name: 'sysworkq',
              crashed: false,
              current: false,
              state: 'pending',
              registers: [],
              reporting: false,
              stacktrace: [{ index: 0, function: 'k_sem_take', file: 'kernel/sem.c', lineno: 120, address: 4096 }],
            },
            {
              tid: 1,
              name: 'main',
              crashed: true,
              current: true,
              state: 'running',
              registers: [{ name: 'pc', value: 245876 }, 'lr: 0x00039599', ['sp', '0x20010000']],
              reporting: true,
              stacktrace: [
                { index: 0, function: 'crash_demo_on_tick', file: 'src/mflt.c', lineno: 301, address: 245876 },
                { index: 1, function: 'z_work_q_main', file: 'kernel/work.c', lineno: 640, address: 234937 },
              ],
            },
          ],
        },
      },
      {
        id: 102,
        title: 'update_failed',
        reason: 'update_failed',
        captured_date: '2026-11-07T10:00:00+00:00',
        device: { device_serial: B },
        signature: 'sig-update',
        entries: { threads: [] },
      },
    ],
    releases: [
      { id: 1, version: '1.15.0+0', created_date: '2026-11-09T17:08:00+00:00' },
      { id: 2, version: '1.14.0+0', created_date: '2026-11-05T19:12:38+00:00' },
    ],
    versions: [
      { version: '1.15.0+0', symbol_file: { id: 9, downloadable: true }, software_type: { name: 'app' } },
      { version: '1.14.0+0', symbol_file: null, software_type: { name: 'app' } },
    ],
    log: [
      {
        created_date: '2026-11-09T17:06:40+00:00',
        device_serial: A,
        software_version: '1.15.0+0',
        event_type: 'ReceivedDataHeartbeatEvent',
        level: 'info',
        source: 'chunks',
        event_data: {
          received_event: {
            captured_date: '2026-11-09T17:06:39+00:00',
            event_info: {
              metrics: { Heap_BytesFree: 21624, power_usb_present: 1, supply_mv: 3300, cpu_usage_pct: 12.5 },
            },
          },
        },
      },
      {
        created_date: '2026-11-09T16:06:40+00:00',
        device_serial: A,
        software_version: '1.15.0+0',
        event_type: 'ReceivedDataHeartbeatEvent',
        level: 'info',
        source: 'chunks',
        event_data: {
          received_event: {
            captured_date: '2026-11-09T16:06:39+00:00',
            event_info: { metrics: { Heap_BytesFree: 20000, power_usb_present: 1, supply_mv: 3290 } },
          },
        },
      },
      {
        created_date: '2026-11-09T16:06:50+00:00',
        device_serial: A,
        software_version: '1.15.0+0',
        event_type: 'ReceivedDataRebootEvent',
        level: 'info',
        source: 'trace',
        event_data: {
          received_event: {
            captured_date: '2026-11-09T16:06:49+00:00',
            event_info: { reason: 3, coredump_saved: false },
          },
        },
      },
      {
        created_date: '2026-11-09T16:06:55+00:00',
        device_serial: A,
        software_version: '1.15.0+0',
        event_type: 'ReceivedDataTraceEvent',
        level: 'info',
        source: 'trace',
        event_data: {
          received_event: {
            captured_date: '2026-11-09T16:06:54+00:00',
            event_info: { pc: 245876, lr: 234937, reason_log: '1.15.0+0', reason: 1, is_user_reason: true },
          },
        },
      },
      {
        created_date: '2026-11-07T00:15:18+00:00',
        device_serial: B,
        software_version: '1.14.0+0',
        event_type: 'SymbolFileMissing',
        level: 'error',
        source: 'task_process_compressed_events',
        event_data: {
          received_event: {
            captured_date: '2026-11-07T00:15:16+00:00',
            event_info: { session_key: 0, metrics: [3600000, null, 132] },
          },
          missing_symbol_files: [{ build_id: '2fdf2f7e8b95' }],
        },
      },
      {
        created_date: '2026-11-06T22:15:27+00:00',
        device_serial: B,
        software_version: '1.14.0+0',
        event_type: 'ReceivedDataRebootEvent',
        level: 'info',
        source: 'trace',
        event_data: {
          received_event: {
            captured_date: '2026-11-06T22:15:27+00:00',
            event_info: { reason: 0x8008, coredump_saved: true },
          },
        },
      },
    ],
  };
}

/**
 * Start the fake. `world` is what it answers from; `fail(path)` may return a status to answer instead
 * (or 'hang' to answer nothing, or 'garbage' for an answer that is not JSON).
 */
export async function startFakeMemfault({ world = memfaultWorld(), token = TOKEN } = {}) {
  const requests = [];
  const state = { world, token, fail: () => null, logPageSize: null };
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fake');
    requests.push({
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      auth: request.headers.authorization,
    });
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'GET') return send(405, { error: { message: 'Method not allowed' } });
    const expected = `Basic ${Buffer.from(`:${state.token}`).toString('base64')}`;
    if (request.headers.authorization !== expected) return send(401, { error: { message: 'Unauthorized' } });
    if (!url.pathname.startsWith(PREFIX)) return send(404, { error: { message: 'not found' } });
    const path = url.pathname.slice(PREFIX.length);
    const failure = state.fail(path, url.searchParams);
    if (failure === 'hang') return undefined;
    if (failure === 'garbage') {
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end('<html>maintenance</html>');
    }
    if (failure !== null) return send(failure, { error: { message: 'failure' } });
    const page = (data) => send(200, { data, paging: { total_count: data.length, page: 1, per_page: 100 } });
    const w = state.world;
    let match;
    if (path === 'devices') return page(w.devices);
    if ((match = /^devices\/([^/]+)$/.exec(path))) {
      const found = w.devices.find((one) => one.device_serial === match[1]);
      return found ? send(200, { data: found }) : send(404, { error: { message: 'not found' } });
    }
    if ((match = /^devices\/([^/]+)\/reboots$/.exec(path))) {
      if (!w.devices.some((one) => one.device_serial === match[1])) return send(404, { error: {} });
      return page(w.reboots[match[1]] ?? []);
    }
    if (path === 'issues') return page(w.issues);
    if ((match = /^issues\/(\d+)$/.exec(path))) {
      const found = w.issues.find((one) => String(one.id) === match[1]);
      if (!found) return send(404, { error: { message: 'not found' } });
      const last = w.traces.find((one) => one.signature === found.signature) ?? null;
      return send(200, { data: { ...found, last_trace: last } });
    }
    // Memfault's own filters are not relied on: this fake ignores them, as an unknown filter would be.
    if (path === 'traces') return page(w.traces);
    if (path === 'releases') return page(w.releases);
    if (path === 'software_types/app/software_versions') return page(w.versions);
    if (path === 'processing-log') {
      if (!url.searchParams.get('start')) return send(400, { error: { message: 'start: Missing data' } });
      const serial = url.searchParams.get('device_serial');
      if (serial && !w.devices.some((one) => one.device_serial === serial)) return send(404, { error: {} });
      let entries = w.log.filter((one) => !serial || one.device_serial === serial);
      entries = entries.sort((a, b) => (a.created_date < b.created_date ? 1 : -1));
      const after = url.searchParams.get('page[after]');
      if (after) entries = entries.filter((one) => one.created_date < after);
      const size = state.logPageSize ?? 500;
      const shown = entries.slice(0, size);
      const next =
        entries.length > size
          ? `${PREFIX}processing-log?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), 'page[after]': shown[shown.length - 1].created_date })}`
          : null;
      return send(200, { data: shown, links: { next } });
    }
    return send(404, { error: { message: 'The requested URL was not found on the server.' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  return {
    state,
    requests,
    /** A fetch that sends Memfault's API to the fake, and anything else nowhere. */
    fetch: (url, init) => {
      if (!String(url).startsWith('https://api.memfault.com/')) throw new Error(`Not Memfault's API: ${url}`);
      return globalThis.fetch(String(url).replace('https://api.memfault.com', origin), init);
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

export const MEMFAULT_ENV = Object.freeze({
  AWS_REGION: 'us-east-1',
  MEMFAULT_TOKEN_SECRET_ARN:
    'arn:aws:secretsmanager:us-east-1:123456789012:secret:cranium-ota/memfault-org-token-AbCdEf',
  MEMFAULT_ORG_SLUG: ORG,
  MEMFAULT_PROJECT_SLUG: PROJECT,
});
