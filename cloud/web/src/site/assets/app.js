/**
 * The console's entry point: signing in, following the address bar, loading and
 * refreshing what each page shows, and the dialogs that change something.
 *
 * State lives in one object. Whenever it changes the page is drawn again from it;
 * views.js makes that cheap. Requests are refreshed on a schedule that follows what
 * the boards are doing and stops while the tab is in the background.
 */

import {
  ApiError,
  CODE_LENGTH,
  SESSION_CHANNEL,
  SIGNED_OUT_SIGNAL,
  afterUnauthorized,
  alreadyRuns,
  boardChanges,
  boardName,
  boardOf,
  cancelNotice,
  codeComplete,
  createApi,
  createAuth,
  createClock,
  describeExecution,
  deviceActivity,
  enterCode,
  executionActivity,
  isUnderWay,
  isUnfinished,
  keyInCode,
  offeredBoards,
  onlyChoice,
  parseRoute,
  // Search and filters of the long lists (docs/search-filters.md).
  FILTERS,
  activityActions,
  compareThings,
  cleanSearch,
  filtersHash,
  readFilters,
  pollInterval,
  readConfig,
  readImageHeader,
  recordedFilename,
  refreshPlan,
  revocationInPlace,
  revocationNotice,
  routeHash,
  sha256Hex,
  shouldRenew,
  singleLine,
  staleAfter,
  stillFinishing,
  stillRunning,
  stillSettling,
  summaryActivity,
  TOKEN_DAYS,
  toBase64,
  tokenDays,
  uploadInHand,
  versionOfDeployment,
} from './core.js';
import {
  accountView,
  activityView,
  cancelDialog,
  createTokenDialog,
  deployDialog,
  deploymentView,
  deploymentsView,
  deviceView,
  devicesView,
  firmwareView,
  gateView,
  navView,
  notesDialog,
  overviewView,
  render,
  revokeDialog,
  revokeTokenDialog,
  SERIAL_PAGES,
  scriptPending,
  serialPagesHidden,
  signInView,
  toastView,
  tokensView,
} from './views.js';
// The foot of every page: the console's own version (docs/versions.md).
import { footView } from './views.js';
// The map, commands and alerts (docs/fleet.md).
import { COMMAND_ANSWER_MS, IDENTIFY_SECONDS, commandAnswer } from './core.js';

// Board lists, and the lists that another person can change at any time, are also
// refreshed when nothing is being installed, so that they do not go stale. Deployments
// are not: they follow pollInterval() alone.
const IDLE_REFRESH_MS = 30000;
const REDRAW_MS = 15000;
// Pressing twice on what opens a dialog is one wish. The second press lands on the backdrop.
const DOUBLE_CLICK_MS = 350;
// Time to read a message, by its length; never less than the time a short one stays.
const READING_MS_PER_CHARACTER = 80;
const SESSION_CHECK_MS = 5000;
// A refusal this soon after signing in would repeat for ever if sign-in simply restarted.
const FRESH_SIGN_IN_S = 30;
const LARGEST_FILE_READ = 8 * 1024 * 1024;
const ACTIVITY_PAGE = 50;
const RECENT_ENTRIES = 6;
const REQUESTS_AT_ONCE = 4;
const DEPLOYMENTS_ON_OVERVIEW = 4;
// The newest updates of every board (GET /api/updates) that the Overview and the Deployments page show.
const UPDATES_SHOWN = 25;

const main = document.getElementById('main');
const nav = document.getElementById('nav');
const account = document.getElementById('account');
const toasts = document.getElementById('toasts');
// Not in a page from before the footer, or in a test's stand-in for one: then there is none to draw.
const foot = document.getElementById('foot') ?? null;
const announcer = document.getElementById('announcer');

function resource() {
  return { value: null, error: null, loadedAt: 0, loading: false };
}

const state = {
  gate: null,
  // The console's own sign-in page while it is shown (gate.signIn): never the password.
  signIn: null,
  me: null,
  route: { view: 'overview' },
  now: Date.now(),
  interval: 0,
  sessionLeft: 0,
  devices: resource(),
  firmware: resource(),
  deployments: resource(),
  // Every update of every board however it came, newest first (GET /api/updates); and of one board, by thing.
  updates: resource(),
  boardUpdates: new Map(),
  recent: resource(),
  audit: { ...resource(), loadingMore: false, moreError: null },
  commits: resource(),
  // The caller's own API tokens: never a token itself, which only its dialog holds, once.
  tokens: resource(),
  // This console's address, for the example on the API tokens page.
  origin: typeof window.location?.origin === 'string' ? window.location.origin : '',
  scriptFailed: false,
  deviceDetails: new Map(),
  deploymentDetails: new Map(),
  upload: { stage: 'idle', over: false },
  // The map, commands and alerts (docs/fleet.md): each board's last positions, by thing; the last
  // command sent to each board from this tab and what became of it; the caller's own e-mail alerts.
  positions: new Map(),
  commands: new Map(),
  alerts: { ...resource(), busy: false },
  // The phone apps (apps.js): what GET /api/apps says, and versions.json, which the History page reads too.
  apps: resource(),
  versions: resource(),
  // The Release notes page's release-notes.json (release-notes.js): every version of every product in full.
  releaseNotes: resource(),
  // In the phone app: what it offers (bridge.js), and the line that says which app and which pages. Null on the website.
  app: null,
  // Whether the live API's WebSocket is open (live.js, docs/live.md): the page then hears of changes at once.
  liveUpdates: false,
  // On a phone, whether the sheet of the sections that are not tabs is open (views.js navView).
  moreOpen: false,
  // Each long list's search and filters (docs/search-filters.md), by page: what the address says after its ?,
  // the search as it is typed. And whether the filters are unfolded on a phone.
  filters: {},
  filtersOpen: false,
  // The board whose QR code and label its page shows (labels.js), or null.
  labelShown: null,
  // The boards ticked on the Devices page, in the order they were ticked: for Compare (compare.js).
  selected: [],
};

const clock = createClock();
let auth = null;
let api = null;
let dialog = null;
// The phone app's bridge and configuration, in the app only (bridge.js, docs/mobile-apps.md "The app shell").
// bridge.js itself is fetched only in the app, so that the website's cold load stays as it was.
let bridgeScript = null;
let appBridge = null;
let appConfig = null;
// Live updates (live.js, docs/live.md): the live API's address from the page's settings, and the client,
// fetched once the console is shown, like fleet.js. Without an address the console only polls.
let liveUrl = null;
let live = null;
let liveQueued = false;

/** Tell the app the pages have started, so that it keeps this bundle as a good one. Once. */
let toldReady = false;
function pagesReady() {
  if (toldReady || !appBridge) return;
  toldReady = true;
  appBridge.call('app.ready').catch(() => {});
}

// Drawing.

let drawQueued = false;

/**
 * Draw, and keep the keyboard's place if the control that had the focus goes away with
 * what changed. It goes to the part of the page the control belonged to, or else to the
 * page's title, instead of falling out of the page.
 */
function keepingFocus(drawing) {
  const before = document.activeElement;
  const home = before?.closest?.('[data-focus-home]') ?? null;
  drawing();
  if (!before || before === document.body || before.isConnected) return;
  const now = document.activeElement;
  if (now && now !== before && now !== document.body) return;
  (home?.isConnected ? home : document.getElementById('page-title'))?.focus({ preventScroll: true });
}

// What the boards last said, by board, to tell a screen reader when that changes. The
// page of a deployment has live regions of its own, one per board.
let heard = new Map();

function announceBoards() {
  const { view, thing } = state.route;
  const detail = view === 'device' ? state.deviceDetails.get(thing)?.value : null;
  const devices = detail ? [detail.device] : (state.devices.value?.devices ?? []);
  const { seen, said } = boardChanges(heard, devices);
  heard = new Map([...heard, ...seen]);
  if (said.length > 0 && view !== 'deployment' && announcer) announcer.textContent = said.join(' ');
}

function paint() {
  drawQueued = false;
  state.now = clock.now();
  // The app's frame (console 2.7): the sidebar or the tab bar, only around the pages themselves.
  document.body?.classList?.toggle('is-framed', !state.gate);
  if (state.gate) {
    nav.hidden = true;
    account.hidden = true;
    if (foot) foot.hidden = true;
    const node = state.gate.signIn ? signInView(signInModel()) : gateView(state.gate);
    node.key = state.gate.signIn ? 'sign-in' : 'gate';
    render(main, node);
    return;
  }
  state.sessionLeft = auth.secondsLeft();
  // `fleet` is fleet.js once it is here: board types, groups and staged rollouts on every page.
  // `memfault` is memfault-page.js once it is here: a board's reboots, events and issues in Memfault.
  // `labels` is labels.js once a board's page has asked for its QR code and label.
  // `compare` is compare.js once it is here: a board's version timeline, and the Compare page.
  const ctx = {
    state,
    actions,
    fleet: fleetScript,
    memfault: memfaultScript,
    labels: labelsScript,
    compare: compareScript,
  };
  nav.hidden = false;
  account.hidden = false;
  render(nav, navView(ctx));
  render(account, accountView(ctx));
  if (foot) {
    foot.hidden = false;
    render(foot, footView(ctx));
  }
  let node;
  try {
    node = pages[state.route.view].view(ctx);
  } catch (error) {
    // A fault in a view must not leave a blank or half-drawn page behind.
    console.error(error);
    node = gateView({
      iconName: 'alert',
      title: 'This page could not be shown',
      text:
        'The console ran into a problem of its own. Reload the page; if it happens again, ' +
        'report which page it was.',
      action: { label: 'Reload', run: () => location.reload() },
    });
  }
  node.key = routeHash(state.route);
  keepingFocus(() => render(main, node));
  // A board's page is titled by the board's name, which may arrive after the page opened.
  const title = pageTitle(state.route);
  if (document.title !== title) document.title = title;
  watchTitle();
  pages[state.route.view].painted?.();
  // The maps of the Map page and of a board's page, once map.js is here (Leaflet keeps its own DOM).
  mapScript?.sync(state);
  announceBoards();
  if (dialogOpen()) dialog.redraw();
}

// The large title (console 2.7): on a phone the page's own heading stands large under the top bar,
// and once it has scrolled away the bar shows it, small. Only the eye needs this; the heading
// itself is what a screen reader reads, so the bar's copy is hidden from it (index.html).
let titleWatcher = null;
let titleWatched = null;

function watchTitle() {
  const bar = document.getElementById('masthead-title');
  const heading = document.getElementById('page-title');
  if (!bar || !heading) return;
  const words = heading.textContent ?? '';
  if (bar.textContent !== words) bar.textContent = words;
  if (heading === titleWatched || typeof window.IntersectionObserver !== 'function') return;
  titleWatcher?.disconnect();
  titleWatched = heading;
  titleWatcher = new window.IntersectionObserver(
    ([entry]) => document.body.classList.toggle('is-scrolled', !entry.isIntersecting),
    { rootMargin: '-56px 0px 0px 0px' }
  );
  titleWatcher.observe(heading);
}

/** Opens or closes the sheet of the other sections; closing it gives the keyboard back to More. */
function showMore(open) {
  if (state.moreOpen === open) return;
  state.moreOpen = open;
  paint();
  if (open) nav.querySelector('.nav-sheet-link')?.focus();
  else nav.querySelector('.nav-more-toggle')?.focus({ preventScroll: true });
}

/** The tab's title for a route. */
function pageTitle(route) {
  const { title } = pages[route.view];
  return `${typeof title === 'function' ? title(route) : title} · Cranium`;
}

/** A board by its thing name, as its own page or else the list of boards last read it. */
function knownBoard(thing) {
  return state.deviceDetails.get(thing)?.value?.device ?? boardOf(thing, state.devices.value?.devices);
}

function draw() {
  if (drawQueued) return;
  drawQueued = true;
  queueMicrotask(paint);
}

function showGate(gate) {
  state.gate = gate;
  clearTimeout(timer);
  if (dialog) dialog.close(true);
  document.title = 'Cranium · Firmware console';
  paint();
}

// The toasts on the page, by what they say: the same message twice is one message, for longer.
const toastsShown = new Map();

