/**
 * The customer site's entry point (docs/customer-site.md): who is signed in, following the
 * address bar, loading what each page shows, and the sign-in pages.
 *
 * Two sign-ins, each with the console's own code (core.js createAuth):
 *
 *   - a customer's, with the customer pool. Its session is kept under keys of its own in this
 *     tab's sessionStorage (customer-core.js namespaced), and it reads the customer API.
 *   - an admin's, with the staff pool and the console's own web client, password and code always.
 *     Its session is kept under the console's own keys, which is what makes admin mode one
 *     sign-in: the console, served at /admin of this same origin, finds the session in this tab
 *     and opens without asking again. No token is ever put in an address.
 *
 * The home page for people who are not signed in is HTML in the page itself; everything else is
 * drawn here into #app from the state, with views.js's render().
 *
 * In the phone app (bridge.js, docs/mobile-apps.md "The app shell") the settings come from the app, each
 * session is kept in memory with the app holding its refresh token, the two APIs are at their own
 * addresses, and a person who is not signed in starts on the sign-in page rather than the home page.
 */

import {
  CODE_LENGTH, SESSION_CHANNEL, SIGNED_OUT_SIGNAL, codeComplete, createAuth, enterCode, keyInCode,
} from './core.js';
import { h, render, toastView } from './views.js';
import {
  CUSTOMER_CHANNEL, CUSTOMER_PREFIX, PUBLIC_VIEWS, authConfig, createAccount, createCustomerApi, namespaced, parseRoute,
  passwordProblem, readSiteConfig, routeHash,
} from './customer-core.js';
import {
  accountView, aloneView, deviceView, devicesView, forgotView, helpView, mixesView, overviewView, shellView, signInView,
} from './customer-views.js';

const REFRESH_MS = 30000;
const SESSION_CHECK_MS = 5000;
const TOAST_MS = 6000;

const landing = document.getElementById('landing');
const app = document.getElementById('app');
const toasts = document.getElementById('toasts');
const announcer = document.getElementById('announcer');

// The website's settings; in the app, the app's (setUp, below).
let site = readSiteConfig(document.querySelector('meta[name="cranium-config"]')?.content);
// The phone app's bridge, in the app only; bridge.js itself is fetched only there.
let bridgeScript = null;
let appBridge = null;

function resource() {
  return { value: null, error: null, loadedAt: 0, loading: false };
}

const emptyCode = () => Array(CODE_LENGTH).fill('');

const state = {
  route: { view: 'landing' },
  // Where a page that needed a sign-in was going.
  after: null,
  customer: false,
  admin: false,
  me: resource(),
  staff: resource(),
  boards: resource(),
  activity: resource(),
  details: new Map(),
  account: {
    profile: resource(),
    password: { busy: false, problem: null, done: false },
    authenticator: { step: 'idle', secret: '', digits: emptyCode(), busy: false, problem: null, done: null },
  },
  signIn: null,
  forgot: { step: 'email', email: '', digits: emptyCode(), busy: false, problem: null },
  sessionLeft: 0,
  // In the phone app: which app, and the biometric of the customer's sign-in on this phone. Null on the website.
  app: null,
};

// The two sign-ins and their tabs' channels.

function channel(name) {
  try {
    return typeof window.BroadcastChannel === 'function' ? new window.BroadcastChannel(name) : null;
  } catch {
    return null;
  }
}

const customerChannel = channel(CUSTOMER_CHANNEL);
// The console's own: its tabs, at /admin, sign the admin out here too, and the other way round.
const consoleChannel = channel(SESSION_CHANNEL);

const common = {
  location: window.location, history: window.history, fetch: window.fetch.bind(window), crypto: window.crypto,
};
let customerAuth = null;
let adminAuth = null;
let api = null;
let account = null;
// Where the console's API is: this origin on the website, the console's address in the app.
let consoleApi = '';

/**
 * The two sign-ins and the customer API, for the site's settings. On the website each session is kept in
 * this tab's sessionStorage, the admin's under the console's own keys, which the console under /admin
 * reads. In the app each is kept in memory, and the app keeps the refresh tokens (`vaults`); the console
 * under /admin asks the app for the admin's.
 */
