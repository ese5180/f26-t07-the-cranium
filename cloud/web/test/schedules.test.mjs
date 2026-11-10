/**
 * Tests for scheduled starts and maintenance windows in the console (console 2.17.0, fleet.js and the
 * New deployment dialog of views.js): "Schedule for later" in the New deployment, Roll out and Roll back
 * to last good dialogs with what each sends, the Scheduled list on the Deployments page with its changes
 * of time and its cancelling, a group's window in its dialog, and a rollout waiting for its window.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE, TELEMETRY, VIEWS, all, click, createDocument, one, scriptAddress, textOf } from './page.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
const fleet = await import(
  scriptAddress('fleet.js', { 'core.js': CORE, 'views.js': VIEWS, 'telemetry.js': TELEMETRY }, '?schedules')
);
globalThis.document = createDocument();

const NOW = Date.parse('2026-11-09T12:00:00Z');
const A = 'cranium-00000000000000aa';
const B = 'cranium-00000000000000bb';
const GROUP = 'grp-0a0b0c0d';
const WINDOW = { days: [1, 2, 3, 4, 5], start: '01:00', end: '05:00', timeZone: 'America/New_York' };
const SCHEDULE = 'sch-20261109T120000Z-0a0b0c';
const loaded = (value) => ({ value, error: null, loadedAt: NOW, loading: false });

function draw(node) {
  const box = document.createElement('div');
  views.render(box, node);
  return box;
}

const FLEET = {
  boards: [
    {
      thing: A,
      name: null,
      type: 'nrf7002dk',
      bluetoothOnly: false,
      online: true,
      version: '1.13.0+0',
      groups: [GROUP],
    },
    {
      thing: B,
      name: null,
      type: 'nrf7002dk',
      bluetoothOnly: false,
      online: true,
      version: '1.13.0+0',
      groups: [GROUP],
    },
  ],
  groups: [{ id: GROUP, name: 'Bench', things: [A, B], gone: 0, window: WINDOW }],
  types: [{ type: 'nrf7002dk', boards: 2, newest: '1.13.1+0', previous: '1.13.0+0', bluetoothOnly: false }],
};
const RELEASES = [
  {
    version: '1.13.1+0',
    board: 'nrf7002dk',
    status: 'active',
    size: 1000,
    sha256: 'a'.repeat(64),
    uploadedAt: '2026-11-09T11:00:00Z',
    uploadedBy: {},
    notes: '',
  },
];

function scheduled(changes = {}) {
  return {
    id: SCHEDULE,
    kind: 'rollout',
    request: { version: '1.13.1+0', target: { kind: 'group', group: GROUP } },
    group: GROUP,
    groupName: 'Bench',
    at: '2026-11-10T02:00',
    timeZone: 'America/New_York',
    dueAt: '2026-11-10T07:00:00.000Z',
    status: 'scheduled',
    waiting: null,
    window: 'weekdays 01:00–05:00 America/New_York',
    createdAt: '2026-11-09T12:00:00.000Z',
    createdBy: { sub: 's', email: 'manager@example.invalid' },
    started: null,
    error: null,
    ...changes,
  };
}

/** The fleet module with an API that answers from the test, and dialogs drawn and submitted as app.js would. */
function console_(extra = {}) {
  const state = {
    now: NOW,
    route: { view: 'deployments' },
    me: { canWrite: true },
    devices: loaded({ devices: [] }),
    firmware: loaded({ releases: RELEASES }),
    deployments: loaded([]),
    deploymentDetails: new Map(),
    ...extra,
  };
  const answers = new Map();
  const posted = [];
  const went = [];
  const notes = [];
  let build = null;
  fleet.connect({
    state,
    api: {
      fleetRequest: async (method, path, body) => {
        if (method === 'POST') posted.push([path, body]);
        if (!answers.has(`${method} ${path}`)) throw new core.ApiError(404, 'not_found', 'Nothing there');
        return answers.get(`${method} ${path}`);
      },
    },
    load: async (target, fetcher) => {
      target.value = await fetcher();
      target.loadedAt = NOW;
    },
    draw: () => {},
    clock: { now: () => NOW },
    refresh: () => {},
    notify: (text) => notes.push(text),
    keep: () => {},
    go: (where) => went.push(where),
    dialogs: {
      open: (made) => {
        build = made;
        return { redraw() {}, close() {} };
      },
      submit: async (self, model, run) => run(),
      isOpen: () => false,
      signIn: () => {},
    },
  });
  return { state, answers, posted, went, notes, ctx: { state, actions: {}, fleet }, dialog: () => draw(build()) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const input = (root, name) => all(root, 'input').find((el) => el.getAttribute('name') === name);

test('Roll out to a group: "Schedule for later" asks for a time and zone, says the window, and schedules', async () => {
  const { answers, posted, went, notes, ctx, dialog } = console_();
  answers.set('GET /api/fleet', FLEET);
  answers.set('POST /api/schedules', { schedule: scheduled() });
  answers.set('GET /api/schedules', { schedules: [scheduled()] });
  await fleet.refreshFor('devices', true);
  const groups = draw(fleet.groupsCard(ctx));
  // The group says its window.
  assert.match(textOf(groups), /Maintenance window: weekdays 01:00–05:00 America\/New_York/);
  click(one(groups, 'button', 'Roll out'));
  await settle();
  let shown = dialog();
  assert.match(textOf(shown), /When\? Start now Schedule for later/);
  assert.equal(input(shown, 'schedule-at'), undefined);
  assert.ok(all(shown, 'button').some((el) => textOf(el) === 'Start staged rollout'));

  click(all(shown, 'input').find((el) => textOf(el.parentNode).includes('Schedule for later')));
  shown = dialog();
  // A time, in the browser's zone to begin with: tomorrow at 02:00.
  assert.equal(input(shown, 'schedule-at').value, '2026-11-10T02:00');
  assert.equal(input(shown, 'schedule-zone').value, fleet.browserTimeZone());
  assert.match(
    textOf(shown),
    /maintenance window is weekdays 01:00–05:00 America\/New_York: outside it, the start waits/
  );
  input(shown, 'schedule-zone').dispatchEvent({ type: 'input', target: { value: 'America/New_York' } });
  input(shown, 'schedule-at').dispatchEvent({ type: 'input', target: { value: '2026-11-10T03:30' } });
  shown = dialog();
  assert.ok(all(shown, 'button').some((el) => textOf(el) === 'Schedule staged rollout'));
  one(shown, 'form').dispatchEvent({ type: 'submit', preventDefault() {} });
  await settle();
  assert.deepEqual(posted.at(-1), [
    '/api/schedules',
    {
      kind: 'rollout',
      at: '2026-11-10T03:30',
      timeZone: 'America/New_York',
      request: {
        version: '1.13.1+0',
        target: { kind: 'group', group: GROUP },
        canary: 1,
        stages: 1,
        soakMinutes: 0,
        healthGate: { on: true, minutes: 10 },
        abortPercent: 20,
      },
    },
  ]);
  assert.ok(!posted.some(([path]) => path === '/api/rollouts'));
  assert.deepEqual(went.at(-1), { view: 'deployments' });
  assert.match(notes.at(-1), /^Scheduled for 2026-11-10 02:00 America\/New_York\.$/);

  // A time that is not one cannot be sent.
  click(one(groups, 'button', 'Roll out'));
  await settle();
  shown = dialog();
  click(all(shown, 'input').find((el) => textOf(el.parentNode).includes('Schedule for later')));
  input(dialog(), 'schedule-at').dispatchEvent({ type: 'input', target: { value: '' } });
  assert.equal(all(dialog(), 'button').find((el) => textOf(el) === 'Schedule staged rollout').disabled, true);
});

test('the Scheduled list: what, when, by whom, waiting for the window; a release manager changes the time or cancels', async () => {
  const { state, answers, posted, ctx, dialog } = console_();
  answers.set('GET /api/schedules', {
    schedules: [
      scheduled({ waiting: 'window' }),
      scheduled({
        id: 'sch-20261108T120000Z-0d0e0f',
        kind: 'deployment',
        request: { version: '1.13.1+0', things: [A] },
        group: null,
        groupName: null,
        status: 'started',
        started: { deployments: ['cranium-1-13-1-b0-20261109T070000Z-aaaa'] },
      }),
      scheduled({
        id: 'sch-20261107T120000Z-0a0a0a',
        kind: 'last_good',
        request: {},
        group: null,
        groupName: null,
        status: 'failed',
        error: { code: 'nothing_to_deploy', text: 'No board has a last good version it can be sent now.' },
      }),
    ],
  });
  answers.set('GET /api/rollouts', { rollouts: [] });
  answers.set('GET /api/fleet', FLEET);
  await fleet.refreshFor('deployments', true);
  const panel = draw(fleet.schedulesPanel(ctx));
  const rows = all(panel, 'li');
  assert.equal(rows.length, 3);
  assert.match(textOf(rows[0]), /Staged rollout of 1\.13\.1\+0 to the group Bench Waiting for the window/);
  assert.match(textOf(rows[0]), /2026-11-10 02:00 America\/New_York/);
  assert.match(textOf(rows[0]), /Window: weekdays 01:00–05:00 America\/New_York/);
  assert.match(textOf(rows[1]), /Deployment of 1\.13\.1\+0 to 1 board Started/);
  assert.equal(
    one(rows[1], 'a', 'Its deployment').getAttribute('href'),
    core.deploymentHref('cranium-1-13-1-b0-20261109T070000Z-aaaa')
  );
  assert.match(textOf(rows[2]), /Roll back to last good: the fleet Not started.*No board has a last good version/);
  // Only one still to come can be changed.
  assert.equal(all(panel, 'button').length, 2);

  // The time, changed.
  answers.set(`POST /api/schedules/${SCHEDULE}`, { schedule: scheduled({ at: '2026-11-11T01:15' }) });
  click(all(rows[0], 'button').find((el) => textOf(el) === 'Change time'));
  let shown = dialog();
  assert.equal(input(shown, 'schedule-at').value, '2026-11-10T02:00');
  assert.match(textOf(shown), /It waits for the group's maintenance window: weekdays/);
  input(shown, 'schedule-at').dispatchEvent({ type: 'input', target: { value: '2026-11-11T01:15' } });
  one(dialog(), 'form').dispatchEvent({ type: 'submit', preventDefault() {} });
  await settle();
  assert.deepEqual(posted.at(-1), [
    `/api/schedules/${SCHEDULE}`,
    { at: '2026-11-11T01:15', timeZone: 'America/New_York' },
  ]);

  // Cancelled.
  answers.set(`POST /api/schedules/${SCHEDULE}/cancel`, { schedule: scheduled({ status: 'cancelled' }) });
  click(all(rows[0], 'button').find((el) => textOf(el) === 'Cancel'));
  shown = dialog();
  assert.match(textOf(shown), /It was to start at 2026-11-10 02:00 America\/New_York; it will not start\./);
  one(shown, 'form').dispatchEvent({ type: 'submit', preventDefault() {} });
  await settle();
  assert.deepEqual(posted.at(-1), [`/api/schedules/${SCHEDULE}/cancel`, {}]);

  // A viewer sees the list, without buttons.
  state.me = { canWrite: false };
  assert.equal(all(draw(fleet.schedulesPanel(ctx)), 'button').length, 0);
  // Nothing scheduled: no card. An API from before 2.17.0 answers 404: an empty list.
  answers.delete('GET /api/schedules');
  state.schedules.loadedAt = 0;
  await fleet.refreshFor('deployments', true);
  assert.deepEqual(state.schedules.value, []);
  assert.equal(fleet.schedulesPanel(ctx), null);
});

test("a group's maintenance window in its dialog: days, hours and a time zone, sent, and taken away", async () => {
  const { answers, posted, ctx, dialog } = console_();
  answers.set('GET /api/fleet', { ...FLEET, groups: [{ ...FLEET.groups[0], window: null }] });
  answers.set(`POST /api/groups/${GROUP}`, { group: { ...FLEET.groups[0] } });
  await fleet.refreshFor('devices', true);
  click(one(draw(fleet.groupsCard(ctx)), 'button', 'Edit'));
  let shown = dialog();
  assert.match(textOf(shown), /Maintenance window Only update these boards inside a window/);
  assert.equal(input(shown, 'window-start'), undefined);
  click(input(shown, 'window-on'));
  shown = dialog();
  // Weekdays 01:00 to 05:00 to begin with.
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((day) => input(shown, `window-day-${day}`).checked),
    [false, true, true, true, true, true, false]
  );
  input(shown, 'window-zone').dispatchEvent({ type: 'input', target: { value: 'America/New_York' } });
  click(input(dialog(), 'window-day-5'));
  input(dialog(), 'window-start').dispatchEvent({ type: 'input', target: { value: '22:00' } });
  input(dialog(), 'window-end').dispatchEvent({ type: 'input', target: { value: '02:00' } });
  shown = dialog();
  assert.match(
    textOf(shown),
    /Open Mon Tue Wed Thu 22:00–02:00 America\/New_York\. A "To" at or before "From" is the next morning\./
  );
  one(shown, 'form').dispatchEvent({ type: 'submit', preventDefault() {} });
  await settle();
  assert.deepEqual(posted.at(-1), [
    `/api/groups/${GROUP}`,
    {
      name: 'Bench',
      things: [A, B],
      window: { days: [1, 2, 3, 4], start: '22:00', end: '02:00', timeZone: 'America/New_York' },
    },
  ]);
  // The same hours twice is no window: the dialog will not send it.
  input(dialog(), 'window-end').dispatchEvent({ type: 'input', target: { value: '22:00' } });
  assert.match(textOf(dialog()), /Choose at least one day, two different times and a time zone/);
  assert.equal(all(dialog(), 'button').find((el) => textOf(el) === 'Save group').disabled, true);

  // A group with one, saved without it: taken away.
  const withWindow = console_();
  withWindow.answers.set('GET /api/fleet', FLEET);
  withWindow.answers.set(`POST /api/groups/${GROUP}`, { group: { ...FLEET.groups[0], window: null } });
  await fleet.refreshFor('devices', true);
  click(one(draw(fleet.groupsCard(withWindow.ctx)), 'button', 'Edit'));
  click(input(withWindow.dialog(), 'window-on'));
  one(withWindow.dialog(), 'form').dispatchEvent({ type: 'submit', preventDefault() {} });
  await settle();
  assert.deepEqual(withWindow.posted.at(-1), [`/api/groups/${GROUP}`, { name: 'Bench', things: [A, B], window: null }]);
  assert.deepEqual(fleet.readers.readGroup({ id: GROUP, name: 'x', window: { ...WINDOW, days: [9] } }).window, null);
});

test('Roll back to last good, scheduled: the boards ticked and the choices, the plan made again then', async () => {
  const { answers, posted, ctx, dialog } = console_();
  answers.set('GET /api/fleet', FLEET);
  answers.set(`GET /api/groups/${GROUP}/last-good`, {
    plan: {
      scope: { kind: 'group', id: GROUP, name: 'Bench' },
      targets: [
        {
          type: 'nrf7002dk',
          release: {
            version: '1.13.2+0',
            board: 'nrf7002dk',
            layout: 1,
            notes: 'Rebuild of 1.13.0',
            rebuildOf: '1.13.0',
          },
          boards: [{ thing: A, from: '1.13.1+0', to: '1.13.0+0', how: 'ran_before' }],
          things: [A],
          leftOut: [],
          canary: [A],
        },
      ],
      leftOut: [],
      healthGate: { on: true, minutes: 10 },
    },
  });
  answers.set('POST /api/schedules', {
    schedule: scheduled({ kind: 'last_good', request: { group: GROUP, things: [A] } }),
  });
  await fleet.refreshFor('devices', true);
  click(one(draw(fleet.groupsCard(ctx)), 'button', 'Roll back to last good'));
  await settle();
  click(all(dialog(), 'input').find((el) => textOf(el.parentNode).includes('Schedule for later')));
  const shown = dialog();
  assert.ok(all(shown, 'button').some((el) => textOf(el) === 'Schedule roll back: 1 board'));
  input(shown, 'schedule-zone').dispatchEvent({ type: 'input', target: { value: 'UTC' } });
  one(dialog(), 'form').dispatchEvent({ type: 'submit', preventDefault() {} });
  await settle();
  assert.deepEqual(posted.at(-1), [
    '/api/schedules',
    {
      kind: 'last_good',
      at: '2026-11-10T02:00',
      timeZone: 'UTC',
      request: {
        canary: 1,
        stages: 1,
        soakMinutes: 0,
        healthGate: { on: true, minutes: 10 },
        abortPercent: 20,
        group: GROUP,
        things: [A],
      },
    },
  ]);
});

test('the New deployment dialog asks when, and says Schedule when it is later', () => {
  const model = {
    step: 2,
    version: '1.13.1+0',
    things: new Set([A]),
    busy: new Map(),
    note: '',
    loading: false,
    loadError: null,
    releases: RELEASES,
    devices: [
      {
        thing: A,
        name: null,
        online: true,
        lastSeen: '2026-11-09T11:59:00Z',
        fw: { version: '1.13.0+0', confirmed: true },
        ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' },
        rssi: -52,
        uptime: 3600,
        stuck: null,
        diag: null,
        diary: null,
        bt: null,
      },
    ],
    types: null,
    canary: 1,
    abortPercent: 20,
    sending: false,
    error: null,
    ...fleet.scheduleModel(NOW),
    redraw() {},
    close() {},
    next() {},
    back() {},
    setNote() {},
  };
  const ctx = { state: { now: NOW, me: { canWrite: true } }, actions: {}, fleet };
  let shown = draw(views.deployDialog(model, ctx));
  assert.match(textOf(shown), /When\? Start now Schedule for later/);
  model.when = 'later';
  shown = draw(views.deployDialog(model, ctx));
  assert.ok(all(shown, 'button').some((el) => textOf(el) === 'Schedule deployment to 1 board'));
  model.timeZone = 'not a zone!';
  shown = draw(views.deployDialog(model, ctx));
  assert.equal(all(shown, 'button').find((el) => textOf(el) === 'Schedule deployment to 1 board').disabled, true);
  // Without the fleet's script, no choice: it starts now.
  const plain = draw(views.deployDialog({ ...model, when: undefined }, { ...ctx, fleet: null }));
  assert.doesNotMatch(textOf(plain), /When\?/);
});

test('a rollout waiting for its window says so, in the list and on its page', () => {
  const rollout = fleet.readers.readRollout({
    id: 'rol-20261109T110000Z-0a0b0c',
    version: '1.13.1+0',
    board: 'nrf7002dk',
    stage: 'stages',
    waiting: 'window',
    target: { kind: 'group', group: GROUP, groupName: 'Bench' },
    things: [A, B],
    canary: { things: [A] },
    stages: [{ things: [B] }],
    createdAt: '2026-11-09T11:00:00Z',
    createdBy: {},
  });
  assert.equal(rollout.waiting, 'window');
  const { state, ctx } = console_();
  state.rollouts = loaded([rollout]);
  assert.match(textOf(draw(fleet.rolloutsPanel(ctx))), /Waiting for the window/);
  const schedule = fleet.readers.readSchedule({ ...scheduled(), id: 'nonsense', status: 'odd' });
  assert.deepEqual([schedule.id, schedule.status], ['', 'failed']);
});

test('the activity log tells scheduled starts in words', () => {
  const entry = (action, outcome = 'ok') => ({
    at: '2026-11-09T12:00:00Z',
    actor: { email: 'manager@example.invalid' },
    action,
    target: SCHEDULE,
    outcome,
    detail: [['kind', 'rollout']],
    requestId: 'x',
  });
  const said = (line) => [line.verb, line.label].join(' ');
  assert.equal(said(core.describeAudit(entry('schedule.create'))), `scheduled the start ${SCHEDULE}`);
  assert.equal(said(core.describeAudit(entry('schedule.edit'))), `changed the scheduled start ${SCHEDULE}`);
  assert.equal(said(core.describeAudit(entry('schedule.cancel'))), `cancelled the scheduled start ${SCHEDULE}`);
  assert.equal(said(core.describeAudit(entry('schedule.start'))), `carried out the scheduled start ${SCHEDULE}`);
  assert.equal(
    said(core.describeAudit(entry('schedule.start', 'rejected'))),
    `could not carry out the scheduled start ${SCHEDULE}`
  );
  assert.ok(core.activityActions('deployments').includes('schedule.start'));
  assert.equal(core.REFUSAL_WORDS.schedule_over, 'The scheduled start has begun, ended or was cancelled');
});