function notify(message, tone = 'good') {
  const name = `${tone} ${message}`;
  if (toastsShown.has(name)) {
    toastsShown.get(name)();
    return;
  }
  const toast = document.createElement('div');
  toast.className = `toast is-${tone}`;
  let expiry = 0;
  // Where the keyboard came from, if it has come here: it goes back when the toast is gone.
  let cameFrom = null;
  const dismiss = () => {
    clearTimeout(expiry);
    const held = toast.contains(document.activeElement);
    toastsShown.delete(name);
    toast.remove();
    if (held)
      (cameFrom?.isConnected ? cameFrom : document.getElementById('page-title'))?.focus({ preventScroll: true });
  };
  const stay = Math.max(tone === 'good' ? 5000 : 12000, message.length * READING_MS_PER_CHARACTER);
  const countDown = () => {
    clearTimeout(expiry);
    expiry = setTimeout(dismiss, stay);
  };
  const hold = () => clearTimeout(expiry);
  render(toast, toastView(message, dismiss));
  // Not while it is being read, or while its button has the focus.
  toast.addEventListener('mouseenter', hold);
  toast.addEventListener('focusin', (event) => {
    hold();
    if (!toast.contains(event.relatedTarget)) cameFrom = event.relatedTarget;
  });
  toast.addEventListener('mouseleave', countDown);
  toast.addEventListener('focusout', countDown);
  toasts.append(toast);
  toastsShown.set(name, countDown);
  countDown();
}

/** Anything thrown that is not the API's doing is a fault in the console itself. */
function asProblem(error) {
  if (error instanceof ApiError) return error;
  console.error(error);
  return new ApiError(0, 'console', 'The console ran into a problem of its own. Reload the page.');
}

// Loading.

async function load(target, fetcher) {
  target.loading = true;
  draw();
  try {
    target.value = await fetcher();
    target.error = null;
    target.loadedAt = clock.now();
  } catch (error) {
    target.error = asProblem(error);
  } finally {
    target.loading = false;
    draw();
  }
}

function entry(map, key) {
  let item = map.get(key);
  if (!item) {
    item = resource();
    map.set(key, item);
  }
  return item;
}

function keep(map, key, value) {
  const item = entry(map, key);
  item.value = value;
  item.error = null;
  item.loadedAt = clock.now();
}

/** Run a task for every item, a few at a time. */
async function each(items, task) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(REQUESTS_AT_ONCE, queue.length) }, async () => {
    while (queue.length > 0) await task(queue.shift());
  });
  await Promise.all(workers);
}

function due(target, full) {
  return full || target.loadedAt === 0 || clock.now() - target.loadedAt >= IDLE_REFRESH_MS - 2000;
}

/** The deployments whose boards the overview follows one by one: those with a board still at it. */
function activeDeployments() {
  const devices = state.devices.value?.devices ?? [];
  return (state.deployments.value ?? [])
    .filter((deployment) => isUnderWay(deployment) || stillFinishing(deployment, devices, clock.now()))
    .slice(0, DEPLOYMENTS_ON_OVERVIEW);
}

function phasesOf(deployment) {
  if (!deployment) return '';
  return deployment.executions.map((execution) => `${execution.thing}:${execution.phase}`).join(' ');
}

/** The boards and the open deployments as pollInterval takes them. */
function fleetActivity() {
  const devices = state.devices.value?.devices ?? [];
  const statuses = devices.map(deviceActivity);
  for (const deployment of activeDeployments()) {
    const detail = state.deploymentDetails.get(deployment.id)?.value;
    if (detail) statuses.push(...detail.executions.map(executionActivity));
    else statuses.push(summaryActivity(deployment, devices));
    // Cancelled, with a board that is still restarting: AWS has nothing more to say, and it is not over.
    if (!isUnderWay(deployment)) statuses.push('IN_PROGRESS');
  }
  return statuses;
}

/** Read the record of each open deployment: the list only says how many boards do what. */
function readActiveDeployments() {
  return each(activeDeployments(), (deployment) =>
    load(entry(state.deploymentDetails, deployment.id), () => api.deployment(deployment.id))
  );
}

/** True while a cancelled deployment can still change what one of its boards runs. */
function settling(deployment) {
  const devices = state.devices.value?.devices ?? [];
  return deployment.executions.some((execution) =>
    stillSettling(
      execution,
      devices.find((device) => device.thing === execution.thing),
      deployment.id,
      clock.now()
    )
  );
}

/** True while the page of a deployment that is over invites somebody to offer its release again. */
function canBeOfferedAgain(detail) {
  const devices = state.devices.value?.devices ?? [];
  const release = state.firmware.value?.releases.find((item) => item.version === detail.version);
  if (release && release.status !== 'active') return false;
  return detail.executions.some(
    (execution) =>
      describeExecution(execution, {
        board: devices.find((device) => device.thing === execution.thing) ?? null,
        deployment: detail.id,
        version: detail.version,
        history: null,
        unread: state.devices.value === null,
      }).retry
  );
}