function setUp({ storage, vaults = null, customerBase = '' }) {
  customerAuth = createAuth({
    ...common,
    config: authConfig(site, 'customer'),
    storage: storage(CUSTOMER_PREFIX),
    newPasswordHere: true,
    tellOtherTabs: () => customerChannel?.postMessage(SIGNED_OUT_SIGNAL),
    vault: vaults?.customer ?? null,
  });
  // The console's own keys, unprefixed: what the console under /admin reads. Clearing them clears them only.
  adminAuth = createAuth({
    ...common,
    config: authConfig(site, 'admin'),
    storage: storage(''),
    tellOtherTabs: () => consoleChannel?.postMessage(SIGNED_OUT_SIGNAL),
    vault: vaults?.admin ?? null,
  });
  api = createCustomerApi({
    auth: customerAuth,
    fetch: common.fetch,
    onUnauthorized: () => customerEnded('Your session has ended. Sign in again to carry on.'),
    base: customerBase,
  });
  account = createAccount({ fetch: common.fetch, site, accessToken: () => customerAuth.accessToken() });
}

// Drawing.

let toastTimer = 0;

function clearToast() {
  clearTimeout(toastTimer);
  render(toasts, h('div', { class: 'toast-gone', key: 'none' }));
}

function toast(message) {
  clearTimeout(toastTimer);
  render(toasts, h('div', { class: 'toast', key: 'toast' }, toastView(message, clearToast)));
  announcer.textContent = message;
  toastTimer = setTimeout(clearToast, TOAST_MS);
}

const VIEWS = {
  overview: overviewView, devices: devicesView, device: deviceView, mixes: mixesView, account: accountView, help: helpView,
};
const TITLES = {
  landing: 'Cranium · Your DJ controller, without the laptop',
  'sign-in': 'Sign in', 'admin-sign-in': 'Admin sign-in', forgot: 'A new password', overview: 'Overview',
  devices: 'Devices', device: 'Your board', mixes: 'Mixes', account: 'Account', help: 'Help',
};

let drawnView = null;

function draw() {
  if (!site) return;
  const { view } = state.route;
  document.title = view === 'landing' ? TITLES.landing : `${TITLES[view] ?? 'Cranium'} · Cranium`;
  if (view === 'landing') {
    landing.hidden = false;
    app.hidden = true;
    drawnView = view;
    return;
  }
  landing.hidden = true;
  app.hidden = false;
  const ctx = context();
  let tree;
  if (view === 'sign-in' || view === 'admin-sign-in') tree = signInView(signInModel());
  else if (view === 'forgot') tree = forgotView(forgotModel());
  else if (view === 'help' && !state.customer && !state.admin) tree = aloneView(helpView(ctx));
  else tree = shellView(ctx, VIEWS[view](ctx));
  render(app, tree);
  if (drawnView !== view) {
    drawnView = view;
    window.scrollTo?.(0, 0);
    document.getElementById('page-title')?.focus();
  }
}

// Following the address bar.

const NEEDS_CUSTOMER = new Set(['devices', 'device', 'account']);
const SIGN_IN_VIEWS = new Set(['sign-in', 'admin-sign-in']);

function go(route) {
  const hash = routeHash(route);
  if (window.location.hash === hash) follow();
  else window.location.hash = hash;
}