// One entry per page: how it is drawn, what it loads, and how soon to load it again
// (0 for never). `full` is false for a scheduled refresh, which skips what cannot
// have changed much. `holdStill` says that a scheduled refresh would be in the way.
const pages = {
  overview: {
    title: 'Overview',
    view: overviewView,
    resources: () => [state.devices, state.deployments, state.firmware, state.recent],
    async refresh(full) {
      await Promise.all([
        load(state.devices, api.devices),
        load(state.deployments, api.deployments),
        due(state.firmware, full) ? load(state.firmware, api.firmware) : null,
        due(state.recent, full) ? load(state.recent, () => api.audit({ limit: RECENT_ENTRIES })) : null,
        // What the boards installed, however it came: read as seldom as the releases.
        due(state.updates, full) ? load(state.updates, () => api.updates({ limit: UPDATES_SHOWN })) : null,
      ]);
      // The list says how many boards are in each state, not which board is doing
      // what. That comes from each unfinished deployment's own record.
      await readActiveDeployments();
    },
    interval: () => pollInterval(fleetActivity()) || IDLE_REFRESH_MS,
  },
  devices: {
    title: 'Devices',
    view: devicesView,
    resources: () => [state.devices],
    async refresh(full) {
      await Promise.all([
        load(state.devices, api.devices),
        load(state.deployments, api.deployments),
        due(state.firmware, full) ? load(state.firmware, api.firmware) : null,
      ]);
      // A board that is offline cannot report an offer. Its deployment's record says it has one.
      await readActiveDeployments();
    },
    interval: () => pollInterval(fleetActivity()) || IDLE_REFRESH_MS,
  },
  device: {
    title: (route) => boardName(knownBoard(route.thing), { short: true }),
    view: deviceView,
    resources: () => [entry(state.deviceDetails, state.route.thing)],
    async refresh(full) {
      const { thing } = state.route;
      const own = entry(state.boardUpdates, thing);
      await Promise.all([
        load(entry(state.deviceDetails, thing), () => api.device(thing)),
        due(state.firmware, full) ? load(state.firmware, api.firmware) : null,
        due(own, full) ? load(own, () => api.updates({ thing, limit: UPDATES_SHOWN })) : null,
        // What Memfault knows of it (memfault-page.js): read a minute apart at most.
        memfaultReady().then((script) => script?.refreshBoard(thing, full)),
        // Every version it ran (compare.js): read a minute apart at most.
        compareReady().then((script) => script?.refreshTimeline(thing, full)),
      ]);
      // The board's own page says its last update: when that is not the list's newest, the list is behind.
      const last = state.deviceDetails.get(thing)?.value?.lastUpdate ?? null;
      if (
        last !== null &&
        own.value !== null &&
        own.value.updates[0]?.id !== last.id &&
        own.value.updates[0]?.endedAt !== last.endedAt
      ) {
        await load(own, () => api.updates({ thing, limit: UPDATES_SHOWN }));
      }
    },
    interval() {
      const detail = state.deviceDetails.get(state.route.thing)?.value;
      return detail ? pollInterval([deviceActivity(detail.device)]) || IDLE_REFRESH_MS : 0;
    },
  },
  firmware: {
    title: 'Firmware',
    view: firmwareView,
    resources: () => [state.firmware],
    refresh: () =>
      Promise.all([
        load(state.firmware, api.firmware),
        // Whether the release that was just uploaded has been deployed since.
        state.upload.stage === 'done' ? load(state.deployments, api.deployments) : null,
      ]),
    interval: () => IDLE_REFRESH_MS,
    // A release that changes under an open dialog or a file in hand can wait for a moment.
    holdStill: () => dialogOpen() || uploadInHand(state.upload.stage),
  },
  deployments: {
    title: 'Deployments',
    view: deploymentsView,
    resources: () => [state.deployments],
    async refresh(full) {
      await Promise.all([
        load(state.deployments, api.deployments),
        due(state.firmware, full) ? load(state.firmware, api.firmware) : null,
        due(state.updates, full) ? load(state.updates, () => api.updates({ limit: UPDATES_SHOWN })) : null,
      ]);
      // Which waiting board needs its button pressed, and which boards are online.
      if ((state.deployments.value ?? []).some(isUnderWay)) await load(state.devices, api.devices);
    },
    interval() {
      const devices = state.devices.value?.devices ?? [];
      return pollInterval((state.deployments.value ?? []).map((item) => summaryActivity(item, devices)));
    },
  },
  deployment: {
    title(route) {
      const version = versionOfDeployment(route.id);
      return version ? `Deployment of ${version}` : 'Deployment';
    },
    view: deploymentView,
    resources: () => [entry(state.deploymentDetails, state.route.id)],
    async refresh(full) {
      const { id } = state.route;
      const target = entry(state.deploymentDetails, id);
      const before = phasesOf(target.value);
      await Promise.all([
        load(target, () => api.deployment(id)),
        // Whether the release is still there to be offered again, or was revoked.
        due(state.firmware, full) ? load(state.firmware, api.firmware) : null,
      ]);
      const detail = target.value;
      // The board list adds when an offline board was last seen and what it runs now.
      // It only needs reading again when a board has moved on, or may be about to.
      const moved = phasesOf(detail) !== before || (detail !== null && settling(detail));
      if (full || state.devices.loadedAt === 0 || moved) await load(state.devices, api.devices);
      // A board that runs what was cancelled may have got it from another deployment.
      // Its own list of updates says, and the deployment's record does not. A copy from
      // before the board ran it cannot say, and a read that failed is tried again.
      const runningIt = (detail?.executions ?? []).filter(
        (execution) => execution.status === 'CANCELED' && execution.reported === detail.version
      );
      await each(runningIt, (execution) => {
        const known = entry(state.deviceDetails, execution.thing);
        const outdated = known.error !== null || known.value?.device.fw?.version !== execution.reported;
        return full || outdated ? load(known, () => api.device(execution.thing)) : null;
      });
      // Who cancelled it is in the log and not in the deployment's record: the whole log, not a search of it.
      if (detail?.status === 'CANCELED' && (due(state.audit, full) || state.audit.value?.filtered)) {
        await load(state.audit, () => api.audit({ limit: ACTIVITY_PAGE }));
      }
    },
    interval() {
      const detail = state.deploymentDetails.get(state.route.id)?.value;
      if (!detail) return 0;
      const statuses = detail.executions.map(executionActivity);
      if (settling(detail)) statuses.push('IN_PROGRESS');
      // While it can be offered again, somebody else can revoke its release: the page would then say so.
      return pollInterval(statuses) || (canBeOfferedAgain(detail) ? IDLE_REFRESH_MS : 0);
    },
  },
  activity: {
    title: 'Activity',
    view: activityView,
    resources: () => [state.audit],
    async refresh(full) {
      const asked = activityQuery();
      await Promise.all([
        load(state.audit, async () => ({
          ...(await api.audit({ limit: ACTIVITY_PAGE, ...asked })),
          filtered: Object.keys(asked).length > 0,
        })),
        // How a deployment ended is not in the log: it follows from the deployment.
        due(state.deployments, full) ? load(state.deployments, api.deployments) : null,
      ]);
      // An entry that names a board has its thing name, or for a command at its serial console its own
      // name; what the board is called now, and which board has that name, is in the list of boards.
      const namesBoard = (state.audit.value?.entries ?? []).some(
        (item) =>
          item.detail.some(([key]) => key === 'thing' || key === 'boards') ||
          (item.action === 'serial.command' && item.target)
      );
      if (namesBoard && state.devices.loadedAt === 0) await load(state.devices, api.devices);
    },
    interval: () => IDLE_REFRESH_MS,
    // Reading the first page again would take away the pages loaded by hand.
    holdStill: () => state.audit.loadingMore || (state.audit.value?.entries.length ?? 0) > ACTIVITY_PAGE,
  },
  // What the boards did, and how they are now. The two pages share a script (telemetry.js),
  // fetched when either is opened, so a cold load stays at five requests.
  events: {
    title: 'Events',
    view: (ctx) =>
      telemetryScript ? telemetryScript.eventsView(ctx) : scriptPending(ctx, 'events', 'Events', { tabs: false }),
    resources: () => telemetryScript?.eventsResources(state) ?? [],
    async refresh(full) {
      if (await telemetry()) await telemetryScript.refreshEvents(full);
      draw();
    },
    interval: () => telemetryScript?.eventsInterval(state) ?? 0,
    holdStill: () => telemetryScript?.eventsHoldStill(state) ?? false,
  },
  diagnostics: {
    title: (route) =>
      route.thing ? `Diagnostics of ${boardName(knownBoard(route.thing), { short: true })}` : 'Diagnostics',
    view: (ctx) =>
      telemetryScript
        ? telemetryScript.diagnosticsView(ctx)
        : scriptPending(ctx, 'diagnostics', 'Diagnostics', { tabs: false }),
    resources: () => telemetryScript?.diagnosticsResources(state) ?? [],
    async refresh(full) {
      if (await telemetry()) await telemetryScript.refreshDiagnostics(full);
      draw();
    },
    interval: () => (telemetryScript ? telemetryScript.DIAGNOSTICS_REFRESH_MS : 0),
    // The time since each board's last heartbeat is counted up every second.
    everySecond: true,
  },
  // These two load their script when they are opened, so a cold load stays at five requests.
  // The serial console talks to a board and never to the API.
  serial: {
    title: 'Serial console',
    view: (ctx) => (serialScript ? serialScript.serialView(ctx) : scriptPending(ctx, 'serial', 'Serial console')),
    resources: () => [],
    async refresh() {
      serialScript ??= await pageScript(() => import('./serial.js'));
      draw();
    },
    interval: () => 0,
    painted: () => serialScript?.keepTranscriptInView(),
  },
  // Board setup over USB (setup.js): serial recovery, the golden image, and provisioning, from this page.
  setup: {
    title: 'Board setup',
    view: (ctx) => (setupScript ? setupScript.setupView(ctx) : scriptPending(ctx, 'setup', 'Board setup')),
    resources: () => [],
    async refresh() {
      if (!setupScript) {
        setupScript = await pageScript(() => import('./setup.js'));
        setupScript?.connect({ api, draw });
      }
      draw();
    },
    interval: () => 0,
  },
  history: {
    title: 'History',
    view: (ctx) => (historyScript ? historyScript.historyView(ctx) : scriptPending(ctx, 'history', 'History')),
    resources: () => [state.commits],
    async refresh() {
      historyScript ??= await pageScript(() => import('./history.js'));
      if (historyScript && !state.commits.value) {
        await load(state.commits, () => historyScript.readHistory(window.fetch.bind(window)));
      }
      // What's new: the console's versions with their notes, from versions.json beside history.json.
      if (historyScript && !state.versions.value) {
        await load(state.versions, () => historyScript.readVersions(window.fetch.bind(window)));
      }
      draw();
    },
    interval: () => 0,
  },
  // Every version of every product, one tab each (release-notes.js), from release-notes.json beside it.
  'release-notes': {
    title: 'Release notes',
    view: (ctx) =>
      releaseNotesScript
        ? releaseNotesScript.releaseNotesView(ctx)
        : scriptPending(ctx, 'release-notes', 'Release notes'),
    resources: () => [state.releaseNotes],
    async refresh() {
      releaseNotesScript ??= await pageScript(() => import('./release-notes.js'));
      if (releaseNotesScript && !state.releaseNotes.value) {
        await load(state.releaseNotes, () => releaseNotesScript.readReleaseNotes(window.fetch.bind(window)));
      }
      draw();
    },
    interval: () => 0,
    // On a phone the chosen tab is scrolled into view, and the strip's edges fade where more tabs lie.
    painted: () => releaseNotesScript?.keepTabInView(),
  },
  // The phone apps: the Android app to download, the iPhone app to build, and how (apps.js).
  apps: {
    title: 'Apps',
    view: (ctx) => (appsScript ? appsScript.appsView(ctx) : scriptPending(ctx, 'apps', 'Apps', { tabs: false })),
    resources: () => appsScript?.appsResources(state) ?? [],
    async refresh() {
      if (await appsReady()) await appsScript.refreshApps();
      draw();
    },
    interval: () => appsScript?.appsInterval() ?? 0,
  },
  // What Memfault knows of the boards: its issues, and an issue's traces (memfault-page.js).
  memfault: {
    title: 'Memfault',
    view: (ctx) =>
      memfaultScript ? memfaultScript.memfaultView(ctx) : scriptPending(ctx, 'memfault', 'Memfault', { tabs: false }),
    resources: () => memfaultScript?.memfaultResources(state) ?? [],
    async refresh() {
      if (await memfaultReady()) await memfaultScript.refreshMemfault();
      draw();
    },
    interval: () => (memfaultScript ? memfaultScript.MEMFAULT_REFRESH_MS : 0),
  },
  issue: {
    title: (route) => `Memfault issue ${route.id}`,
    view: (ctx) =>
      memfaultScript
        ? memfaultScript.issueView(ctx)
        : scriptPending(ctx, 'memfault', 'Memfault issue', { tabs: false }),
    resources: () => memfaultScript?.issueResources(state) ?? [],
    async refresh() {
      if (await memfaultReady()) await memfaultScript.refreshIssue();
      draw();
    },
    interval: () => (memfaultScript ? memfaultScript.MEMFAULT_REFRESH_MS : 0),
  },
  // The weekly fleet report (reports.js, docs/reports.md): the weeks, and a week's printable page.
  reports: {
    title: 'Reports',
    view: (ctx) =>
      reportsScript ? reportsScript.reportsView(ctx) : scriptPending(ctx, 'reports', 'Reports', { tabs: false }),
    resources: () => reportsScript?.listResources() ?? [],
    async refresh() {
      if (await reportsReady()) await reportsScript.refreshReports();
      draw();
    },
    interval: () => IDLE_REFRESH_MS,
    holdStill: () => reportsScript?.holdStill() ?? false,
  },
  report: {
    title: (route) => `Weekly report ${route.week}`,
    view: (ctx) =>
      reportsScript ? reportsScript.reportView(ctx) : scriptPending(ctx, 'reports', 'Weekly report', { tabs: false }),
    resources: () => reportsScript?.reportResources(state) ?? [],
    async refresh(full) {
      if (await reportsReady()) await reportsScript.refreshReport(state.route.week, full);
      draw();
    },
    interval: () => IDLE_REFRESH_MS,
    holdStill: () => reportsScript?.holdStill() ?? false,
  },
  // Two to four boards side by side, with their version timelines (compare.js).
  compare: {
    title: 'Compare boards',
    view: (ctx) =>
      compareScript ? compareScript.compareView(ctx) : scriptPending(ctx, 'compare', 'Compare boards', { tabs: false }),
    resources: () => [state.devices],
    async refresh(full) {
      if (await compareReady()) await compareScript.refreshCompare(compareThings(state.filters.compare), full);
      draw();
    },
    interval: () => IDLE_REFRESH_MS,
  },
  // Board types, groups, staged rollouts and "Update everything" (fleet.js).
  fleet: {
    title: 'Fleet',
    view: (ctx) => (fleetScript ? fleetScript.fleetView(ctx) : scriptPending(ctx, 'fleet', 'Fleet', { tabs: false })),
    resources: () => fleetScript?.fleetResources(state) ?? [],
    async refresh(full) {
      if (await fleetReady()) await fleetScript.refreshFleet(full);
      draw();
    },
    interval: () => fleetScript?.fleetInterval(state) ?? 0,
    holdStill: () => dialogOpen(),
  },
  rollout: {
    title: (route) => fleetScript?.rolloutTitle(route, state) ?? 'Staged rollout',
    view: (ctx) =>
      fleetScript ? fleetScript.rolloutView(ctx) : scriptPending(ctx, 'rollout', 'Staged rollout', { tabs: false }),
    resources: () => fleetScript?.rolloutResources(state) ?? [],
    async refresh(full) {
      if (await fleetReady()) await fleetScript.refreshRollout(full);
      draw();
    },
    interval: () => fleetScript?.rolloutInterval(state) ?? 0,
    holdStill: () => dialogOpen(),
  },
  // Every board where the Wi-Fi it hears puts it (map.js, with Leaflet, fetched when the page opens).
  map: {
    title: 'Map',
    view: (ctx) => (mapScript ? mapScript.mapView(ctx) : scriptPending(ctx, 'map', 'Map', { tabs: false })),
    resources: () => [state.devices],
    async refresh() {
      await Promise.all([mapReady(), load(state.devices, api.devices)]);
      draw();
    },
    interval: () => IDLE_REFRESH_MS,
  },
  // Who is signed in, and their e-mail alerts (account.js).
  account: {
    title: 'Account',
    view: (ctx) =>
      accountScript ? accountScript.accountPageView(ctx) : scriptPending(ctx, 'account', 'Account', { tabs: false }),
    resources: () => [state.alerts],
    async refresh() {
      accountScript ??= await accountReady();
      await load(state.alerts, api.alerts);
      draw();
    },
    interval: () => IDLE_REFRESH_MS,
    holdStill: () => state.alerts.busy,
  },
  // The alert rules and the alerts that went out (account.js): every member reads them, a release
  // manager changes the rules.
  alerts: {
    title: 'Alerts',
    view: (ctx) =>
      accountScript ? accountScript.alertsPageView(ctx) : scriptPending(ctx, 'alerts', 'Alerts', { tabs: false }),
    resources: () => [state.alerts],
    async refresh() {
      accountScript ??= await accountReady();
      await Promise.all([
        load(state.alerts, api.alerts),
        state.devices.loadedAt === 0 ? load(state.devices, api.devices) : null,
      ]);
      draw();
    },
    interval: () => IDLE_REFRESH_MS,
    holdStill: () => state.alerts.busy || state.alerts.editing === true,
  },
  // An update over Bluetooth, in the phone app only (bluetooth.js): the classic apps' Bluetooth screens.
  bluetooth: {
    title: 'Bluetooth',
    view: (ctx) =>
      bluetoothScript
        ? bluetoothScript.bluetoothView({ ...ctx, bluetooth: bluetoothFlow })
        : scriptPending(ctx, 'bluetooth', 'Update over Bluetooth', { tabs: false }),
    resources: () => [state.firmware],
    async refresh(full) {
      await bluetoothReady();
      await Promise.all([
        load(state.firmware, api.firmware),
        due(state.devices, full) ? load(state.devices, api.devices) : null,
      ]);
      bluetoothFlow?.setReleases(state.firmware.value?.releases ?? []);
      draw();
    },
    // The list of releases is read again only while nothing is under way with a board.
    interval: () => (bluetoothFlow && bluetoothFlow.flow.step !== 'release' ? 0 : IDLE_REFRESH_MS),
    holdStill: () => bluetoothFlow?.flow.busy === true,
    everySecond: true,
  },
  // Read again now and then, so that a token that runs out reads as expired.
  tokens: {
    title: 'API tokens',
    view: tokensView,
    resources: () => [state.tokens],
    refresh: () => load(state.tokens, api.tokens),
    interval: () => IDLE_REFRESH_MS,
    holdStill: () => dialogOpen(),
  },
  // The console's DynamoDB tables, read only, for release managers (db-page.js, docs/database.md). Read
  // when opened and by hand, never by a timer: every read costs a Query or a Scan of one page.
  database: {
    title: (route) => (route.table ? `Database: ${route.table}` : 'Database'),
    view: (ctx) => (dbScript ? dbScript.databaseView(ctx) : scriptPending(ctx, 'database', 'Database')),
    resources: () => dbScript?.databaseResources(state) ?? [],
    async refresh(full) {
      if (!dbScript) {
        dbScript = await pageScript(() => import('./db-page.js'));
        // In an app, an export goes to the app's share sheet or save dialog where it has one (file.share).
        dbScript?.connect({
          state,
          api,
          load,
          draw,
          inApp: appBridge !== null,
          share: appBridge?.has('share') ? (file) => appBridge.call('file.share', file) : null,
        });
      }
      if (dbScript) await dbScript.refreshDatabase(full);
      draw();
    },
    interval: () => 0,
    holdStill: () => dbScript?.holdStill() ?? false,
  },
  // The customer site's customers and their boards (docs/customer-site.md), for release managers.
  // Its script is fetched when the page is opened, like the serial console's.
  customers: {
    title: 'Customers',
    view: (ctx) =>
      customersScript
        ? customersScript.customersView(ctx)
        : scriptPending(ctx, 'customers', 'Customers', { tabs: false }),
    resources: () => customersScript?.resources(state) ?? [],
    async refresh(full) {
      if (!customersScript) {
        customersScript = await pageScript(() => import('./customers.js'));
        customersScript?.connect({ state, api, load, draw, notify, clock });
      }
      if (customersScript) await customersScript.refresh(full);
      draw();
    },
    interval: () => IDLE_REFRESH_MS,
    holdStill: () => customersScript?.holdStill() ?? false,
  },
  // The team's accounts (docs/accounts.md), for release managers. Fetched when the page is opened; its changes
  // go through the console's dialogs.
  team: {
    title: 'Team',
    view: (ctx) => (teamScript ? teamScript.teamView(ctx) : scriptPending(ctx, 'team', 'Team', { tabs: false })),
    resources: () => teamScript?.resources() ?? [],
    async refresh() {
      if (!teamScript) {
        teamScript = await pageScript(() => import('./team.js'));
        teamScript?.connect({
          state,
          api,
          load,
          draw,
          notify,
          dialogs: { open: openDialog, submit: submitFrom, isOpen: dialogOpen, signIn: beginSignIn },
        });
      }
      if (teamScript) await teamScript.refresh();
      draw();
    },
    interval: () => IDLE_REFRESH_MS,
    holdStill: () => teamScript?.holdStill() ?? false,
  },
};

let serialScript = null;
let setupScript = null;
let historyScript = null;
let releaseNotesScript = null;
let bluetoothScript = null;
let bluetoothFlow = null;

/** bluetooth.js, fetched once, and its flow, which lives as long as the page: leaving the page does not stop a send. */
async function bluetoothReady() {
  bluetoothScript ??= await pageScript(() => import('./bluetooth.js'));
  if (bluetoothScript && !bluetoothFlow && appBridge?.has('ble')) {
    bluetoothFlow = bluetoothScript.createBluetoothFlow({
      api,
      bridge: appBridge,
      now: () => clock.now(),
      onChange: draw,
      devices: () => state.devices.value?.devices ?? [],
      device: state.app?.device ?? 'device',
    });
  }
  return bluetoothScript;
}
let telemetryScript = null;
let mapScript = null;
let accountScript = null;
/** account.js, fetched once, for the Account page and the Alerts page. */
const accountReady = () => pageScript(() => import('./account.js'));
let appsScript = null;

/** apps.js, fetched once, when the Apps page is first opened, and handed what it needs. */
async function appsReady() {
  if (!appsScript) {
    appsScript = await pageScript(() => import('./apps.js'));
    appsScript?.connect({ state, api, load, draw, notify });
  }
  return appsScript;
}

/** map.js, fetched once: the Map page, and the map on a board's page. */
async function mapReady() {
  if (!mapScript) {
    mapScript = await pageScript(() => import('./map.js'));
    mapScript?.connect({ draw });
  }
  return mapScript;
}

/** A board's page, for a board with a position: its last positions, and the script that draws them. */
async function boardLocation(full) {
  if (state.route.view !== 'device' || !knownBoard(state.route.thing)?.position) return;
  const { thing } = state.route;
  const target = entry(state.positions, thing);
  await Promise.all([mapReady(), due(target, full) ? load(target, () => api.positions(thing)) : null]);
}
let fleetScript = null;
let fleetLoading = null;

/**
 * fleet.js, fetched once, when the console first shows a page, and handed what it needs. Every page
 * shows something of the fleet: a board's type and groups, the fleet's health, the staged
 * rollouts. Until it is here, or if it cannot be fetched, the pages are as they were without it.
 */
function fleetReady() {
  fleetLoading ??= import('./fleet.js')
    .then((module) => {
      fleetScript = module;
      module.connect({
        state,
        api,
        load,
        draw,
        clock,
        refresh: () => refreshNow(true),
        notify,
        keep,
        dialogs: { open: openDialog, submit: submitFrom, isOpen: dialogOpen, signIn: beginSignIn },
        go: (route) => {
          location.hash = routeHash(route);
        },
      });
      draw();
      return module;
    })
    .catch((error) => {
      console.error(error);
      fleetLoading = null;
      return null;
    });
  return fleetLoading;
}
let customersScript = null;
let teamScript = null;
let dbScript = null;
let memfaultScript = null;
let labelsScript = null;
let compareScript = null;
let reportsScript = null;

/** reports.js, fetched once, when the Reports page or a week's report is first opened. */
async function reportsReady() {
  if (!reportsScript) {
    reportsScript = await pageScript(() => import('./reports.js'));
    // In an app, the CSV goes to the app's share sheet or save dialog where it has one (file.share).
    reportsScript?.connect({
      state,
      api,
      load,
      draw,
      notify,
      now: () => clock.now(),
      inApp: appBridge !== null,
      share: appBridge?.has('share') ? (file) => appBridge.call('file.share', file) : null,
      print: () => window.print(),
    });
  }
  return reportsScript;
}

/** compare.js, fetched once, when a board's page or the Compare page is first opened. */
async function compareReady() {
  if (!compareScript) {
    compareScript = await pageScript(() => import('./compare.js'));
    compareScript?.connect({ state, api, load, draw, now: () => clock.now(), memfault: memfaultReady });
  }
  return compareScript;
}

/** A board ticked or unticked on the Devices page. */
function toggleSelected(thing) {
  state.selected = state.selected.includes(thing)
    ? state.selected.filter((one) => one !== thing)
    : [...state.selected, thing];
  draw();
}

/** labels.js, fetched once, when a board's page first shows its QR code and label. */
async function labelsReady() {
  labelsScript ??= await pageScript(() => import('./labels.js'));
  return labelsScript;
}

/** A board's QR code and label on its page: shown, or hidden again. */
async function toggleLabel(thing) {
  if (state.labelShown === thing) {
    state.labelShown = null;
    draw();
    return;
  }
  if (!(await labelsReady())) {
    notify('The QR code could not be made: reload the page.', 'bad');
    return;
  }
  state.labelShown = thing;
  draw();
}

/**
 * The phone app's Scan board (camera.scan, apps/shared/bridge.json): the app reads a board's QR code, checks
 * that its link is a board's page on this console, and hands back the thing name; anything else it refuses.
 */
async function scanBoard() {
  if (!appBridge?.has('camera')) return;
  try {
    const { thing } = await appBridge.call('camera.scan');
    if (typeof thing !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/.test(thing)) throw new Error('not a board');
    location.hash = `#/devices/${thing}`;
  } catch (error) {
    if (error?.code === 'cancelled') return;
    notify(error?.code === 'not_allowed' || error?.message === 'not a board' ? SCAN_REFUSED : scanFailed(error), 'bad');
  }
}
const SCAN_REFUSED = 'That code is not a board of this console, so the app did not open it.';
const scanFailed = (error) =>
  error?.code === 'unavailable'
    ? `The app cannot use the camera: allow it in the settings of this ${state.app?.device ?? 'device'}.`
    : `The code could not be read. ${error?.message ?? ''}`.trim();

/** memfault-page.js, fetched once, when a Memfault page or a board's page is first opened. */
async function memfaultReady() {
  if (!memfaultScript) {
    memfaultScript = await pageScript(() => import('./memfault-page.js'));
    memfaultScript?.connect({ state, api, load, draw, now: () => clock.now() });
  }
  return memfaultScript;
}

/** The script of Events and Diagnostics, fetched once and handed what it needs to load and draw. */
async function telemetry() {
  if (!telemetryScript) {
    telemetryScript = await pageScript(() => import('./telemetry.js'));
    telemetryScript?.connect({ state, api, load, draw, clock, refresh: () => refreshNow(true), setFilter });
  }
  return telemetryScript;
}

/** The script of a page, or null if it could not be fetched: after a deployment an old tab's is gone. */
async function pageScript(fetching) {
  try {
    state.scriptFailed = false;
    return await fetching();
  } catch (error) {
    console.error(error);
    state.scriptFailed = true;
    return null;
  }
}

// Refreshing. One timer, armed after each refresh has finished, so requests never
// pile up; none while the tab is hidden.

let timer = 0;
let turn = 0;
// Refreshes reading their page's own lists, which go on to what fleet.js shows when they are done.
let pageReading = 0;

function arm() {
  clearTimeout(timer);
  if (state.gate) return;
  const page = pages[state.route.view];
  const plan = refreshPlan({
    interval: page.interval(),
    failed: page.resources().some((item) => item.error),
    visible: document.visibilityState === 'visible',
  });
  state.interval = plan.every;
  if (plan.wait > 0) timer = setTimeout(() => (page.holdStill?.() ? arm() : refreshNow(false)), plan.wait);
  draw();
}

async function refreshNow(full) {
  turn += 1;
  const mine = turn;
  clearTimeout(timer);
  pageReading += 1;
  try {
    await pages[state.route.view].refresh(full);
  } finally {
    pageReading -= 1;
  }
  // What the page shows of the fleet: once fleet.js is here, it reads that itself.
  if (fleetScript && !['fleet', 'rollout'].includes(state.route.view))
    await fleetScript.refreshFor(state.route.view, full);
  // A board's page also shows where the board was (map.js).
  await boardLocation(full);
  if (mine !== turn) return;
  // A change was told while this refresh was reading: read once more, now.
  if (liveQueued) {
    liveQueued = false;
    await refreshNow(false);
    return;
  }
  arm();
}

/**
 * The live API said something changed (live.js): the page reads again what it shows, at once, as a
 * scheduled refresh would. Not while a dialog or a file in hand would be in the way (the timer takes it
 * then), nor on a board's page for another board's events alone.
 */
function liveChanged({ things, what, resync }) {
  if (state.gate || document.visibilityState !== 'visible') return;
  if (what.includes('alerts')) alertsTold();
  if (what.length > 0 && what.every((kind) => kind === 'alerts') && !resync) return;
  const page = pages[state.route.view];
  if (page.holdStill?.()) return;
  const boardsOnly = what.every((kind) => kind === 'board' || kind === 'updates');
  if (!resync && state.route.view === 'device' && boardsOnly && !things.includes(state.route.thing)) return;
  if (pageReading > 0) {
    liveQueued = true;
    return;
  }
  refreshNow(false);
}

/** Fetch live.js once, and keep the WebSocket while the console is signed in and in view. */
function startLive() {
  if (liveUrl === null || live !== null) return;
  live = { sync() {} };
  import('./live.js')
    .then((module) => {
      live = module.createLive({
        url: module.readLiveUrl(liveUrl),
        accessToken: () => (state.gate ? null : auth.accessToken()),
        onChange: liveChanged,
        onStatus: (status) => {
          state.liveUpdates = status === 'live';
          draw();
        },
      });
      live.start();
    })
    .catch((error) => {
      console.error(error);
      live = null;
    });
}

// Sign-in. The console's own page asks, in place: the address stays as it is, and so
// does whatever the page had in memory, such as a chosen file. The AWS sign-in page is
// there on request, and takes over what the console's page does not do.

// Whether the console has been shown once: its listeners and timers are set up then.
let started = false;
// The address used last, so that signing in again does not ask for it again. Memory only.
let lastEmail = '';
// The password field of the sign-in page, read once when the form is sent and emptied.
let passwordField = null;

const emptyCode = () => Array(CODE_LENGTH).fill('');

/** Put the keyboard on an element of the sign-in page, once it is drawn. */
function focusOn(id) {
  const el = document.getElementById(id);
  el?.focus();
  el?.select?.();
}

const focusBox = (index) => focusOn(`code-digit-${index + 1}`);

/** Show the console's own sign-in page, unless a sign-in is under way already. */
function beginSignIn(lead = null) {
  if (state.gate?.leaving || state.gate?.signIn) return;
  pagesReady();
  auth.cancelPasswordSignIn();
  state.signIn = {
    step: 'password',
    email: lastEmail,
    digits: emptyCode(),
    busy: false,
    problem: null,
    tries: 0,
    // Said when the console was in use until now, not after a message such as a sign-out.
    // `lead` is words only: as a button's handler this is given the click.
    lead:
      (typeof lead === 'string' ? lead : null) ??
      (started && !state.gate ? 'Your session has ended. Sign in again to carry on where you were.' : null),
  };
  showGate({ signIn: true });
  focusOn(lastEmail ? 'signin-password' : 'signin-email');
}

function setSignIn(changes) {
  state.signIn = { ...state.signIn, ...changes };
  paint();
}

const ELSEWHERE_WORDS = {
  NEW_PASSWORD_REQUIRED: 'Your account needs a new password first, and the AWS sign-in page asks for it.',
  MFA_SETUP: 'Your account needs an authenticator app first, and the AWS sign-in page sets one up.',
  PASSWORD_RESET_REQUIRED: 'Your password has to be reset first.',
};