function follow() {
  const route = parseRoute(window.location.hash);
  const signedIn = state.customer || state.admin;
  // An anchor of the home page, such as #how: the home page, scrolled there by the browser.
  if (route === null) {
    if (signedIn) {
      go({ view: 'overview' });
      return;
    }
    // The app is not a place to be told what Cranium is: it opens on the sign-in.
    if (appBridge) {
      go({ view: 'sign-in' });
      return;
    }
    state.route = { view: 'landing' };
    draw();
    return;
  }
  if (route.view === 'landing' && signedIn) return go({ view: 'overview' });
  if (route.view === 'landing' && appBridge) return go({ view: 'sign-in' });
  if (!PUBLIC_VIEWS.includes(route.view) && !signedIn) {
    state.after = route;
    return go({ view: 'sign-in' });
  }
  if (NEEDS_CUSTOMER.has(route.view) && !state.customer) return go({ view: 'overview' });
  if ((route.view === 'sign-in' && state.customer) || (route.view === 'admin-sign-in' && state.admin)) {
    return go({ view: 'overview' });
  }
  if (!SIGN_IN_VIEWS.has(route.view)) state.signIn = null;
  else beginSignIn(route.view === 'admin-sign-in' ? 'admin' : 'customer');
  if (route.view === 'forgot' && state.route.view !== 'forgot') {
    state.forgot = { step: 'email', email: lastEmail, digits: emptyCode(), busy: false, problem: null };
  }
  state.route = route;
  draw();
  refresh(true);
  return undefined;
}

// Loading.

async function load(target, read) {
  if (target.loading) return;
  target.loading = true;
  try {
    target.value = await read();
    target.error = null;
    target.loadedAt = Date.now();
  } catch (error) {
    target.error = error;
  } finally {
    target.loading = false;
  }
}

function detailOf(id) {
  if (!state.details.has(id)) state.details.set(id, resource());
  return state.details.get(id);
}

async function readProfile() {
  const profile = await account.profile();
  if (!profile.ok) {
    throw new Error(profile.problem === 'session-ended' ? 'Your session has ended.' : 'Your account could not be read.');
  }
  return profile;
}

let timer = 0;

async function refresh(full) {
  clearTimeout(timer);
  const { view } = state.route;
  const jobs = [];
  if (state.customer) {
    if (state.me.value === null) jobs.push(load(state.me, () => api.me()));
    if (view === 'overview' || view === 'devices') jobs.push(load(state.boards, () => api.boards()));
    if (view === 'overview') jobs.push(load(state.activity, () => api.activity()));
    if (view === 'device') {
      const { id } = state.route;
      jobs.push(load(detailOf(id), () => api.board(id)));
    }
    if (view === 'account' && (full || state.account.profile.value === null)) jobs.push(load(state.account.profile, readProfile));
  }
  if (state.admin && state.staff.value === null) jobs.push(load(state.staff, staffMe));
  if (view === 'account' && full && state.app) jobs.push(readBiometric());
  if (jobs.length === 0) return;
  draw();
  await Promise.all(jobs);
  draw();
  if (['overview', 'devices', 'device'].includes(view) && document.visibilityState !== 'hidden') {
    timer = setTimeout(() => refresh(false), REFRESH_MS);
  }
}

/** Who the admin is, from the console's own API: their address and whether they may change things. */
async function staffMe() {
  const token = adminAuth.accessToken();
  if (token === null) throw new Error('The admin session has ended.');
  let response;
  try {
    response = await common.fetch(`${consoleApi}/api/me`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, cache: 'no-store', credentials: 'omit',
    });
  } catch {
    throw new Error('The console could not be reached.');
  }
  if (response.status === 401) {
    adminAuth.tokenRefused();
    adminEnded();
    throw new Error('The admin session has ended.');
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || body === null) throw new Error('This account has no access to the console.');
  return { email: typeof body.email === 'string' ? body.email.slice(0, 320) : '', canWrite: body.canWrite === true };
}

// Sessions.

function customerEnded(lead) {
  if (!state.customer) return;
  state.customer = false;
  state.me = resource();
  state.boards = resource();
  state.activity = resource();
  state.details.clear();
  state.account.profile = resource();
  if (!state.admin && !PUBLIC_VIEWS.includes(state.route.view)) {
    state.after = state.route;
    state.signIn = null;
    beginSignIn('customer', lead);
    go({ view: 'sign-in' });
    return;
  }
  draw();
}

function adminEnded() {
  if (!state.admin) return;
  state.admin = false;
  state.staff = resource();
  if (!state.customer && !PUBLIC_VIEWS.includes(state.route.view)) {
    state.signIn = null;
    beginSignIn('admin', 'Your admin session has ended. Sign in again to carry on.');
    go({ view: 'admin-sign-in' });
    return;
  }
  draw();
}