/** Leave for the AWS sign-in page, the way the console signed in before it had its own. */
function toAwsPage(challenge = null) {
  if (state.gate?.leaving) return;
  // The app has no managed login pages: such a step is done on the console's website, in the browser.
  if (appBridge) {
    state.signIn = null;
    auth.cancelPasswordSignIn();
    const opened =
      appBridge.has('open') && appConfig
        ? appBridge.call('app.open', { url: `${appConfig.consoleUrl}/` }).then(
            () => true,
            () => false
          )
        : Promise.resolve(false);
    opened.then((open) => {
      const what =
        ELSEWHERE_WORDS[challenge] ??
        (challenge ? 'Your account needs a step that only the console\u2019s website does.' : '');
      // From the sign-in page to the sign-in page again, with the words of why.
      state.gate = null;
      beginSignIn(
        `${what} ${open ? 'The console is open in the browser: do it there, then sign in here.' : 'Do it on the console\u2019s website, then sign in here.'}`.trim()
      );
    });
    return;
  }
  state.signIn = null;
  auth.cancelPasswordSignIn();
  showGate({
    iconName: 'lock',
    title: 'Taking you to the AWS sign-in page…',
    // A step the console's page does not do is said; the name of any other is not.
    text: ELSEWHERE_WORDS[challenge] ?? (challenge ? 'Your account needs a step that only that page does.' : null),
    leaving: true,
  });
  auth.signIn(location.hash).catch((error) => {
    console.error(error);
    showGate(signedOutGate({ reason: 'cannot-start' }));
  });
}

/** Tell the user if the refresh token that came with a new session may still be good. */
function watchRevocation() {
  auth.revocation().then((result) => {
    if (result === 'not-kept') {
      notify(
        'The app could not keep this sign-in, so it will ask for your password and code the next time it opens.',
        'warn'
      );
    } else if (result === 'failed' || result === 'refused') {
      notify(
        'The sign-in service did not confirm that the unused refresh token was revoked. ' +
          'It expires by itself within the hour.',
        'bad'
      );
    }
  });
}

/** A sign-in on the console's own page is complete: the console opens where it was. */
function signedInHere() {
  state.signIn = null;
  showGate({ iconName: 'clock', title: 'Loading the console…', waiting: true });
  watchRevocation();
  // Somebody else may have signed in: their own tokens are read again.
  state.tokens = resource();
  start();
}

/** Where an answer of Cognito leaves the sign-in page. */
function afterStep(outcome) {
  // The page was left meanwhile, or another tab signed out.
  if (!state.gate?.signIn || !state.signIn) return;
  const tries = state.signIn.tries + 1;
  if (outcome.step === 'done') {
    signedInHere();
  } else if (outcome.step === 'elsewhere') {
    toAwsPage(outcome.challenge);
  } else if (outcome.step === 'code') {
    // A wrong code, or one given too often, is cleared for the next; a code that did not
    // get through is kept to be sent again.
    const cleared = !outcome.problem || outcome.problem === 'wrong-code' || outcome.problem === 'too-many';
    setSignIn({
      step: 'code',
      busy: false,
      problem: outcome.problem ?? null,
      tries,
      digits: cleared ? emptyCode() : state.signIn.digits,
    });
    if (cleared) focusBox(0);
  } else {
    setSignIn({ step: 'password', busy: false, problem: outcome.problem ?? 'failed', tries, digits: emptyCode() });
    focusOn(state.signIn.email.trim() === '' ? 'signin-email' : 'signin-password');
  }
}

async function submitPassword() {
  const model = state.signIn;
  if (!model || model.busy || model.step !== 'password') return;
  // Out of the page at once. From here on only this call holds the password, until the
  // proof of it is made; nothing keeps it after that.
  const password = passwordField?.value ?? '';
  if (passwordField) passwordField.value = '';
  lastEmail = model.email.trim();
  setSignIn({ busy: true, problem: null });
  let outcome;
  try {
    outcome = await auth.passwordSignIn(model.email, password);
  } catch {
    // Nothing of what went wrong is logged: it might hold what was typed.
    outcome = { step: 'password', problem: 'failed' };
  }
  afterStep(outcome);
}

async function submitCode() {
  const model = state.signIn;
  if (!model || model.busy || model.step !== 'code') return;
  if (!codeComplete(model.digits)) {
    setSignIn({ problem: 'short-code', tries: model.tries + 1 });
    focusBox(
      Math.max(
        0,
        model.digits.findIndex((digit) => digit === '')
      )
    );
    return;
  }
  setSignIn({ busy: true, problem: null });
  let outcome;
  try {
    outcome = await auth.sendCode(model.digits.join(''));
  } catch {
    outcome = { step: 'code', problem: 'failed' };
  }
  afterStep(outcome);
}

/** New digits in the boxes. The sixth sends the code, once. */
function changeCode(result) {
  const before = state.signIn.digits;
  setSignIn({ digits: result.digits });
  focusBox(result.focus);
  if (!codeComplete(before) && codeComplete(result.digits)) submitCode();
}

function signInModel() {
  const busy = () => state.signIn?.busy !== false;
  return {
    ...state.signIn,
    passwordRef: (el) => {
      passwordField = el;
    },
    setEmail(text) {
      state.signIn.email = text;
    },
    submitPassword,
    submitCode,
    startOver() {
      if (busy()) return;
      auth.cancelPasswordSignIn();
      setSignIn({ step: 'password', digits: emptyCode(), problem: null });
      focusOn('signin-password');
    },
    enterDigits(index, text) {
      if (busy()) return;
      changeCode(enterCode(state.signIn.digits, index, text));
    },
    pasteDigits(index, event) {
      event.preventDefault();
      if (busy()) return;
      changeCode(enterCode(state.signIn.digits, index, event.clipboardData?.getData('text') ?? ''));
    },
    keyInBox(index, event) {
      const result = keyInCode(state.signIn.digits, index, event.key);
      if (result === null) return;
      event.preventDefault();
      // While the code is on its way the keys only move.
      if (busy() && result.digits.join('') !== state.signIn.digits.join('')) return;
      changeCode(result);
    },
    useAwsPage: () => toAwsPage(),
    forgotPassword: () => toAwsPage(),
  };
}

function signedOutGate({ reason, message }) {
  const action = { label: 'Sign in', run: beginSignIn };
  switch (reason) {
    case 'signed-out':
      return { title: 'You are signed out', text: 'Sign in again to use the console.', action };
    case 'unknown-reply':
      return {
        title: 'That sign-in did not start here',
        text:
          'The reply from the sign-in page did not belong to a sign-in started in this tab, ' +
          'so it was discarded unused.',
        action,
      };
    case 'login-error':
      return {
        iconName: 'alert',
        title: 'Sign-in was not completed',
        text: 'The sign-in page sent you back without signing you in.',
        detail: message ? 'The reason it gave:' : null,
        code: message,
        action,
      };
    case 'no-token':
      return {
        iconName: 'alert',
        title: 'Sign-in could not be completed',
        text: message,
        action: { ...action, label: 'Try again' },
      };
    case 'refused':
      return {
        iconName: 'alert',
        title: 'The server did not accept this sign-in',
        text:
          'You signed in, but the console’s API turned the new session away. Signing in again ' +
          'will not help; whoever deployed the console needs to look at its API.',
        action: { label: 'Sign out', run: () => auth.signOut(), quiet: true },
      };
    default:
      return {
        iconName: 'alert',
        title: 'This browser cannot sign in here',
        text:
          'The console needs session storage and a secure (HTTPS) page to sign in. ' + 'Check that neither is blocked.',
      };
  }
}

// In the app: a refused token is first renewed by the app, quietly, before the password is asked for.
let renewing = null;

function onUnauthorized() {
  // Whatever time it had left: the masthead, a dialog and the next request all go by this.
  auth.tokenRefused();
  if (auth.inApp && !auth.signedInWithin(FRESH_SIGN_IN_S)) {
    renewing ??= auth.renew().then((renewed) => {
      renewing = null;
      if (renewed) refreshNow(false);
      else afterRefused();
    });
    return;
  }
  afterRefused();
}

function afterRefused() {
  const step = afterUnauthorized({
    gate: state.gate,
    fresh: auth.signedInWithin(FRESH_SIGN_IN_S),
    holding: dialogOpen() || uploadInHand(state.upload.stage),
  });
  // The masthead says that the session is over now, not at its next redraw.
  draw();
  if (step === 'refused') showGate(signedOutGate({ reason: 'refused' }));
  else if (step === 'sign-in') beginSignIn();
}

/** Ask for the password again shortly before the token ends, unless work is in hand. */
function checkSession() {
  // The WebSocket follows the sign-in: closed while signed out or hidden, opened again with a new token.
  live?.sync();
  // In the app the app renews it, behind Face ID or a fingerprint where that is on.
  if (auth.inApp) {
    if (auth.needsRenewal() && !state.gate && !renewing) {
      renewing = auth.renew().then((renewed) => {
        renewing = null;
        if (!renewed) beginSignIn();
      });
    }
    return;
  }
  const renew = shouldRenew({
    needsRenewal: auth.needsRenewal(),
    visible: document.visibilityState === 'visible',
    gate: Boolean(state.gate),
    dialogOpen: dialogOpen(),
    uploadStage: state.upload.stage,
  });
  if (renew) beginSignIn();
}

/**
 * Another tab was signed out. This one ends too, whatever it holds: the point of signing
 * out is that nobody can go on from here. What a file or a dialog had in hand is gone.
 */
function signedOutElsewhere() {
  if (!auth) return;
  auth.signedOutElsewhere();
  chosen += 1;
  state.upload = { stage: 'idle', over: false };
  state.signIn = null;
  showGate(signedOutGate({ reason: 'signed-out' }));
}

/** The line between tabs of this address. A browser without one simply has none. */
function openSessionChannel() {
  if (typeof window.BroadcastChannel !== 'function') return null;
  try {
    const channel = new window.BroadcastChannel(SESSION_CHANNEL);
    channel.addEventListener('message', (event) => {
      if (event.data === SIGNED_OUT_SIGNAL) signedOutElsewhere();
    });
    return channel;
  } catch {
    return null;
  }
}

// Routes.

let routesShown = 0;

// How far the reader had scrolled, by entry of the browser's history, for the Back and
// Forward buttons. A link makes an entry without a mark, which it gets here.
const scrolled = new Map();
let entriesMarked = 0;

function placePage() {
  const mark = history.state?.entry ?? null;
  window.scrollTo(0, scrolled.get(mark) ?? 0);
  if (mark === null) {
    entriesMarked += 1;
    history.replaceState({ entry: `${Date.now()}-${entriesMarked}` }, '', location.pathname + location.hash);
  }
}

// The address of the page before this one, for Back (see start()).
let previousHash = null;
let currentHash = null;

function showRoute() {
  if (state.gate) return;
  if (location.hash !== currentHash) {
    previousHash = currentHash;
    currentHash = location.hash;
  }
  let route = parseRoute(location.hash);
  // A page this app cannot show (no serial port in the iPhone app) is not a page here.
  if (route && SERIAL_PAGES.includes(route.view) && serialPagesHidden(window)) route = null;
  if (!route) {
    // A console that opens without an address has simply been opened. Any other address
    // was meant to lead somewhere, and leading elsewhere without a word would be odd.
    const lost = !['', '#', '#/'].includes(location.hash);
    history.replaceState(null, '', location.pathname + routeHash(null));
    if (lost) notify('That address is not a page of this console. Here is the overview.');
    showRoute();
    return;
  }
  if (dialog) dialog.close(true);
  // A page's filters are what its address says: none when it has no ?.
  if (Object.hasOwn(FILTERS, route.view)) state.filters[route.view] = readFilters(route.view, route.query ?? {});
  state.filtersOpen = false;
  state.route = route;
  state.interval = 0;
  state.moreOpen = false;
  document.title = pageTitle(route);
  paint();
  placePage();
  // Moving between pages puts the focus on the new page's title, where reading and
  // tabbing should go on. The first page is left alone: it starts at the top.
  routesShown += 1;
  if (routesShown > 1) document.getElementById('page-title')?.focus({ preventScroll: true });
  refreshNow(true);
}

// Dialogs. One at a time; Escape and the backdrop close it unless a request is under way.

function dialogOpen() {
  return dialog !== null && dialog.isOpen();
}

function openDialog(build) {
  const el = document.createElement('dialog');
  el.className = 'dialog';
  el.setAttribute('aria-labelledby', 'dialog-title');
  document.body.append(el);

  let pressedOutside = false;
  const openedAt = Date.now();
  const self = {
    busy: false,
    isOpen: () => el.open,
    redraw: () => keepingFocus(() => render(el, build())),
    close(force = false) {
      if (!self.busy || force) el.close();
    },
  };
  el.addEventListener('cancel', (event) => {
    if (self.busy) event.preventDefault();
  });
  el.addEventListener('mousedown', (event) => {
    pressedOutside = event.target === el;
  });
  el.addEventListener('click', (event) => {
    if (pressedOutside && event.target === el && Date.now() - openedAt > DOUBLE_CLICK_MS) self.close();
  });
  el.addEventListener('close', () => {
    el.remove();
    if (dialog === self) dialog = null;
    // The browser gives the focus back to what opened the dialog, unless that is gone.
    if (document.activeElement === document.body) {
      document.getElementById('page-title')?.focus({ preventScroll: true });
    }
    checkSession();
  });

  dialog = self;
  self.redraw();
  el.showModal();
  // A dialog opens at its top, also where the field that gets the focus lies further down.
  el.scrollTop = 0;
  const body = el.querySelector?.('.dialog-body');
  if (body) body.scrollTop = 0;
  return self;
}

async function submitFrom(self, model, task) {
  model.sending = true;
  model.error = null;
  self.busy = true;
  self.redraw();
  try {
    await task();
  } catch (error) {
    model.error = asProblem(error);
    model.sending = false;
    self.busy = false;
    self.redraw();
    // The change may have been made all the same, or the server said that the page is
    // out of date: show what is true now. The open dialog is drawn again with the page.
    if (staleAfter(model.error)) refreshNow(true);
  }
}

function openDeploy(version) {
  if (!state.me.canWrite || dialogOpen()) return;
  let self = null;
  const change =
    (apply) =>
    (...args) => {
      apply(...args);
      model.error = null;
      self.redraw();
    };
  // With a single board to choose from, it is ticked when the boards come up. From the
  // first tick by hand on, the selection is the user's own.
  // The boards of the chosen release's type: the only ones the dialog offers it to.
  const offered = () =>
    offeredBoards(
      model.devices ?? [],
      model.types,
      (model.releases ?? []).find((release) => release.version === model.version) ?? null
    );
  const suggest = () => {
    if (model.chosenByHand || model.step !== 1 || model.devices === null) return;
    const only = onlyChoice(offered(), model.busy, model.version);
    model.things = new Set(only === null ? [] : [only]);
  };
  const model = {
    step: version ? 1 : 0,
    version,
    things: new Set(),
    chosenByHand: false,
    note: '',
    busy: new Map(),
    releases: null,
    devices: null,
    loading: true,
    loadError: null,
    sending: false,
    error: null,
    // The release that was asked for and has been revoked since.
    gone: null,
    // Each board's type, from the fleet (fleet.js): thing -> { type, bluetoothOnly }. Null until
    // known, and then the dialog offers a release only to the boards of its type.
    types: null,
    // A staged rollout, for more than one board: how many boards go first, in how many stages the
    // rest follow, how long to wait between stages, and at which share of failures it stops.
    canary: 1,
    stages: 1,
    soakMinutes: 0,
    abortPercent: 20,
    // The health gate (docs/fleet.md): on, for 10 minutes, unless the person changes it.
    healthGate: true,
    gateMinutes: 10,
    // Now, or at a time in a time zone (console 2.20.0, fleet.js scheduleModel): only with the fleet's script.
    ...(fleetScript?.scheduleModel ? fleetScript.scheduleModel(clock.now()) : {}),
    redraw: () => self.redraw(),
    setHealthGate: change((value) => {
      model.healthGate = value;
    }),
    setGateMinutes: change((value) => {
      model.gateMinutes = value;
    }),
    setCanary: change((value) => {
      model.canary = value;
    }),
    setStages: change((value) => {
      model.stages = value;
    }),
    setSoakMinutes: change((value) => {
      model.soakMinutes = value;
    }),
    setAbortPercent: change((value) => {
      model.abortPercent = value;
    }),
    close: () => self.close(),
    signIn: beginSignIn,
    choose: change((picked) => {
      model.version = picked;
      model.gone = null;
      // A board of another type is not offered the new choice.
      const fits = new Set(offered().map((device) => device.thing));
      model.things = new Set([...model.things].filter((thing) => fits.has(thing)));
    }),
    next: change(() => {
      model.step += 1;
      suggest();
    }),
    back: change(() => {
      model.step -= 1;
    }),
    setNote(text) {
      model.note = text;
    },
    toggle: change((thing) => {
      model.chosenByHand = true;
      if (model.things.has(thing)) model.things.delete(thing);
      else if (!model.busy.has(thing)) model.things.add(thing);
    }),
    toggleAll: change(() => {
      model.chosenByHand = true;
      // Not the boards that would only refuse: those take a tick of their own.
      const free = offered().filter((device) => !model.busy.has(device.thing) && !alreadyRuns(device, model.version));
      const all = free.every((device) => model.things.has(device.thing));
      model.things = new Set(all ? [] : [...model.things, ...free.map((device) => device.thing)]);
    }),
    async reload() {
      model.loading = true;
      model.loadError = null;
      self.redraw();
      try {
        const [firmware, fleet, types] = await Promise.all([
          api.firmware(),
          api.devices(),
          fleetScript ? fleetScript.boardTypes().catch(() => null) : null,
        ]);
        model.types = types;
        // What this has found out is true of the page behind the dialog as well.
        Object.assign(state.firmware, { value: firmware, error: null, loadedAt: clock.now() });
        draw();
        // Whether a board still has an update open is in the board's own record.
        const busy = new Map();
        await each(fleet.devices, async (device) => {
          const detail = await api.device(device.thing);
          const open = detail.executions.find((execution) => isUnfinished(execution.status));
          if (open) {
            busy.set(device.thing, {
              deployment: open.deployment,
              version: open.version ?? versionOfDeployment(open.deployment),
            });
          }
        });
        model.releases = firmware.releases.filter((release) => release.status === 'active');
        model.devices = fleet.devices;
        model.busy = busy;
        for (const thing of [...model.things]) {
          if (busy.has(thing)) model.things.delete(thing);
        }
        if (!model.releases.some((release) => release.version === model.version)) {
          // Without a word on which release, the newest is the one to suggest. A release
          // that was asked for and has gone is not silently replaced by another.
          model.gone = model.version;
          model.version = model.gone === null ? (model.releases[0]?.version ?? null) : null;
          model.step = 0;
        }
        suggest();
      } catch (error) {
        model.loadError = asProblem(error);
      }
      model.loading = false;
      self.redraw();
    },
    submit: () =>
      submitFrom(self, model, async () => {
        let deployment;
        // Later: the same request, scheduled, and started by the console then (handlers/schedules.mjs).
        if (model.when === 'later' && fleetScript?.scheduleStart) {
          const things = [...model.things].sort();
          const staged = things.length > 1;
          await fleetScript.scheduleStart(
            staged ? 'rollout' : 'deployment',
            staged
              ? fleetScript.rolloutBody({
                  version: model.version,
                  things,
                  note: singleLine(model.note),
                  canary: model.canary,
                  stages: model.stages,
                  soakMinutes: model.soakMinutes,
                  abortPercent: model.abortPercent,
                  healthGate: model.healthGate,
                  gateMinutes: model.gateMinutes,
                })
              : { version: model.version, things, ...(singleLine(model.note) ? { note: singleLine(model.note) } : {}) },
            model
          );
          self.close(true);
          return;
        }
        try {
          // More than one board: a staged rollout, a canary first (docs/fleet.md).
          if (model.things.size > 1 && fleetScript) {
            const rollout = await fleetScript.startRollout({
              version: model.version,
              things: [...model.things].sort(),
              note: singleLine(model.note),
              canary: model.canary,
              stages: model.stages,
              soakMinutes: model.soakMinutes,
              abortPercent: model.abortPercent,
              healthGate: model.healthGate,
              gateMinutes: model.gateMinutes,
            });
            self.close(true);
            notify(
              `Staged rollout of ${rollout.version} started: ${rollout.canary.things.length === 1 ? 'one board' : `${rollout.canary.things.length} boards`} first.`
            );
            location.hash = routeHash({ view: 'rollout', id: rollout.id });
            return;
          }
          deployment = await api.deploy({
            version: model.version,
            things: [...model.things].sort(),
            note: singleLine(model.note),
          });
        } catch (error) {
          // A conflict says that what the dialog offers is out of date: a board has become
          // busy, or the release was revoked. Read both again, so that neither can be
          // chosen once more, and go back to the boards where a busy one is named.
          if (error?.status === 409) {
            if (error.code === 'device_busy') model.step = 1;
            model.reload();
          }
          throw error;
        }
        keep(state.deploymentDetails, deployment.id, deployment);
        self.close(true);
        notify(`Deployment of ${deployment.version ?? model.version} started.`);
        location.hash = routeHash({ view: 'deployment', id: deployment.id });
      }),
  };
  self = openDialog(() => deployDialog(model, { state, actions, fleet: fleetScript }));
  model.reload();
}

function openCancel(deployment) {
  if (!state.me.canWrite || dialogOpen() || !deployment) return;
  let self = null;
  const model = {
    // The dialog counts waiting and started boards from the newest record there is.
    get deployment() {
      return state.deploymentDetails.get(deployment.id)?.value ?? deployment;
    },
    force: false,
    sending: false,
    error: null,
    close: () => self.close(),
    signIn: beginSignIn,
    setForce(force) {
      model.force = force;
      self.redraw();
    },
    // `force` is what the dialog shows as chosen, which is not always what was ticked:
    // once the offer is withdrawn, stopping the boards is all that is left.
    submit: (force) =>
      submitFrom(self, model, async () => {
        const before = model.deployment;
        const started = before.executions.filter((execution) => execution.status === 'IN_PROGRESS').length;
        const updated = await api.cancel(deployment.id, force);
        keep(state.deploymentDetails, updated.id, updated);
        self.close(true);
        notify(cancelNotice({ force, withdrawn: before.status === 'CANCELED', started }));
        refreshNow(true);
      }),
  };
  self = openDialog(() => cancelDialog(model));
}

// The API wants a reason with every revocation. One that is repeated carries the
// reason on record; this stands in for a record that has none.
const REPEATED_REASON = 'Revocation applied again.';

/**
 * Revoke a release, or repeat the revocation of one that is revoked already. The
 * second finishes a revocation that stopped half way: the server then repeats the steps
 * after the mark, which refuse the image and cancel the open deployments.
 */
function openRevoke(release) {
  if (!state.me.canWrite || dialogOpen()) return;
  let self = null;
  const model = {
    // The newest record of the release there is: a first attempt that failed half way
    // leaves it revoked, and the dialog then offers to finish.
    get release() {
      return state.firmware.value?.releases.find((item) => item.version === release.version) ?? release;
    },
    get again() {
      return model.release.status !== 'active';
    },
    reason: '',
    // Typing starts in the reason, except on a touch screen, where the keyboard would
    // cover what the dialog has to say.
    focusReason: !window.matchMedia('(pointer: coarse)').matches,
    sending: false,
    error: null,
    close: () => self.close(),
    signIn: beginSignIn,
    setReason(text) {
      model.reason = text;
      self.redraw();
    },
    submit: () =>
      submitFrom(self, model, async () => {
        const { again } = model;
        const reason = again ? singleLine(model.release.revoked?.reason) || REPEATED_REASON : singleLine(model.reason);
        let cancelled = null;
        try {
          const done = await api.revoke(release.version, reason);
          ({ cancelled } = done);
          const firmware = state.firmware.value;
          if (firmware) {
            firmware.releases = firmware.releases.map((item) =>
              item.version === done.release.version ? done.release : item
            );
          }
        } catch (error) {
          // The server found the release revoked and went through the steps after the
          // mark without a failure. That is what was asked for, answered as a refusal.
          if (!revocationInPlace(error)) throw error;
        }
        self.close(true);
        refreshNow(true);
        // Said at once: this cannot be undone, and its confirmation does not wait for a list.
        notify(revocationNotice(release.version, { cancelled, again }));
        // Revoking leaves a board that runs the release as it is. Whoever revokes should know
        // which, as soon as that is known.
        await load(state.devices, api.devices);
        const running = (state.devices.value?.devices ?? []).filter((device) => device.fw?.version === release.version);
        if (running.length > 0) notify(stillRunning(running));
      }),
  };
  self = openDialog(() => revokeDialog(model, { state, actions }));
}