let renewing = false;

function checkSessions() {
  // In the app, the app renews a session that is about to end; it is over only if the app cannot.
  if (appBridge && !renewing) {
    const due = [[state.customer, customerAuth], [state.admin, adminAuth]].filter(([on, auth]) => on && auth.inApp && auth.needsRenewal());
    if (due.length > 0) {
      renewing = true;
      Promise.all(due.map(([, auth]) => auth.renew())).finally(() => {
        renewing = false;
      });
      return;
    }
  }
  if (state.customer && customerAuth.accessToken() === null) customerEnded('Your session has ended. Sign in again to carry on.');
  if (state.admin && adminAuth.accessToken() === null) adminEnded();
  if (state.customer) state.sessionLeft = customerAuth.secondsLeft();
}

function signOut() {
  clearTimeout(timer);
  // The admin's keys first, then the customer's, whose sign-out takes the tab home.
  if (state.admin && state.customer) {
    adminAuth.signedOutElsewhere();
    consoleChannel?.postMessage(SIGNED_OUT_SIGNAL);
    // In the app the admin's sign-in is kept by the app: it forgets and revokes that one too.
    if (adminAuth.inApp) appBridge.call('auth.signOut', { pool: 'admin' }).catch(() => {});
    customerAuth.signOut();
  } else if (state.customer) {
    customerAuth.signOut();
  } else if (state.admin) {
    adminAuth.signOut();
  }
}

// Sign-in pages.

let lastEmail = '';
let passwordField = null;
let currentField = null;
let newField = null;
let againField = null;

const authOf = (kind) => (kind === 'admin' ? adminAuth : customerAuth);

/** The sign-in page of one kind, fresh unless one of that kind is under way; `lead` says why it is shown. */
function beginSignIn(kind, lead = null) {
  if (state.signIn?.kind === kind && lead === null) return;
  authOf(kind).cancelPasswordSignIn();
  state.signIn = { kind, step: 'password', email: lastEmail, digits: emptyCode(), busy: false, problem: null, tries: 0, lead };
}

function setSignIn(changes) {
  state.signIn = { ...state.signIn, ...changes };
  draw();
}

function focusOn(id) {
  const el = document.getElementById(id);
  el?.focus();
  el?.select?.();
}

const focusBox = (prefix, index) => focusOn(`${prefix}-digit-${index + 1}`);

function afterStep(outcome) {
  if (!state.signIn) return;
  const { kind } = state.signIn;
  const tries = state.signIn.tries + 1;
  if (outcome.step === 'done') {
    signedIn(kind);
  } else if (outcome.step === 'code') {
    const cleared = !outcome.problem || outcome.problem === 'wrong-code' || outcome.problem === 'too-many';
    setSignIn({ step: 'code', busy: false, problem: outcome.problem ?? null, tries, digits: cleared ? emptyCode() : state.signIn.digits });
    if (cleared) focusBox('code', 0);
  } else if (outcome.step === 'new-password') {
    setSignIn({ step: 'new-password', busy: false, problem: outcome.problem ?? null, tries });
    focusOn('first-password');
  } else if (outcome.step === 'elsewhere') {
    setSignIn({ step: 'elsewhere', busy: false, problem: null, tries });
  } else {
    setSignIn({ step: 'password', busy: false, problem: outcome.problem ?? 'failed', tries, digits: emptyCode() });
    focusOn(state.signIn.email === '' ? 'signin-email' : 'signin-password');
  }
}

async function signedIn(kind) {
  state.signIn = null;
  if (kind === 'customer') {
    state.customer = true;
    state.sessionLeft = customerAuth.secondsLeft();
  } else {
    state.admin = true;
  }
  const after = kind === 'customer' && state.after ? state.after : { view: 'overview' };
  state.after = null;
  go(after);
  const revoked = await authOf(kind).revocation();
  if (revoked === 'refused' || revoked === 'failed') {
    toast('The sign-in service did not confirm that the unused refresh token was revoked. It expires by itself within the hour.');
  }
}