// A release's note, changed after its upload: what the release changed, for everyone who reads it.

function openNotes(release) {
  if (!state.me.canWrite || dialogOpen()) return;
  let self = null;
  const model = {
    release,
    notes: release.notes ?? '',
    sending: false,
    error: null,
    close: () => self.close(),
    signIn: beginSignIn,
    setNotes(text) {
      model.notes = text;
      self.redraw();
    },
    submit: () =>
      submitFrom(self, model, async () => {
        const changed = await api.setNotes(release.version, singleLine(model.notes));
        const firmware = state.firmware.value;
        if (firmware)
          firmware.releases = firmware.releases.map((item) => (item.version === changed.version ? changed : item));
        self.close(true);
        notify(
          changed.notes ? `The note of ${changed.version} is saved.` : `The note of ${changed.version} is cleared.`
        );
        draw();
      }),
  };
  self = openDialog(() => notesDialog(model, { state, actions }));
}

// API tokens. A new token is shown once, in the dialog that made it, and is gone with
// the dialog: nothing else on the page ever holds it.

function openCreateToken() {
  if (dialogOpen()) return;
  let self = null;
  const model = {
    name: '',
    days: String(TOKEN_DAYS.usual),
    made: null,
    sending: false,
    error: null,
    // Once the token is shown, Escape and the backdrop no longer close the dialog (it is
    // held busy); its own buttons do, and the token goes with it.
    close() {
      const shown = model.made !== null;
      model.made = null;
      self.close(shown);
    },
    signIn: beginSignIn,
    setName(text) {
      model.name = text;
      model.error = null;
      self.redraw();
    },
    setDays(text) {
      model.days = text;
      model.error = null;
      self.redraw();
    },
    submit: () =>
      submitFrom(self, model, async () => {
        const made = await api.createToken({ name: model.name.trim(), days: tokenDays(model.days) });
        model.made = made;
        model.sending = false;
        self.busy = true;
        self.redraw();
        load(state.tokens, api.tokens);
      }),
  };
  self = openDialog(() => createTokenDialog(model, { state, actions }));
}

function openRevokeToken(token) {
  if (dialogOpen() || !token) return;
  let self = null;
  const model = {
    token,
    sending: false,
    error: null,
    close: () => self.close(),
    signIn: beginSignIn,
    submit: () =>
      submitFrom(self, model, async () => {
        try {
          const revoked = await api.revokeToken(token.id);
          const listing = state.tokens.value;
          if (listing) listing.tokens = listing.tokens.map((item) => (item.id === revoked.id ? revoked : item));
        } catch (error) {
          // Revoked already, from another tab: what was asked for is so.
          if (!(error?.status === 409 && error.code === 'token_already_revoked')) throw error;
        }
        self.close(true);
        notify(`Revoked the token “${token.name}”. A script that uses it is refused from now on.`);
        refreshNow(true);
      }),
  };
  self = openDialog(() => revokeTokenDialog(model, { state, actions }));
}

// Uploading firmware.

let chosen = 0;

async function chooseFile(file) {
  chosen += 1;
  const mine = chosen;
  const name = String(file.name);
  if (file.size > LARGEST_FILE_READ) {
    state.upload = {
      stage: 'ready',
      name,
      recordedAs: recordedFilename(name),
      size: file.size,
      digest: '',
      header: { ok: false, message: 'This file is far too large to be firmware for the board.' },
      notes: '',
    };
    draw();
    return;
  }
  state.upload = { stage: 'reading', name };
  draw();
  let bytes;
  let digest;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    digest = await sha256Hex(bytes);
  } catch (error) {
    console.error(error);
    if (mine === chosen) {
      state.upload = {
        stage: 'ready',
        name,
        recordedAs: recordedFilename(name),
        size: file.size,
        digest: '',
        notes: '',
        header: { ok: false, message: 'The file could not be read.' },
      };
      draw();
    }
    return;
  }
  if (mine !== chosen) return;
  state.upload = {
    stage: 'ready',
    name,
    recordedAs: recordedFilename(name),
    size: bytes.length,
    bytes,
    digest,
    header: readImageHeader(bytes),
    notes: '',
  };
  if (state.firmware.loadedAt === 0) load(state.firmware, api.firmware);
  draw();
}

async function startUpload() {
  const upload = state.upload;
  if (upload.stage !== 'ready' && upload.stage !== 'refused') return;
  state.upload = { ...upload, stage: 'sending', sent: 0, error: null };
  draw();
  try {
    const release = await api.upload(
      { filename: upload.recordedAs, notes: singleLine(upload.notes), data: toBase64(upload.bytes) },
      (progress) => {
        if (state.upload.stage !== 'sending' && state.upload.stage !== 'checking') return;
        state.upload = { ...state.upload, stage: progress.stage, sent: progress.sent };
        draw();
      }
    );
    // The panel itself says "Registered as …"; a toast on top of the list would only repeat it.
    state.upload = { stage: 'done', release };
    load(state.firmware, api.firmware);
  } catch (error) {
    state.upload = { ...upload, stage: 'refused', error: asProblem(error) };
    draw();
    load(state.firmware, api.firmware);
  }
}

// Commands to a board (docs/fleet.md): identify, report and memfault, and the board's answer from its log.

/** Look in the board's log for its answer to a command, every few seconds, for a while. */
function watchForAnswer(thing, command) {
  const started = clock.now();
  const from = new Date(started - 60_000).toISOString();
  const look = async () => {
    const current = state.commands.get(thing);
    // Another command was sent since: this one is no longer what the page shows.
    if (current?.id !== command.id) return;
    try {
      const read = await api.boardLog({ from, to: new Date(clock.now()).toISOString(), thing, tags: ['CMD'] });
      const answer = commandAnswer(read.lines, command.id);
      if (answer !== null && state.commands.get(thing)?.id === command.id) {
        state.commands.set(thing, { ...current, status: 'answered', answer });
        notify(`${boardName(knownBoard(thing), { short: true })}: ${answer.text}`, answer.ignored ? 'warn' : 'good');
        draw();
        return;
      }
    } catch {
      // The next look may get through.
    }
    if (clock.now() - started >= COMMAND_ANSWER_MS) {
      if (state.commands.get(thing)?.id === command.id) state.commands.set(thing, { ...current, status: 'unanswered' });
      draw();
      return;
    }
    setTimeout(look, 3000);
  };
  setTimeout(look, 3000);
}

async function sendCommand(thing, cmd) {
  if (!state.me?.canWrite || state.commands.get(thing)?.status === 'sending') return;
  const name = boardName(knownBoard(thing), { short: true });
  state.commands.set(thing, { cmd, status: 'sending', id: null, answer: null, error: null });
  draw();
  try {
    const command = await api.command(thing, cmd, cmd === 'identify' ? IDENTIFY_SECONDS : null);
    state.commands.set(thing, {
      cmd,
      status: 'sent',
      id: command.id,
      answer: null,
      error: null,
      online: command.online,
    });
    notify(
      cmd === 'identify'
        ? `Sent: ${name} should blink its two lights for ${command.seconds ?? IDENTIFY_SECONDS} s.`
        : cmd === 'memfault'
          ? `Sent: ${name} sends its Memfault data at once.`
          : `Sent: ${name} reports at once.`
    );
    watchForAnswer(thing, command);
  } catch (error) {
    const problem = asProblem(error);
    state.commands.set(thing, { cmd, status: 'failed', id: null, answer: null, error: problem.message });
    notify(problem.message, 'bad');
    if (problem.status === 401) return;
  }
  draw();
}

/** Ask for e-mail alerts at the caller's own address, or stop them. */
async function changeAlerts(subscribe) {
  if (!state.me?.canWrite || state.alerts.busy) return;
  state.alerts.busy = true;
  draw();
  try {
    if (subscribe) {
      const now = await api.subscribeAlerts();
      notify(
        now === 'pending'
          ? 'AWS Notifications is sending you an e-mail with a link. Alerts start once you follow it.'
          : 'Alerts already go to your address.'
      );
    } else {
      await api.unsubscribeAlerts();
      notify('No more alerts will be sent to your address.');
    }
  } catch (error) {
    notify(asProblem(error).message, 'bad');
  } finally {
    state.alerts.busy = false;
  }
  await load(state.alerts, api.alerts);
}

// Search and filters (docs/search-filters.md). A page's filters are state.filters[view], and its address
// carries them after a ?: replaced, never pushed, so Back leaves the page rather than undoing a filter, and a
// change makes no hashchange. A short list is filtered as it is drawn; the activity log and the events are
// read again from the server, a moment after the typing stops.

const READ_AGAIN = new Set(['activity', 'events']);
const TYPING_MS = 400;
let filterTimer = null;

/** Change a page's filters, checked, and put them in the address if the page is open. */
function writeFilters(view, changes) {
  const next = { ...(state.filters[view] ?? readFilters(view)), ...changes };
  const typed = typeof next.q === 'string' ? next.q.slice(0, 100) : '';
  const checked = readFilters(view, { ...next, q: cleanSearch(typed) });
  state.filters[view] = { ...checked, q: typed };
  if (state.route.view !== view) return;
  const hash = filtersHash(state.route, checked);
  if (location.hash !== hash) {
    history.replaceState(history.state, '', location.pathname + hash);
    currentHash = location.hash;
  }
}

function setFilter(view, name, value) {
  const before = cleanSearch(state.filters[view]?.q ?? '');
  writeFilters(view, { [name]: value });
  draw();
  if (!READ_AGAIN.has(view)) return;
  // A space or a capital typed does not change what the server is asked.
  if (name === 'q' && cleanSearch(state.filters[view].q) === before) return;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(
    () => {
      if (state.route.view === view) refreshNow(true);
    },
    name === 'q' ? TYPING_MS : 0
  );
}

function clearFilters(view) {
  state.filters[view] = readFilters(view);
  writeFilters(view, {});
  draw();
  if (READ_AGAIN.has(view)) {
    clearTimeout(filterTimer);
    refreshNow(true);
  }
}

/**
 * What the Activity page asks the API for: the search, the actions of the kind, the outcome, and the days
 * from and to, as local days. {} when nothing narrows it.
 */
function activityQuery() {
  const filters = state.filters.activity ?? readFilters('activity');
  const asked = {};
  const q = cleanSearch(filters.q ?? '');
  if (q !== '') asked.q = q;
  if (filters.kind) asked.actions = activityActions(filters.kind);
  if (filters.outcome) asked.outcomes = [filters.outcome];
  const dayStart = (day) => new Date(`${day}T00:00:00`).getTime();
  if (filters.from) asked.from = new Date(dayStart(filters.from)).toISOString();
  if (filters.to) asked.to = new Date(dayStart(filters.to) + 86_400_000 - 1).toISOString();
  if (asked.from && asked.to && asked.from >= asked.to) delete asked.to;
  return asked;
}

/** Change alert rules ({ <rule>: { on?, <threshold>? } }): a release manager's, for everybody who gets alerts. */
async function changeAlertRules(rules) {
  if (!state.me?.canWrite || state.alerts.busy) return false;
  state.alerts.busy = true;
  draw();
  let ok = false;
  try {
    const changed = await api.setAlertRules(rules);
    if (state.alerts.value) state.alerts.value = { ...state.alerts.value, alertRules: changed };
    notify('The alert rules are changed.');
    ok = true;
  } catch (error) {
    notify(asProblem(error).message, 'bad');
  } finally {
    state.alerts.busy = false;
  }
  await load(state.alerts, api.alerts);
  return ok;
}

/**
 * An alert e-mail went out (the live API's "alerts", docs/live.md): whatever page is open says so at
 * once, in the console and in the phone and desktop apps, which show these same pages. The alerts are
 * read again and each one newer than what this page has seen is a toast with its subject.
 */
let alertsSeen = null;
async function alertsTold() {
  try {
    const before = alertsSeen ?? state.alerts.value?.recent?.[0]?.at ?? new Date(Date.now() - 60_000).toISOString();
    await load(state.alerts, api.alerts);
    const fresh = (state.alerts.value?.recent ?? []).filter((item) => item.at > before);
    if (fresh.length > 0) alertsSeen = fresh[0].at;
    for (const item of fresh.slice(0, 3).reverse()) notify(`Alert: ${item.subject.replace(/^Cranium: /, '')}`, 'bad');
    draw();
  } catch (error) {
    console.error(error);
  }
}