/** The six boxes of a code, for whichever form holds them. `whenFull` sends a code once all six are in. */
function boxes(read, write, prefix, whenFull = null) {
  const entered = (digits, focus) => {
    write({ digits, problem: null });
    focusBox(prefix, focus);
    if (whenFull && codeComplete(digits) && !read().busy) whenFull();
  };
  return {
    enterDigits(index, text) {
      const { digits, focus } = enterCode(read().digits, index, text);
      entered(digits, focus);
    },
    pasteDigits(index, event) {
      const text = event.clipboardData?.getData('text') ?? '';
      event.preventDefault();
      const { digits, focus } = enterCode(read().digits, index, text);
      entered(digits, focus);
    },
    keyInBox(index, event) {
      const moved = keyInCode(read().digits, index, event.key);
      if (moved === null) return;
      event.preventDefault();
      write({ digits: moved.digits });
      focusBox(prefix, moved.focus);
    },
  };
}

const fieldRefs = {
  passwordRef: (el) => {
    passwordField = el;
  },
  newRef: (el) => {
    newField = el;
  },
  againRef: (el) => {
    againField = el;
  },
};

const signInControls = {
  ...fieldRefs,
  setEmail(value) {
    lastEmail = value;
    state.signIn = { ...state.signIn, email: value };
  },
  async submitPassword() {
    const password = passwordField?.value ?? '';
    if (passwordField) passwordField.value = '';
    setSignIn({ busy: true, problem: null });
    afterStep(await authOf(state.signIn.kind).passwordSignIn(state.signIn.email, password));
  },
  async submitCode() {
    if (!codeComplete(state.signIn.digits)) {
      setSignIn({ problem: 'short-code', tries: state.signIn.tries + 1 });
      return;
    }
    setSignIn({ busy: true, problem: null });
    afterStep(await authOf(state.signIn.kind).sendCode(state.signIn.digits.join('')));
  },
  async submitNewPassword() {
    const next = newField?.value ?? '';
    const problem = passwordProblem(next, againField?.value ?? '');
    if (problem) {
      setSignIn({ problem, tries: state.signIn.tries + 1 });
      return;
    }
    for (const field of [newField, againField]) if (field) field.value = '';
    setSignIn({ busy: true, problem: null });
    afterStep(await authOf(state.signIn.kind).sendNewPassword(next));
  },
  startOver() {
    authOf(state.signIn.kind).cancelPasswordSignIn();
    setSignIn({ step: 'password', busy: false, problem: null, digits: emptyCode() });
    focusOn('signin-password');
  },
  ...boxes(() => state.signIn, setSignIn, 'code', () => signInControls.submitCode()),
};

function signInModel() {
  // Between a finished sign-in and the page it leads to, the page it came from is drawn once more.
  const model = state.signIn ?? {
    kind: state.route.view === 'admin-sign-in' ? 'admin' : 'customer', step: 'password', email: lastEmail,
    digits: emptyCode(), busy: true, problem: null, tries: 0, lead: null,
  };
  return { ...model, ...signInControls, adminPath: site.adminPath };
}

function setForgot(changes) {
  state.forgot = { ...state.forgot, ...changes };
  draw();
}

const forgotControls = {
  ...fieldRefs,
  setEmail(value) {
    lastEmail = value;
    state.forgot = { ...state.forgot, email: value };
  },
  async submitEmail() {
    setForgot({ busy: true, problem: null });
    const result = await account.forgotPassword(state.forgot.email);
    if (result.ok) {
      setForgot({ step: 'code', busy: false, digits: emptyCode() });
      focusBox('reset', 0);
    } else {
      setForgot({ busy: false, problem: result.problem });
    }
  },
  async submitReset() {
    const next = newField?.value ?? '';
    const problem = codeComplete(state.forgot.digits) ? passwordProblem(next, againField?.value ?? '') : 'short-code';
    if (problem) {
      setForgot({ problem });
      return;
    }
    setForgot({ busy: true, problem: null });
    const result = await account.confirmForgotPassword(state.forgot.email, state.forgot.digits.join(''), next);
    if (result.ok) {
      for (const field of [newField, againField]) if (field) field.value = '';
      setForgot({ step: 'done', busy: false });
    } else {
      setForgot({ busy: false, problem: result.problem, digits: result.problem === 'wrong-code' ? emptyCode() : state.forgot.digits });
    }
  },
  startOver() {
    setForgot({ step: 'email', problem: null, digits: emptyCode() });
  },
  // The code of a reset goes with the new password, so it is not sent by itself.
  ...boxes(() => state.forgot, setForgot, 'reset'),
};

function forgotModel() {
  return { ...state.forgot, ...forgotControls };
}

// The account page.

function setPassword(changes) {
  state.account.password = { ...state.account.password, ...changes };
  draw();
}

const passwordControls = {
  refs: {
    current: (el) => {
      currentField = el;
    },
    next: fieldRefs.newRef,
    again: fieldRefs.againRef,
  },
  async submit() {
    const current = currentField?.value ?? '';
    const next = newField?.value ?? '';
    const problem = passwordProblem(next, againField?.value ?? '');
    if (problem) {
      setPassword({ problem, done: false });
      return;
    }
    setPassword({ busy: true, problem: null, done: false });
    const result = await account.changePassword(current, next);
    if (result.ok) for (const field of [currentField, newField, againField]) if (field) field.value = '';
    setPassword({ busy: false, problem: result.ok ? null : result.problem, done: result.ok });
  },
};

function setAuthenticator(changes) {
  state.account.authenticator = { ...state.account.authenticator, ...changes };
  draw();
}

const authenticatorControls = {
  async start() {
    setAuthenticator({ busy: true, problem: null, done: null });
    const result = await account.startAuthenticator();
    if (result.ok) setAuthenticator({ step: 'secret', secret: result.secret, digits: emptyCode(), busy: false });
    else setAuthenticator({ busy: false, problem: result.problem });
  },
  async confirm() {
    const { digits } = state.account.authenticator;
    if (!codeComplete(digits)) {
      setAuthenticator({ problem: 'short-code' });
      return;
    }
    setAuthenticator({ busy: true, problem: null });
    const result = await account.confirmAuthenticator(digits.join(''));
    if (!result.ok) {
      setAuthenticator({ busy: false, problem: result.problem, digits: emptyCode() });
      focusBox('mfa', 0);
      return;
    }
    await load(state.account.profile, readProfile);
    setAuthenticator({
      step: 'idle', secret: '', busy: false, done: 'Two-step sign-in is on. From your next sign-in, Cranium asks for a code too.',
    });
  },
  askToStop() {
    setAuthenticator({ step: 'confirm-off', problem: null, done: null });
  },
  async stop() {
    setAuthenticator({ busy: true, problem: null });
    const result = await account.stopAuthenticator();
    if (result.ok) await load(state.account.profile, readProfile);
    setAuthenticator({
      step: result.ok ? 'idle' : 'confirm-off', busy: false, problem: result.ok ? null : result.problem,
      done: result.ok ? 'Two-step sign-in is off.' : null,
    });
  },
  cancel() {
    setAuthenticator({ step: 'idle', secret: '', problem: null, busy: false });
  },
  async copy() {
    try {
      const { secret } = state.account.authenticator;
      if (appBridge?.has('clipboard')) await appBridge.call('clipboard.write', { text: secret, expiresIn: 600 });
      else await window.navigator.clipboard.writeText(secret);
      toast('The setup key is copied.');
    } catch {
      toast('It could not be copied. Select the key and copy it by hand.');
    }
  },
  ...boxes(() => state.account.authenticator, setAuthenticator, 'mfa', () => authenticatorControls.confirm()),
};

/** What the views are given: the state, with the controls of the account page beside its data. */
function context() {
  return {
    state: {
      ...state,
      account: {
        ...state.account,
        password: { ...state.account.password, ...passwordControls },
        authenticator: { ...state.account.authenticator, ...authenticatorControls },
      },
    },
    site,
    actions: { refresh: () => refresh(true), signOut, ...appActions },
    now: Date.now(),
  };
}