const actions = {
  identify: (thing) => sendCommand(thing, 'identify'),
  reportNow: (thing) => sendCommand(thing, 'report'),
  memfaultNow: (thing) => sendCommand(thing, 'memfault'),
  subscribeAlerts: () => changeAlerts(true),
  unsubscribeAlerts: () => changeAlerts(false),
  setAlertRules: (rules) => changeAlertRules(rules),
  refresh: () => refreshNow(true),
  // A tab of the Release notes: its address is replaced, not pushed, and drawn at once so the tab keeps the focus.
  showReleaseNotes(product) {
    const route = { view: 'release-notes', product };
    const hash = routeHash(route);
    if (state.route.view !== 'release-notes' || hash === '#/overview') return;
    state.route = route;
    if (location.hash !== hash) {
      history.replaceState(history.state, '', location.pathname + hash);
      currentHash = location.hash;
    }
    paint();
  },
  openNotes,
  redraw: draw,
  signOut: () => auth.signOut(),
  toggleMore: () => showMore(!state.moreOpen),
  setFilter,
  clearFilters,
  toggleFilters() {
    state.filtersOpen = !state.filtersOpen;
    draw();
  },
  closeMore: () => showMore(false),
  // A board's QR code and printable label (labels.js), and the phone app's Scan board.
  toggleLabel: (thing) => toggleLabel(thing),
  // The boards ticked on the Devices page, and Compare with… on a board's page, which ticks it and goes there.
  toggleSelected,
  clearSelected() {
    state.selected = [];
    draw();
  },
  compareWith(thing) {
    state.selected = [thing];
    location.hash = '#/devices';
  },
  moreTimeline: (thing) => compareScript?.moreTimeline(thing),
  // The weekly report (reports.js): its Monday e-mail, its CSV and its printout.
  setReportEmail: (on) => reportsScript?.setEmail(on),
  exportReport: (week) => reportsScript?.exportCsv(week),
  printReport: () => reportsScript?.print(),
  scanBoard: () => scanBoard(),
  // The Serial page's record of a command a board answered OK to: its name, never a value.
  recordSerialCommand: (command) => api.recordSerialCommand(command),
  // Asked for by hand where the console does not leave by itself: with a file in hand.
  signInAgain: () => beginSignIn(),
  // The phone app's own settings: its versions, an update of its pages, and the classic app.
  appSettings: () => appBridge?.call('app.settings').catch(() => notify('The app could not show its settings.', 'bad')),
  // A page whose changes are made on the website only, opened there in the browser: `view` is its route.
  openOnWebsite: (view) =>
    appBridge && appConfig && appBridge.has('open')
      ? appBridge
          .call('app.open', { url: `${appConfig.consoleUrl}/#/${view}` })
          .catch(() => notify('The app could not open the console’s website.', 'bad'))
      : notify('Make this change on the console’s website.', 'idle'),
  async copy(value, label) {
    try {
      if (appBridge?.has('clipboard')) await appBridge.call('clipboard.write', { text: String(value).slice(0, 1024) });
      else await navigator.clipboard.writeText(value);
      notify(`Copied ${label}.`);
    } catch {
      notify(`Could not copy ${label}. Select the text and copy it by hand.`, 'bad');
    }
  },
  chooseFile,
  startUpload,
  resetUpload() {
    chosen += 1;
    state.upload = { stage: 'idle', over: false };
    draw();
  },
  setUploadNotes(text) {
    state.upload.notes = text;
  },
  dragOver(event) {
    event.preventDefault();
    if (!state.upload.over) {
      state.upload = { ...state.upload, over: true };
      draw();
    }
  },
  dragLeave(event) {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    state.upload = { ...state.upload, over: false };
    draw();
  },
  dropFile(event) {
    event.preventDefault();
    const [file] = event.dataTransfer?.files ?? [];
    state.upload = { ...state.upload, over: false };
    if (file) chooseFile(file);
    else draw();
  },
  openDeploy,
  openCancel,
  openRevoke,
  openCreateToken,
  openRevokeToken,
  async loadMoreActivity() {
    const audit = state.audit;
    if (!audit.value?.next || audit.loadingMore) return;
    audit.loadingMore = true;
    draw();
    try {
      const page = await api.audit({ limit: ACTIVITY_PAGE, before: audit.value.next, ...activityQuery() });
      audit.value = {
        ...audit.value,
        entries: audit.value.entries.concat(page.entries),
        next: page.next,
        ...(page.read === undefined ? {} : { read: (audit.value.read ?? 0) + page.read }),
      };
      audit.moreError = null;
    } catch (error) {
      audit.moreError = asProblem(error);
    }
    audit.loadingMore = false;
    draw();
  },
};

// Starting up.

async function start() {
  try {
    state.me = await api.me();
  } catch (error) {
    if (error?.status === 401) return;
    const fault = asProblem(error);
    // The gateway's own 403: the token lacks the console's scope, which the person cannot
    // change by signing in again (the sign-in trigger, infra/template.yaml).
    if (fault.status === 403 && fault.code === 'gateway') {
      showGate(signedOutGate({ reason: 'refused' }));
      return;
    }
    const gate =
      fault.code === 'account_inactive'
        ? {
            title: 'Your account is not active',
            text: 'It is disabled or removed, or it has not been confirmed. Ask a teammate who manages the console.',
            action: { label: 'Sign out', run: () => auth.signOut(), quiet: true },
          }
        : null;
    showGate(
      gate ??
        (fault.status === 403
          ? {
              title: 'Your account has no access yet',
              text:
                'You are signed in, but your account is in neither the viewers nor the release ' +
                'managers group. Ask a teammate who manages the console to add you.',
              detail: fault.message,
              action: { label: 'Sign out', run: () => auth.signOut(), quiet: true },
            }
          : {
              iconName: 'alert',
              title: 'The console could not reach its server',
              text: fault.message,
              action: {
                label: 'Try again',
                run() {
                  showGate({ iconName: 'clock', title: 'Loading the console…', waiting: true });
                  start();
                },
              },
            })
    );
    return;
  }
  state.gate = null;
  pagesReady();
  // After a sign-in in place the console is set up already: it only shows its page again.
  if (started) {
    showRoute();
    return;
  }
  started = true;

  window.addEventListener('hashchange', showRoute);
  // Escape closes the sheet of the other sections, as it closes a dialog.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.moreOpen && !dialogOpen()) showMore(false);
  });
  // Back on a page goes back in the history when that is where it leads, so that the browser's
  // Back, Android's Back and the page's own Back agree, and the place on the list is kept.
  document.addEventListener('click', (event) => {
    const back = event.target.closest?.('a.back');
    if (!back || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
    if (previousHash !== null && back.getAttribute('href') === previousHash) {
      event.preventDefault();
      history.back();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      clearTimeout(timer);
      return;
    }
    checkSession();
    if (!state.gate && pages[state.route.view].interval() > 0) refreshNow(false);
  });
  // A file dropped beside the drop zone must not make the browser open it.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
  setInterval(() => {
    if (document.visibilityState === 'visible') draw();
  }, REDRAW_MS);
  setInterval(() => {
    if (document.visibilityState === 'visible' && !state.gate && pages[state.route.view].everySecond) draw();
  }, 1000);
  setInterval(checkSession, SESSION_CHECK_MS);

  showRoute();
  startLive();
  // Once fleet.js is here, only what it shows is read, and only if no refresh under way will read it.
  fleetReady().then((module) => {
    if (!module || ['fleet', 'rollout'].includes(state.route.view) || pageReading > 0) return;
    module.refreshFor(state.route.view, false).then(draw);
  });
}

async function boot() {
  // The console puts each page where it belongs: see placePage().
  history.scrollRestoration = 'manual';
  window.addEventListener(
    'scroll',
    () => {
      const mark = history.state?.entry;
      if (mark) scrolled.set(mark, window.scrollY);
    },
    { passive: true }
  );
  document.getElementById('skip')?.addEventListener('click', () => {
    (document.getElementById('page-title') ?? main).focus();
  });
  // A page brought back by the Back button is a snapshot from before the browser left,
  // perhaps for the sign-in page or after signing out. Start again from what is true now.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });

  // In the phone app the settings come from the app, and the API is at the console's address.
  try {
    const inApp = Boolean(window.webkit?.messageHandlers?.cranium || window.craniumNative);
    bridgeScript = inApp ? await import('./bridge.js') : null;
    appBridge = bridgeScript ? await bridgeScript.connectBridge(window) : null;
  } catch (error) {
    console.error(error);
    showGate({
      iconName: 'alert',
      title: 'The app could not start the console',
      text: 'The app did not answer the page. Close the app and open it again.',
    });
    return;
  }
  let config;
  if (appBridge) {
    appConfig = bridgeScript.readAppConfig(await appBridge.call('app.config').catch(() => null));
    config = appConfig ? bridgeScript.appConsoleConfig(appConfig, window.location.origin) : null;
    // The Android app's USB serial port, as the page's Web Serial: the Serial console and Board setup.
    if (appBridge.has('usb') && !navigator.serial) {
      Object.defineProperty(navigator, 'serial', {
        value: bridgeScript.createBridgeSerial(appBridge),
        configurable: true,
      });
    }
    state.app = {
      ble: appBridge.has('ble'),
      settings: appBridge.has('settings'),
      // The camera, for Scan board on the Devices page (camera.scan).
      scan: appBridge.has('camera'),
      words: bridgeScript.appWords(appBridge.hello),
      // What the app runs on, as the bridge says: the pages say "this phone", "this Mac" or "this computer".
      platform: appBridge.platform ?? null,
      device: bridgeScript.deviceName(appBridge.platform),
      example: appConfig?.example === true,
    };
    // Five minutes in the background with Face ID or a fingerprint on: the app locked the sign-in again.
    appBridge.on('auth.locked', ({ pool }) => {
      if (pool === 'admin') window.location.reload();
    });
    appBridge.on('app.bundleReady', () =>
      notify('The app has new pages from the console. They show the next time it opens.')
    );
  } else {
    config = readConfig(document.querySelector('meta[name="cranium-config"]')?.content);
  }
  if (!config) {
    showGate({
      iconName: 'alert',
      title: 'The console is not set up',
      text:
        'The page arrived without its sign-in settings. Reload it; if that does not help, ' +
        'the console needs to be deployed again.',
    });
    return;
  }
  // Admin mode of the customer site: where to go back to.
  state.customerSite = config.customerSite ?? null;
  liveUrl = config.liveUrl ?? null;
  // The API tokens page's example: the API's own address, which in the app is not the page's.
  if (config.apiBase) state.origin = config.apiBase;

  const channel = openSessionChannel();
  let outcome;
  try {
    auth = createAuth({
      config,
      // In the app the access token lives as long as the page, and the app keeps the sign-in.
      storage: appBridge ? bridgeScript.memoryStorage() : window.sessionStorage,
      location: window.location,
      history: window.history,
      fetch: window.fetch.bind(window),
      crypto: window.crypto,
      tellOtherTabs: () => channel?.postMessage(SIGNED_OUT_SIGNAL),
      vault: appBridge?.has('auth') ? bridgeScript.createVault(appBridge, 'admin') : null,
    });
    api = createApi({
      auth,
      fetch: window.fetch.bind(window),
      XMLHttpRequest: window.XMLHttpRequest,
      crypto: window.crypto,
      clock,
      onUnauthorized,
      base: config.apiBase ?? '',
      // A change from the phone needs the password and code of the last 15 minutes.
      onSignInAgain: () =>
        beginSignIn('To change anything from the app, sign in again first: your password and the code.'),
    });
    outcome = await auth.resume();
  } catch (error) {
    console.error(error);
    showGate(signedOutGate({ reason: 'cannot-start' }));
    return;
  }

  if (outcome.status === 'sign-in') {
    // In the app: Face ID or the fingerprint was cancelled, or the network is not there. The sign-in is kept.
    if (outcome.reason === 'cancelled' || outcome.reason === 'network') {
      pagesReady();
      showGate({
        title: outcome.reason === 'network' ? 'No connection' : 'Cranium is locked',
        text:
          outcome.reason === 'network'
            ? 'The app could not renew your sign-in. Check the connection.'
            : 'Unlock it to go on, or sign in with your password and code.',
        action: { label: outcome.reason === 'network' ? 'Try again' : 'Unlock', run: () => window.location.reload() },
      });
      return;
    }
    beginSignIn(
      outcome.reason === 'locked'
        ? 'Face ID or the fingerprint can no longer open the saved sign-in. Sign in with your password and code.'
        : null
    );
    return;
  }
  if (outcome.status === 'signed-out') {
    pagesReady();
    showGate(signedOutGate(outcome));
    return;
  }
  if (outcome.route) history.replaceState(null, '', location.pathname + outcome.route);
  watchRevocation();
  await start();
}

boot();