// The phone app's own controls on the Account page: the biometric of this sign-in, and the app's settings.
const appActions = {
  appSettings: () => appBridge?.call('app.settings').catch(() => toast('The app could not show its settings.')),
  async setBiometric(enabled) {
    if (!appBridge?.has('biometric')) return;
    try {
      const answer = await appBridge.call('biometric.set', { pool: 'customer', enabled });
      state.app = { ...state.app, biometric: { ...state.app.biometric, enabled: answer.enabled === true } };
    } catch (error) {
      if (error?.code !== 'cancelled') toast(error?.message ?? 'The app could not change that.');
    }
    draw();
  },
};

/** The biometric of the customer's sign-in on this phone, for the Account page. */
async function readBiometric() {
  if (!appBridge?.has('biometric') || !state.customer) return;
  try {
    const answer = await appBridge.call('biometric.status', { pool: 'customer' });
    const kinds = { faceID: 'Face ID', touchID: 'Touch ID', fingerprint: 'fingerprint' };
    state.app = {
      ...state.app,
      biometric: { available: answer.available === true, enabled: answer.enabled === true, name: kinds[answer.kind] ?? null },
    };
    draw();
  } catch {
    // The page goes without the switch.
  }
}

// Starting.

/** In the app: the settings and the sessions from the app. False when the app has no customer side to show. */
async function fromApp() {
  try {
    const inApp = Boolean(window.webkit?.messageHandlers?.cranium || window.craniumNative);
    bridgeScript = inApp ? await import('./bridge.js') : null;
    appBridge = bridgeScript ? await bridgeScript.connectBridge(window) : null;
  } catch (error) {
    console.error(error);
    site = null;
    return true;
  }
  if (!appBridge) return true;
  const config = bridgeScript.readAppConfig(await appBridge.call('app.config').catch(() => null));
  site = config ? bridgeScript.appSiteConfig(config, window.location.origin) : null;
  // A build of the app without the customer pool: admin mode is all there is.
  if (config && !site) {
    window.location.replace('/admin');
    return false;
  }
  state.app = { words: bridgeScript.appWords(appBridge.hello), biometric: null };
  appBridge.on('auth.locked', () => window.location.reload());
  appBridge.on('app.bundleReady', () => toast('The app has new pages from Cranium. They show the next time it opens.'));
  return true;
}

async function start() {
  if (!(await fromApp())) return;
  if (!site) return;
  if (appBridge) {
    consoleApi = site.consoleApi;
    const vault = appBridge.has('auth');
    setUp({
      storage: () => bridgeScript.memoryStorage(),
      vaults: vault ? { customer: bridgeScript.createVault(appBridge, 'customer'), admin: bridgeScript.createVault(appBridge, 'admin') } : null,
      customerBase: site.customerApi,
    });
  } else {
    setUp({ storage: (prefix) => namespaced(window.sessionStorage, prefix) });
  }
  const [mine, theirs] = await Promise.all([customerAuth.resume(), adminAuth.resume()]);
  state.customer = mine.status === 'signed-in';
  state.admin = theirs.status === 'signed-in';
  if (state.customer) state.sessionLeft = customerAuth.secondsLeft();
  customerChannel?.addEventListener('message', (event) => {
    if (event.data !== SIGNED_OUT_SIGNAL || !state.customer) return;
    customerAuth.signedOutElsewhere();
    customerEnded('You signed out in another tab.');
  });
  consoleChannel?.addEventListener('message', (event) => {
    if (event.data !== SIGNED_OUT_SIGNAL || !state.admin) return;
    adminAuth.signedOutElsewhere();
    adminEnded();
  });
  window.addEventListener('hashchange', follow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh(false);
  });
  setInterval(checkSessions, SESSION_CHECK_MS);
  document.getElementById('skip')?.addEventListener('click', () => {
    (document.getElementById('content') ?? document.getElementById('page-title') ?? document.getElementById('landing-main'))?.focus();
  });
  follow();
  // The pages have started: the app keeps this bundle as a good one.
  appBridge?.call('app.ready').catch(() => {});
}

start();
