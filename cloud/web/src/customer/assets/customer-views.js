/**
 * Everything the customer site (docs/customer-site.md) draws once it is running: the frame of a
 * signed-in page, its pages, and its sign-in pages. The home page for people who are not signed
 * in is plain HTML in the page itself, so that it reads without JavaScript.
 *
 * It draws with the console's own renderer and pieces (views.js): h() describes elements, and
 * render() can only make elements, set attributes and set text, so nothing from the API or from
 * Cognito can become markup. The look is the console's stylesheet (app.css) with a few layouts of
 * the site's own (customer.css).
 *
 * The layout follows the mockup the owner chose: a dark sidebar of the studio's sections, a bar on
 * top with how the boards are, Export and Connect device, and pages of mixes (customer-mix-views.js)
 * beside the boards. Boards do not send what they play yet, so the mixes are the demo, which says
 * it is made up wherever it shows, or the customer's own journal of the session files they import.
 */

import { CODE_LENGTH, SIGN_IN_WORDS, dateAndTime, duration, exactTime, signalQuality, timeAgo } from './core.js';
import { badge, brandMark, button, card, domeArt, empty, facts, h, icon, notice, signalBars } from './views.js';
import {
  ACCOUNT_WORDS,
  BOARDS_EYEBROW,
  BOARDS_LEDE,
  FOOT_NOTE,
  MIXES_EYEBROW,
  MIXES_LEDE,
  MIXES_TITLE,
  MIX_TABS,
  PASSWORD_MIN,
  WELCOME,
  boardTitle,
  eventWords,
  groupSecret,
  initials,
  onlineWords,
  otpauthUri,
  plural,
  shortVersion,
  signalWords,
  statusWords,
  summarize,
  updateWords,
} from './customer-core.js';
import {
  libraryList,
  mixDialog,
  mixIcon,
  mixTools,
  momentsList,
  overviewMixes,
  sessionPage,
  sessionsList,
  transitionsList,
} from './customer-mix-views.js';

// Icons the console does not have, drawn the same way: 24 by 24, stroked in the text colour.
const SITE_ICONS = {
  grid: [
    ['rect', { x: 4, y: 4, width: 7, height: 7, rx: 1.5 }],
    ['rect', { x: 13, y: 4, width: 7, height: 7, rx: 1.5 }],
    ['rect', { x: 4, y: 13, width: 7, height: 7, rx: 1.5 }],
    ['rect', { x: 13, y: 13, width: 7, height: 7, rx: 1.5 }],
  ],
  disc: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['circle', { cx: 12, cy: 12, r: 2.5 }],
    ['path', { d: 'M12 6.5a5.5 5.5 0 0 1 5.5 5.5' }],
  ],
  help: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.7M12 17v.1' }],
  ],
  external: [
    ['path', { d: 'M14 4.5h5.5V10M19.5 4.5L11 13' }],
    ['path', { d: 'M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10' }],
  ],
};

function siteIcon(name, className = '') {
  const shapes = SITE_ICONS[name];
  if (!shapes) return icon(name, className);
  return h(
    'svg',
    { class: `icon ${className}`.trim(), viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    shapes.map(([tag, attributes]) => h(tag, attributes))
  );
}

/** A time as "3 min ago", with the exact time for a pointer and in the markup. */
function ago(iso, now) {
  if (!iso) return '—';
  return h('time', { datetime: iso, title: exactTime(iso) }, timeAgo(iso, now));
}

// The frame of a signed-in page.

// [the section, its address, its name, its icon]: the mixes first, as in the mockup, then the boards.
const WORKSPACE = Object.freeze([
  ['overview', '#/overview', 'Overview', 'grid'],
  ['mixes:sessions', '#/mixes/sessions', 'Sessions', 'layers'],
  ['mixes:transitions', '#/mixes/transitions', 'Transitions', 'swap'],
  ['mixes:library', '#/mixes/library', 'Track library', 'note'],
  ['mixes:moments', '#/mixes/moments', 'Saved moments', 'bookmark'],
]);
const CRANIUM = Object.freeze([
  ['devices', '#/devices', 'Devices', 'chip'],
  ['account', '#/account', 'Account', 'user'],
  ['help', '#/help', 'Help', 'help'],
]);
// The tab bar of a small screen: the five a phone needs most. Account and Help are in its top bar.
const TABS = Object.freeze(['overview', 'mixes:sessions', 'mixes:transitions', 'mixes:library', 'devices']);
const SHORT = { 'mixes:library': 'Library', 'mixes:moments': 'Moments' };
const TITLES = {
  overview: 'Overview',
  devices: 'Devices',
  device: 'Device',
  account: 'Account',
  help: 'Help',
  session: 'Session',
  'mixes:sessions': 'Sessions',
  'mixes:transitions': 'Transitions',
  'mixes:library': 'Track library',
  'mixes:moments': 'Saved moments',
};

/** The section a page is in: a board is in Devices, a session in Sessions, a tab of the mixes its own. */
function sectionOf(route) {
  if (route.view === 'device') return 'devices';
  if (route.view === 'session') return 'mixes:sessions';
  if (route.view === 'mixes') return `mixes:${route.tab ?? 'sessions'}`;
  return route.view;
}

function siteOrMixIcon(name) {
  return SITE_ICONS[name] ? siteIcon(name) : mixIcon(name);
}

function navLinks(items, current, className, ctx, { short = false } = {}) {
  return items.map(([section, href, label, iconName]) =>
    h(
      'li',
      { key: section },
      h(
        'a',
        {
          class: className,
          href,
          'aria-current': section === current ? 'page' : null,
        },
        siteOrMixIcon(iconName),
        h('span', { class: 'cs-nav-label' }, short ? (SHORT[section] ?? label) : label),
        section === 'mixes:moments' && ctx
          ? h(
              'span',
              { class: 'cs-nav-count', 'aria-label': `, ${ctx.mixes.journal.moments.length} kept` },
              String(ctx.mixes.journal.moments.length)
            )
          : null
      )
    )
  );
}

function brand(sub) {
  return h(
    'a',
    { class: 'cs-brand', href: '#/overview' },
    brandMark(),
    h(
      'span',
      { class: 'cs-brand-text' },
      h('span', { class: 'cs-brand-name' }, 'Cranium'),
      h('span', { class: 'cs-brand-sub' }, sub)
    )
  );
}

/** The figure in the top bar and the sidebar: how the boards are, in a word or two. */
function boardsBadge(ctx) {
  const boards = ctx.state.boards.value;
  if (!ctx.state.customer || boards === null) return null;
  const summary = summarize(boards);
  const live = summary.online > 0;
  return h(
    'a',
    { class: `cs-top-status ${live ? 'is-live' : ''}`.trim(), href: '#/devices', title: 'Your boards' },
    h('span', { class: 'cs-top-status-dot', 'aria-hidden': 'true' }),
    onlineWords(summary)
  );
}

function adminButton(ctx, className = '') {
  if (!ctx.state.admin) return null;
  return h(
    'a',
    { class: `btn is-primary is-small cs-admin-mode ${className}`.trim(), href: ctx.site.adminPath },
    icon('key'),
    h('span', null, 'Admin mode')
  );
}

function who(ctx) {
  const person = ctx.state.customer ? ctx.state.me.value : ctx.state.staff.value;
  const email = person?.email ?? '';
  return h(
    'div',
    { class: 'cs-who' },
    h('span', { class: 'cs-avatar', 'aria-hidden': 'true' }, initials(person?.name, email)),
    h(
      'span',
      { class: 'cs-who-text' },
      h('span', { class: 'cs-who-email', title: email || null }, email || 'Signed in'),
      h('span', { class: 'cs-who-role' }, ctx.state.customer ? 'Your studio' : roleOf(ctx))
    ),
    button('is-small is-quiet cs-sign-out', ctx.actions.signOut, icon('sign-out'), h('span', null, 'Sign out'))
  );
}

function roleOf(ctx) {
  const me = ctx.state.staff.value;
  if (!me) return 'Admin';
  return me.canWrite ? 'Admin · release manager' : 'Admin · viewer';
}

/** A signed-in page: the sidebar, the top bar, the page, the tab bar of a small screen, and a dialog. */
export function shellView(ctx, page) {
  const current = sectionOf(ctx.state.route);
  return h(
    'div',
    { class: 'cs-shell' },
    h(
      'aside',
      { class: 'cs-side on-ink' },
      brand('Your studio'),
      h(
        'nav',
        { class: 'cs-nav', 'aria-label': 'Sections' },
        h('p', { class: 'eyebrow cs-nav-title' }, 'Your workspace'),
        h('ul', { class: 'cs-nav-list' }, navLinks(WORKSPACE, current, 'cs-nav-link', ctx)),
        h('p', { class: 'eyebrow cs-nav-title' }, 'Your Cranium'),
        h('ul', { class: 'cs-nav-list' }, navLinks(CRANIUM, current, 'cs-nav-link'))
      ),
      h(
        'div',
        { class: 'cs-side-foot' },
        h(
          'div',
          { class: 'cs-side-card' },
          siteIcon('chip'),
          h('p', { class: 'cs-side-card-title' }, 'Your deck, a little more connected.'),
          h('p', { class: 'cs-side-card-text' }, 'Bring the moments of your mix back to your laptop.'),
          h(
            'button',
            { type: 'button', class: 'cs-side-card-link', onClick: () => ctx.actions.mix.open({ kind: 'connect' }) },
            'Connect your board',
            icon('arrow-right')
          )
        ),
        adminButton(ctx),
        who(ctx)
      )
    ),
    h(
      'div',
      { class: 'cs-body' },
      h(
        'header',
        { class: 'cs-top' },
        h('div', { class: 'cs-top-brand' }, brand('Your studio')),
        h(
          'p',
          { class: 'cs-crumbs' },
          h('span', null, 'Your studio'),
          h('span', { class: 'cs-crumbs-sep', 'aria-hidden': 'true' }, '/'),
          h('span', { class: 'cs-crumbs-here' }, TITLES[current] ?? '')
        ),
        h(
          'div',
          { class: 'cs-top-tools' },
          boardsBadge(ctx),
          h(
            'button',
            {
              type: 'button',
              class: 'btn is-icon is-quiet cs-export',
              'aria-label': 'Export or back up your journal',
              title: 'Export or back up your journal',
              onClick: () => ctx.actions.mix.open({ kind: 'export' }),
            },
            icon('download')
          ),
          h(
            'a',
            { class: 'btn is-icon is-quiet cs-top-account', href: '#/account', 'aria-label': 'Account' },
            icon('user')
          ),
          adminButton(ctx, 'is-top'),
          h(
            'button',
            { type: 'button', class: 'btn cs-connect', onClick: () => ctx.actions.mix.open({ kind: 'connect' }) },
            mixIcon('bluetooth'),
            h('span', null, 'Connect device')
          )
        )
      ),
      h('main', { class: 'cs-main', id: 'content', tabindex: '-1' }, page),
      h(
        'footer',
        { class: 'cs-foot' },
        h('span', null, 'Cranium · a little memory for every mix'),
        h('span', null, FOOT_NOTE)
      )
    ),
    h(
      'nav',
      { class: 'cs-tabbar on-ink', 'aria-label': 'Sections' },
      h(
        'ul',
        null,
        navLinks(
          [...WORKSPACE, ...CRANIUM].filter(([section]) => TABS.includes(section)),
          current,
          'cs-tab',
          null,
          { short: true }
        )
      )
    ),
    mixDialog(ctx)
  );
}

function head({ eyebrow, title, lede, tools }) {
  return h(
    'header',
    { class: 'cs-head' },
    h(
      'div',
      { class: 'cs-head-text' },
      eyebrow ? h('p', { class: 'eyebrow' }, eyebrow) : null,
      h('h1', { class: 'cs-title', id: 'page-title', tabindex: '-1' }, title),
      lede ? h('p', { class: 'cs-lede' }, lede) : null
    ),
    tools ? h('div', { class: 'cs-head-tools' }, tools) : null
  );
}

function problem(resource, what, ctx) {
  if (!resource.error) return null;
  return notice('bad', 'alert', [h('strong', null, `Could not load ${what}. `), resource.error.message], {
    action: button('is-small', ctx.actions.refresh, 'Try again'),
  });
}

function loadingLine(what) {
  return h('p', { class: 'loading', key: 'loading' }, `Loading ${what}…`);
}

// Overview.

function statusBadge(board, now) {
  const words = statusWords(board, now);
  return badge(words.tone, words.icon, words.label);
}

function tiles(boards, now) {
  const summary = summarize(boards);
  const versions = summary.versions;
  const firmware =
    versions.length === 0
      ? '—'
      : versions.length === 1
        ? shortVersion(versions[0])
        : plural(versions.length, 'version');
  return h(
    'div',
    { class: 'cs-tiles' },
    h(
      'div',
      { class: 'cs-tile on-ink' },
      h('p', { class: 'cs-tile-label' }, siteIcon('online', 'is-small'), 'Online now'),
      h('p', { class: 'cs-tile-value' }, summary.total === 0 ? '0' : `${summary.online} of ${summary.total}`),
      h(
        'p',
        { class: 'cs-tile-note' },
        summary.busy > 0 ? `${plural(summary.busy, 'board')} updating` : 'Each board reports every 30 s'
      )
    ),
    h(
      'div',
      { class: 'cs-tile' },
      h('p', { class: 'cs-tile-label' }, siteIcon('chip', 'is-small'), 'Boards'),
      h('p', { class: 'cs-tile-value' }, String(summary.total)),
      h('p', { class: 'cs-tile-note' }, 'On your account')
    ),
    h(
      'div',
      { class: 'cs-tile' },
      h('p', { class: 'cs-tile-label' }, siteIcon('package', 'is-small'), 'Firmware'),
      h('p', { class: 'cs-tile-value' }, firmware),
      h(
        'p',
        { class: 'cs-tile-note' },
        versions.length > 1 ? 'Not every board is on the same one' : 'Kept up to date by Cranium'
      )
    ),
    h(
      'div',
      { class: 'cs-tile' },
      h('p', { class: 'cs-tile-label' }, siteIcon('clock', 'is-small'), 'Last heard from'),
      h('p', { class: 'cs-tile-value is-time' }, summary.lastSeen ? timeAgo(summary.lastSeen, now) : '—'),
      h('p', { class: 'cs-tile-note' }, summary.lastSeen ? dateAndTime(summary.lastSeen) : 'No report yet')
    )
  );
}

function boardRow(board, now) {
  const words = statusWords(board, now);
  return h(
    'li',
    { class: 'cs-board', key: board.id },
    h(
      'a',
      { class: 'cs-board-link', href: `#/devices/${board.id}` },
      h('span', { class: 'cs-board-mark', 'aria-hidden': 'true' }, brandMark()),
      h(
        'span',
        { class: 'cs-board-main' },
        h('span', { class: 'cs-board-name' }, boardTitle(board)),
        h(
          'span',
          { class: 'cs-board-meta' },
          board.firmware ? `Firmware ${shortVersion(board.firmware.version)}` : 'Firmware not reported',
          ' · ',
          board.lastSeen ? ['Heard from ', ago(board.lastSeen, now)] : 'Not heard from yet'
        )
      ),
      h('span', { class: 'cs-board-state' }, badge(words.tone, words.icon, words.label)),
      icon('arrow-right', 'cs-board-go')
    )
  );
}

function activityList(events, boards, now, { compact = false } = {}) {
  const names = new Map((boards ?? []).map((board) => [board.id, boardTitle(board)]));
  return h(
    'ol',
    { class: `cs-activity ${compact ? 'is-compact' : ''}`.trim() },
    events.map((event, index) => {
      const words = eventWords(event);
      return h(
        'li',
        { class: 'cs-event', key: `${event.at}-${index}` },
        h('span', { class: 'cs-event-icon' }, icon(words.icon)),
        h(
          'span',
          { class: 'cs-event-main' },
          h('span', { class: 'cs-event-text' }, words.text),
          h(
            'span',
            { class: 'cs-event-meta' },
            names.size > 1 || compact ? [names.get(event.board) ?? 'A board', ' · '] : null,
            ago(event.at, now)
          )
        )
      );
    })
  );
}

/**
 * An admin without a customer account sees the customer's Overview as it is (the mixes work from the demo or
 * their own journal, kept in this browser), with admin mode where a customer sees their boards: the boards of a
 * customer come from the customer API, which an admin's sign-in does not open.
 */
function adminOverview(ctx) {
  const me = ctx.state.staff.value;
  return h(
    'div',
    { class: 'cs-page', key: 'admin' },
    head({
      eyebrow: MIXES_EYEBROW,
      title: MIXES_TITLE,
      lede: `${WELCOME} ${MIXES_LEDE}`,
      tools: mixTools(ctx),
    }),
    overviewMixes(ctx),
    h(
      'section',
      { class: 'panel on-ink cs-admin-panel', key: 'admin-panel' },
      h('p', { class: 'eyebrow' }, 'Admin mode'),
      h('h2', { class: 'cs-admin-title' }, 'The console, for every board.'),
      h(
        'p',
        { class: 'cs-admin-text' },
        (me?.email ? `Signed in as ${`${me.email} · ${me.canWrite ? 'release manager' : 'viewer'}`}. ` : '') +
          'A customer sees their own boards here. Admin mode opens the firmware console with this sign-in: the ' +
          'boards, firmware, deployments, the activity log, and the Customers page, where you invite customers and ' +
          'give them their boards.'
      ),
      h('a', { class: 'btn is-primary is-large', href: ctx.site.adminPath }, icon('key'), 'Open admin mode')
    )
  );
}

export function overviewView(ctx) {
  if (!ctx.state.customer) return adminOverview(ctx);
  const { boards, activity, me } = ctx.state;
  const name = me.value?.name || '';
  const list = boards.value;
  return h(
    'div',
    { class: 'cs-page', key: 'overview' },
    head({
      eyebrow: MIXES_EYEBROW,
      title: MIXES_TITLE,
      lede: `${name ? `Hello, ${name}.` : WELCOME} ${MIXES_LEDE}`,
      tools: mixTools(ctx),
    }),
    overviewMixes(ctx),
    h(
      'section',
      { class: 'cs-boards-part', key: 'boards-part', 'aria-labelledby': 'boards-title' },
      h(
        'header',
        { class: 'cs-section-head' },
        h(
          'div',
          { class: 'cs-boards-head' },
          h('p', { class: 'eyebrow' }, BOARDS_EYEBROW),
          h('h2', { class: 'cs-section-title', id: 'boards-title' }, 'Your boards'),
          h('p', { class: 'cs-card-lede' }, BOARDS_LEDE)
        ),
        list && list.length > 0
          ? h('a', { class: 'cs-link-quiet', href: '#/devices' }, 'All devices', icon('arrow-right'))
          : null
      ),
      problem(boards, 'your boards', ctx),
      list === null
        ? boards.error
          ? null
          : loadingLine('your boards')
        : [
            tiles(list, ctx.now),
            h(
              'div',
              { class: 'cs-columns', key: 'board-columns' },
              h(
                'div',
                { class: 'cs-column' },
                card(
                  { key: 'boards', title: 'On your account' },
                  list.length === 0
                    ? empty({
                        iconName: 'chip',
                        title: 'No boards on your account yet.',
                        text: 'Once Cranium gives you a board, it shows here.',
                      })
                    : h(
                        'ul',
                        { class: 'cs-boards' },
                        list.map((board) => boardRow(board, ctx.now))
                      )
                )
              ),
              h(
                'div',
                { class: 'cs-column is-side' },
                card(
                  { key: 'activity', title: 'Lately' },
                  problem(activity, 'what your boards did', ctx),
                  activity.value === null
                    ? activity.error
                      ? null
                      : loadingLine('what your boards did')
                    : activity.value.length === 0
                      ? h('p', { class: 'card-note' }, 'Nothing in the last week.')
                      : activityList(activity.value.slice(0, 6), list, ctx.now, { compact: true })
                )
              )
            ),
          ]
    )
  );
}

// Devices.

/** What an admin without a customer account sees where a customer sees their boards or their account. */
function adminElsewhere(ctx, { key, title, lede, text }) {
  return h(
    'div',
    { class: 'cs-page', key },
    head({ eyebrow: 'Admin', title, lede }),
    card(
      { title: 'In admin mode' },
      h('p', { class: 'card-note' }, text),
      h('a', { class: 'btn is-primary', href: ctx.site.adminPath }, icon('key'), 'Open admin mode')
    )
  );
}

export function devicesView(ctx) {
  if (!ctx.state.customer) {
    return adminElsewhere(ctx, {
      key: 'admin-devices',
      title: 'Boards, for admins',
      lede: 'You are signed in as an admin, not as a customer.',
      text:
        "This page lists the boards on a customer's account. Yours are all the boards, with their firmware, " +
        'deployments and which customer has which, in the console.',
    });
  }
  const { boards } = ctx.state;
  const list = boards.value;
  return h(
    'div',
    { class: 'cs-page', key: 'devices' },
    head({ eyebrow: 'Your studio', title: 'Your boards', lede: 'Every Cranium on your account, as it last reported.' }),
    problem(boards, 'your boards', ctx),
    list === null
      ? boards.error
        ? null
        : loadingLine('your boards')
      : list.length === 0
        ? empty({
            iconName: 'chip',
            title: 'No boards on your account yet.',
            text: 'Once Cranium gives you a board, it shows here.',
          })
        : h(
            'div',
            { class: 'cs-table-wrap' },
            h(
              'table',
              { class: 'cs-table' },
              h('caption', { class: 'sr-only' }, 'Your boards'),
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', { scope: 'col' }, 'Board'),
                  h('th', { scope: 'col' }, 'State'),
                  h('th', { scope: 'col' }, 'Firmware'),
                  h('th', { scope: 'col' }, 'Last heard from'),
                  h('th', { scope: 'col' }, 'Update')
                )
              ),
              h(
                'tbody',
                null,
                list.map((board) => {
                  const words = statusWords(board, ctx.now);
                  return h(
                    'tr',
                    { key: board.id },
                    h(
                      'th',
                      { scope: 'row', 'data-label': 'Board' },
                      h('a', { class: 'cs-table-name', href: `#/devices/${board.id}` }, boardTitle(board)),
                      board.boardName && board.boardName !== board.name
                        ? h('span', { class: 'cs-table-sub mono' }, board.boardName)
                        : null
                    ),
                    h('td', { 'data-label': 'State' }, badge(words.tone, words.icon, words.label)),
                    h(
                      'td',
                      { 'data-label': 'Firmware' },
                      board.firmware ? h('span', { class: 'mono' }, shortVersion(board.firmware.version)) : '—'
                    ),
                    h('td', { 'data-label': 'Last heard from' }, ago(board.lastSeen, ctx.now)),
                    h('td', { 'data-label': 'Update', class: 'cs-table-update' }, updateWords(board) ?? '—')
                  );
                })
              )
            )
          )
  );
}

export function deviceView(ctx) {
  const detail = ctx.state.details.get(ctx.state.route.id);
  const back = h('a', { class: 'back', href: '#/devices' }, icon('arrow-left'), 'All devices');
  if (!detail || (detail.value === null && !detail.error)) {
    return h('div', { class: 'cs-page', key: 'device' }, back, loadingLine('the board'));
  }
  if (detail.value === null) {
    return h(
      'div',
      { class: 'cs-page', key: 'device' },
      back,
      detail.error.status === 404
        ? empty({
            iconName: 'chip',
            title: 'There is no board of yours here.',
            text: 'It may have been moved to another account.',
          })
        : problem(detail, 'the board', ctx)
    );
  }
  const { board, activity } = detail.value;
  const words = statusWords(board, ctx.now);
  const quality = signalQuality(board.rssi);
  const update = updateWords(board);
  return h(
    'div',
    { class: 'cs-page', key: `device-${board.id}` },
    back,
    head({
      eyebrow: board.boardName && board.boardName !== board.name ? `Board ${board.boardName}` : 'Board',
      title: boardTitle(board),
      lede: words.text,
      tools: badge(words.tone, words.icon, words.label),
    }),
    problem(detail, 'the board', ctx),
    h(
      'div',
      { class: 'cs-columns' },
      h(
        'div',
        { class: 'cs-column' },
        card(
          { key: 'facts', title: 'How it is' },
          facts([
            ['State', badge(words.tone, words.icon, words.label)],
            [
              'Firmware',
              board.firmware
                ? [
                    h('span', { class: 'mono fact-strong' }, shortVersion(board.firmware.version)),
                    board.firmware.confirmed ? null : h('span', { class: 'tag is-warn' }, 'On trial'),
                  ]
                : 'Not reported yet',
            ],
            [
              'Last heard from',
              board.lastSeen
                ? [ago(board.lastSeen, ctx.now), h('span', { class: 'quiet' }, dateAndTime(board.lastSeen))]
                : 'Not yet',
            ],
            ['Update', update ?? '—'],
            ['Wi-Fi signal', quality ? [signalBars(quality, !board.online), signalWords(board.rssi)] : 'Not reported'],
            ['Running for', board.online && Number.isFinite(board.uptime) ? duration(board.uptime) : '—'],
            ['Location', h('span', { class: 'quiet' }, 'Not reported: boards cannot tell where they are yet.')],
            ['Yours since', board.since ? dateAndTime(board.since) : '—'],
          ])
        ),
        h(
          'p',
          { class: 'cs-note' },
          icon('shield'),
          h(
            'span',
            null,
            'Cranium sends firmware updates, signed, and the board checks each one before it keeps it. ' +
              'There is nothing for you to do; a board installs an update while it is on and online.'
          )
        )
      ),
      h(
        'div',
        { class: 'cs-column is-side' },
        card(
          { key: 'activity', title: 'What it did', more: null },
          activity.length === 0
            ? h('p', { class: 'card-note' }, 'Nothing in the last 30 days.')
            : activityList(activity, [board], ctx.now)
        )
      )
    )
  );
}

// Mixes: the pages of customer-mix-views.js, under the words each tab has had since the first site.

const MIX_WORDS = Object.freeze({
  sessions: {
    label: 'Sessions',
    title: 'Every set has a story.',
    text: 'Each time you play, a session: when it started, how long it ran, and the tracks in the order you played them, deck by deck.',
  },
  transitions: {
    label: 'Transitions',
    title: 'The space between tracks.',
    text: 'Which tracks you put together, and how long both decks played at once.',
  },
  library: {
    label: 'Track library',
    title: 'Your rotation, revealed.',
    text: 'The tracks you keep coming back to, across every session, ranked by how often you play them.',
  },
  moments: {
    label: 'Saved moments',
    title: 'Keep the good ones.',
    text: 'A note on a transition worth trying again, kept with your account for your next set.',
  },
});
const MIX_PAGES = { sessions: sessionsList, transitions: transitionsList, library: libraryList, moments: momentsList };

export function mixesView(ctx) {
  const tab = MIX_TABS.includes(ctx.state.route.tab) ? ctx.state.route.tab : 'sessions';
  const words = MIX_WORDS[tab];
  return h(
    'div',
    { class: 'cs-page', key: `mixes-${tab}` },
    head({
      eyebrow: MIXES_EYEBROW,
      title: words.title,
      lede: words.text,
      tools: tab === 'moments' ? null : mixTools(ctx),
    }),
    MIX_PAGES[tab](ctx)
  );
}

export function sessionView(ctx) {
  const session = ctx.mixes.find(ctx.state.route.id);
  const back = h('a', { class: 'back', href: '#/mixes/sessions' }, icon('arrow-left'), 'All sessions');
  if (!session) {
    return h(
      'div',
      { class: 'cs-page', key: 'session' },
      back,
      empty({
        iconName: 'list',
        title: 'There is no such session here.',
        text: 'It may have been removed from your journal, or be in another browser.',
      })
    );
  }
  return h(
    'div',
    { class: 'cs-page', key: `session-${session.id}` },
    back,
    head({
      eyebrow: session.source === 'demo' ? 'A session of the demo' : 'A session of your journal',
      title: session.title,
    }),
    sessionPage(ctx, session)
  );
}

// Account.

function passwordField(id, label, autocomplete, ref, hint) {
  return h(
    'label',
    { class: 'field', key: id },
    h('span', { class: 'field-label' }, label),
    h('input', {
      class: 'input',
      id,
      type: 'password',
      autocomplete,
      ref,
      'aria-describedby': hint ? `${id}-hint` : null,
    }),
    hint ? h('span', { class: 'field-hint', id: `${id}-hint` }, hint) : null
  );
}

function problemLine(key, words, id) {
  if (!key) return null;
  return h(
    'p',
    { class: 'signin-problem', id, role: 'alert' },
    icon('alert'),
    h('span', null, words[key] ?? words.failed)
  );
}

function codeBoxes(model, { label, hint }) {
  const wrong = model.problem === 'wrong-code';
  return h(
    'div',
    { class: 'field', key: 'code' },
    h('span', { class: 'field-label', id: `${model.idPrefix}-code-label` }, label),
    h(
      'div',
      {
        class: `code-boxes ${wrong ? 'is-wrong' : ''}`.trim(),
        role: 'group',
        'aria-labelledby': `${model.idPrefix}-code-label`,
        'aria-describedby': `${model.idPrefix}-code-hint`,
      },
      model.digits.map((digit, index) =>
        h('input', {
          key: `digit-${index}`,
          id: `${model.idPrefix}-digit-${index + 1}`,
          class: 'code-digit',
          type: 'text',
          inputmode: 'numeric',
          pattern: '[0-9]*',
          autocomplete: index === 0 ? 'one-time-code' : 'off',
          'aria-label': `Digit ${index + 1} of ${CODE_LENGTH}`,
          'aria-invalid': wrong ? 'true' : null,
          value: digit,
          readonly: model.busy,
          onInput: (event) => model.enterDigits(index, event.data ?? event.target.value),
          onPaste: (event) => model.pasteDigits(index, event),
          onKeydown: (event) => model.keyInBox(index, event),
          onFocus: (event) => event.target.select?.(),
        })
      )
    ),
    h('span', { class: 'field-hint', id: `${model.idPrefix}-code-hint` }, hint)
  );
}

function submit(busy, label, busyLabel = 'Saving…') {
  return h(
    'button',
    { type: 'submit', class: 'btn is-primary', 'aria-disabled': busy ? 'true' : null },
    busy ? busyLabel : label
  );
}

function form(key, busy, onSubmit, ...body) {
  return h(
    'form',
    {
      class: 'signin-form cs-form',
      key,
      novalidate: true,
      'aria-busy': busy ? 'true' : null,
      onSubmit(event) {
        event.preventDefault();
        if (!busy) onSubmit();
      },
    },
    body
  );
}

function authenticatorCard(ctx) {
  const { authenticator: model, profile } = ctx.state.account;
  const on = profile.value?.authenticator === true;
  const state = on ? badge('good', 'shield', 'On') : badge('idle', 'minus-circle', 'Off');
  let body;
  if (model.step === 'secret') {
    const uri = otpauthUri(model.secret, profile.value?.email);
    body = [
      h(
        'ol',
        { class: 'cs-steps' },
        h(
          'li',
          null,
          'Open an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or 1Password, and add an account.'
        ),
        h(
          'li',
          null,
          'Choose to enter a setup key, and type this one. Its time-based codes are what Cranium asks for.',
          h(
            'span',
            { class: 'cs-secret mono', 'aria-label': `Setup key ${groupSecret(model.secret).split('').join(' ')}` },
            groupSecret(model.secret)
          ),
          h(
            'span',
            { class: 'button-row' },
            button('is-small', model.copy, icon('copy'), 'Copy the key'),
            uri
              ? h(
                  'a',
                  { class: 'btn is-small', href: uri },
                  siteIcon('external'),
                  'Open in an authenticator app on this phone'
                )
              : null
          )
        ),
        h('li', null, 'Type the six digits the app shows now.')
      ),
      form(
        'confirm',
        model.busy,
        model.confirm,
        codeBoxes(
          { ...model, idPrefix: 'mfa' },
          { label: 'Code from your authenticator app', hint: 'A new code comes every 30 seconds.' }
        ),
        problemLine(model.problem, { ...ACCOUNT_WORDS, ...SIGN_IN_WORDS }, 'mfa-problem'),
        h(
          'div',
          { class: 'signin-actions' },
          submit(model.busy, 'Turn on two-step sign-in', 'Checking…'),
          button('is-quiet', model.cancel, 'Not now')
        )
      ),
    ];
  } else if (on && model.step === 'confirm-off') {
    body = [
      h(
        'p',
        { class: 'card-note' },
        'Sign-in will ask for your password only. Anyone who learns it can then sign in as you.'
      ),
      problemLine(model.problem, ACCOUNT_WORDS, 'mfa-problem'),
      h(
        'div',
        { class: 'button-row' },
        button('is-danger', model.stop, model.busy ? 'Turning it off…' : 'Turn it off'),
        button('is-quiet', model.cancel, 'Keep it on')
      ),
    ];
  } else {
    body = [
      h(
        'p',
        { class: 'card-note' },
        on
          ? 'Each sign-in asks for your password and a code from your authenticator app.'
          : 'Ask for a code from an authenticator app on your phone at each sign-in, as well as your password. ' +
              'Someone who learns your password still cannot sign in.'
      ),
      problemLine(model.problem, ACCOUNT_WORDS, 'mfa-problem'),
      model.done ? h('p', { class: 'cs-done', role: 'status' }, icon('check'), model.done) : null,
      h(
        'div',
        { class: 'button-row' },
        on
          ? button('', model.askToStop, 'Turn off')
          : button('is-primary', model.start, model.busy ? 'Starting…' : 'Turn on')
      ),
    ];
  }
  return card({ key: 'mfa', title: 'Two-step sign-in' }, h('div', { class: 'cs-card-state' }, state), body);
}

export function accountView(ctx) {
  if (!ctx.state.customer) {
    const me = ctx.state.staff.value;
    return h(
      'div',
      { class: 'cs-page', key: 'admin-account' },
      head({ eyebrow: 'Admin', title: 'Your account', lede: 'Your admin sign-in.' }),
      card(
        { title: 'Signed in as' },
        facts([
          ['E-mail', h('span', { class: 'fact-strong' }, me?.email || '—')],
          ['Role', me ? (me.canWrite ? 'Release manager' : 'Viewer') : '—'],
        ]),
        h(
          'p',
          { class: 'cs-note' },
          icon('user'),
          h(
            'span',
            null,
            "An admin's password and codes are kept by the console's own sign-in. To change them, ask the person who invited you."
          )
        ),
        h('a', { class: 'btn is-primary', href: ctx.site.adminPath }, icon('key'), 'Open admin mode')
      )
    );
  }
  const { account, me } = ctx.state;
  const profile = account.profile;
  const password = account.password;
  const ends = ctx.state.sessionLeft > 0 ? new Date(ctx.now + ctx.state.sessionLeft * 1000) : null;
  return h(
    'div',
    { class: 'cs-page', key: 'account' },
    head({ eyebrow: 'Your studio', title: 'Your account', lede: 'Your sign-in, and how it is protected.' }),
    problem(profile, 'your account', ctx),
    h(
      'div',
      { class: 'cs-columns' },
      h(
        'div',
        { class: 'cs-column' },
        card(
          { key: 'who', title: 'Signed in as' },
          facts([
            ['E-mail', h('span', { class: 'fact-strong' }, profile.value?.email || me.value?.email || '—')],
            ['Name', profile.value?.name || me.value?.name || h('span', { class: 'quiet' }, 'Not given')],
            [
              'Session',
              ctx.state.app
                ? 'Kept by the app on this phone'
                : ends
                  ? `Until ${ends.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}, then sign in again`
                  : '—',
            ],
          ]),
          h(
            'p',
            { class: 'cs-note' },
            icon('user'),
            h('span', null, 'Your e-mail address is your sign-in name. To change it, ask Cranium.')
          )
        ),
        card(
          { key: 'password', title: 'Password' },
          form(
            'password',
            password.busy,
            password.submit,
            passwordField('current-password', 'Current password', 'current-password', password.refs.current),
            passwordField(
              'new-password',
              'New password',
              'new-password',
              password.refs.next,
              `At least ${PASSWORD_MIN} characters. A few words in a row make a good one.`
            ),
            passwordField('again-password', 'New password again', 'new-password', password.refs.again),
            problemLine(password.problem, ACCOUNT_WORDS, 'password-problem'),
            password.done
              ? h('p', { class: 'cs-done', role: 'status' }, icon('check'), 'Your password is changed.')
              : null,
            h('div', { class: 'signin-actions' }, submit(password.busy, 'Change password'))
          )
        )
      ),
      h(
        'div',
        { class: 'cs-column is-side' },
        profile.value === null && !profile.error ? loadingLine('your account') : authenticatorCard(ctx),
        ctx.state.app ? phoneCard(ctx) : null,
        card(
          { key: 'out', title: 'Sign out' },
          h('p', { class: 'card-note' }, 'Ends your session in this tab and in any other tab of this site.'),
          h('div', { class: 'button-row' }, button('', ctx.actions.signOut, icon('sign-out'), 'Sign out'))
        )
      )
    )
  );
}

/** In the phone app: which app this is, the biometric of the sign-in on this phone, and the app's own settings. */
function phoneCard(ctx) {
  const { words, biometric } = ctx.state.app;
  const name = biometric?.name ?? 'the phone\u2019s biometric';
  return card(
    { key: 'phone', title: 'On this phone' },
    h('p', { class: 'card-note' }, words ?? 'The Cranium app.'),
    biometric?.available
      ? h(
          'div',
          { class: 'button-row' },
          button(
            '',
            () => ctx.actions.setBiometric(!biometric.enabled),
            icon('lock'),
            biometric.enabled ? `Stop unlocking with ${name}` : `Unlock with ${name}`
          )
        )
      : null,
    h('div', { class: 'button-row' }, button('is-quiet', ctx.actions.appSettings, 'App settings'))
  );
}

// Help. In plain words, from what the product does today.

const HELP = [
  [
    'Your board',
    [
      [
        'What does Online mean?',
        'A board that is on and connected reports to Cranium every 30 seconds. It counts as online for 90 seconds after a report, so a board that was just switched off still shows online for a moment, and then offline.',
      ],
      [
        'My board shows Offline.',
        'Check that it is switched on and that its Wi-Fi works. It reports again within 30 seconds of getting back online. A board that is restarting after an update can be quiet for a few minutes.',
      ],
      [
        'What is the name of my board?',
        'The name Cranium gave it when it was put on your account. Its own device name, which it was set up with, is shown beside it when it is different.',
      ],
    ],
  ],
  [
    'Updates',
    [
      [
        'Do I have to update my board?',
        "No. Cranium sends firmware updates, and the board installs them while it is on and online. You can watch it happen on the board's page.",
      ],
      [
        'Is an update safe?',
        'Every update is signed by Cranium, and the board checks the signature before it installs it. A new update runs on trial: if it cannot reach Cranium within 5 minutes, the board goes back to the firmware it had, by itself.',
      ],
      [
        'My board says it waits for Button 1.',
        'Older firmware asks for a press of Button 1 on the board before it installs an update. Press it, and the update goes ahead.',
      ],
    ],
  ],
  [
    'Your account',
    [
      [
        'How do I get an account?',
        'Cranium makes it and e-mails you an invitation with a temporary password. There is no sign-up. The first time you sign in, you choose your own password.',
      ],
      [
        'I forgot my password.',
        'Choose "Forgot your password?" on the sign-in page. Cranium e-mails a code to your address, and you choose a new password with it.',
      ],
      [
        'How do I make my account safer?',
        'Turn on two-step sign-in on your Account page. Each sign-in then also asks for a code from an authenticator app on your phone.',
      ],
      ['Who can see my boards?', 'You, and the people at Cranium who look after the boards. No other customer can.'],
    ],
  ],
  [
    'Your mixes',
    [
      [
        'Where are my sessions and tracks?',
        'Your board does not send what you play yet: that is being built. Until it is, Explore demo shows made-up sessions, and My journal holds the session files you import, kept on this device only.',
      ],
    ],
  ],
];

export function helpView(ctx) {
  const signedIn = Boolean(ctx.state.customer || ctx.state.admin);
  return h(
    'div',
    { class: `cs-page ${signedIn ? '' : 'is-alone'}`.trim(), key: 'help' },
    signedIn ? null : h('a', { class: 'back', href: '#/' }, icon('arrow-left'), 'Home'),
    head({
      eyebrow: 'Help and support',
      title: 'How can we help?',
      lede: 'Answers about your board, its updates and your account.',
    }),
    h(
      'div',
      { class: 'cs-help' },
      HELP.map(([section, items]) =>
        h(
          'section',
          { class: 'cs-help-section', key: section },
          h('h2', { class: 'cs-help-title' }, section),
          items.map(([question, answer]) =>
            h(
              'details',
              { class: 'cs-faq', key: question },
              h('summary', { class: 'cs-faq-question' }, question),
              h('p', { class: 'cs-faq-answer' }, answer)
            )
          )
        )
      )
    ),
    card(
      { key: 'contact', title: 'Still stuck?' },
      h(
        'p',
        { class: 'card-note' },
        'A support address for customers is not set up yet. Until it is, ask the person at Cranium who gave you your account.'
      ),
      signedIn
        ? null
        : h(
            'div',
            { class: 'button-row cs-help-actions' },
            h('a', { class: 'btn is-primary', href: '#/sign-in' }, 'Sign in')
          )
    )
  );
}

// Sign-in pages: the console's own layout (app.css .gate), with the site's words.

function gate(kind, ...message) {
  return h(
    'div',
    { class: 'gate is-signin cs-gate' },
    h(
      'div',
      { class: 'gate-copy' },
      h(
        'a',
        { class: 'gate-brand cs-gate-brand', href: '#/' },
        brandMark(),
        h(
          'span',
          { class: 'gate-brand-text' },
          h('span', { class: 'gate-brand-name' }, 'Cranium'),
          h('span', { class: 'gate-brand-sub' }, kind === 'admin' ? 'Admin sign-in' : 'Your studio')
        )
      ),
      message,
      h(
        'p',
        { class: 'gate-foot' },
        kind === 'admin'
          ? 'For the Cranium team: the same account as on the firmware console, with its code.'
          : 'See your boards, how they are and what they did.'
      )
    ),
    h('div', { class: 'gate-art' }, domeArt())
  );
}

function emailField(model) {
  const wrong = model.problem === 'wrong-password' || model.problem === 'missing';
  return h(
    'label',
    { class: 'field', key: 'email' },
    h('span', { class: 'field-label' }, 'E-mail address'),
    h('input', {
      class: 'input',
      id: 'signin-email',
      type: 'email',
      autocomplete: 'username',
      inputmode: 'email',
      autocapitalize: 'off',
      spellcheck: 'false',
      value: model.email,
      readonly: model.busy,
      'aria-invalid': wrong ? 'true' : null,
      'aria-describedby': model.problem ? 'signin-problem' : null,
      onInput: (event) => model.setEmail(event.target.value),
    })
  );
}

function signInProblem(model) {
  if (!model.problem) return null;
  return h(
    'p',
    { class: 'signin-problem', id: 'signin-problem', role: 'alert', key: `problem-${model.tries}` },
    icon('alert'),
    h('span', null, SIGN_IN_WORDS[model.problem] ?? ACCOUNT_WORDS[model.problem] ?? SIGN_IN_WORDS.failed)
  );
}

function passwordStep(model) {
  const wrong = model.problem === 'wrong-password' || model.problem === 'missing';
  return form(
    'password',
    model.busy,
    model.submitPassword,
    emailField(model),
    h(
      'label',
      { class: 'field', key: 'password' },
      h('span', { class: 'field-label' }, 'Password'),
      h('input', {
        class: 'input',
        id: 'signin-password',
        type: 'password',
        autocomplete: 'current-password',
        readonly: model.busy,
        'aria-invalid': wrong ? 'true' : null,
        'aria-describedby': model.problem ? 'signin-problem' : null,
        ref: model.passwordRef,
      })
    ),
    signInProblem(model),
    h(
      'div',
      { class: 'signin-actions', key: 'actions' },
      submit(model.busy, 'Continue', 'Checking…'),
      model.kind === 'customer' ? h('a', { class: 'btn is-quiet', href: '#/forgot' }, 'Forgot your password?') : null
    )
  );
}

function codeStep(model) {
  return form(
    'code',
    model.busy,
    model.submitCode,
    codeBoxes(
      { ...model, idPrefix: 'code' },
      {
        label: 'Code from your authenticator app',
        hint: 'The six digits it shows now. The code goes in by itself once the last digit is typed.',
      }
    ),
    signInProblem(model),
    h(
      'div',
      { class: 'signin-actions', key: 'actions' },
      submit(model.busy, 'Sign in', 'Checking…'),
      h('button', { type: 'button', class: 'btn is-quiet', onClick: model.startOver }, 'Start again')
    )
  );
}

function newPasswordStep(model) {
  return form(
    'new-password',
    model.busy,
    model.submitNewPassword,
    passwordField(
      'first-password',
      'New password',
      'new-password',
      model.newRef,
      `At least ${PASSWORD_MIN} characters.`
    ),
    passwordField('first-again', 'New password again', 'new-password', model.againRef),
    signInProblem(model),
    h('div', { class: 'signin-actions', key: 'actions' }, submit(model.busy, 'Save and sign in', 'Saving…'))
  );
}

const TITLES_OF_STEP = {
  password: (kind) => (kind === 'admin' ? 'Admin sign-in' : 'Sign in'),
  code: () => 'Enter the code',
  'new-password': () => 'Choose your password',
  elsewhere: () => 'One more step',
};

/**
 * A sign-in page. `model` has kind (customer or admin), step (password, code, new-password or
 * elsewhere), email, digits, busy, problem, tries, and what each control does.
 */
export function signInView(model) {
  const { kind, step } = model;
  let lead;
  let body;
  if (step === 'code') {
    lead = h('p', { class: 'gate-text' }, 'Signing in as ', h('strong', { class: 'signin-who' }, model.email), '.');
    body = codeStep(model);
  } else if (step === 'new-password') {
    lead = h('p', { class: 'gate-text' }, "Welcome. Your invitation's password works once: choose your own now.");
    body = newPasswordStep(model);
  } else if (step === 'elsewhere') {
    lead = h(
      'p',
      { class: 'gate-text' },
      kind === 'admin'
        ? "Your account needs a step that only the firmware console's sign-in does, such as a new password or an authenticator app. Finish it there, then come back."
        : 'Your account needs a new password first. Choose one with "Forgot your password?".'
    );
    body = h(
      'div',
      { class: 'signin-actions' },
      kind === 'admin'
        ? h('a', { class: 'btn is-primary', href: model.adminPath }, "Go to the console's sign-in")
        : h('a', { class: 'btn is-primary', href: '#/forgot' }, 'Choose a new password')
    );
  } else {
    lead = h(
      'p',
      { class: 'gate-text' },
      model.lead ??
        (kind === 'admin'
          ? 'With your Cranium team account: your e-mail address, your password and the code from your authenticator app.'
          : 'With the e-mail address and the password of your Cranium account.')
    );
    body = passwordStep(model);
  }
  return gate(
    kind,
    h(
      'div',
      { class: 'gate-message signin', key: `${kind}-${step}` },
      h('h1', { class: 'gate-title', id: 'page-title', tabindex: '-1' }, TITLES_OF_STEP[step](kind)),
      lead,
      body,
      h(
        'div',
        { class: 'signin-other', key: 'other' },
        kind === 'admin'
          ? h('a', { class: 'btn is-quiet', href: '#/sign-in' }, 'Customer sign-in', icon('arrow-right'))
          : h('a', { class: 'btn is-quiet', href: '#/admin-sign-in' }, 'Admin sign-in', icon('arrow-right')),
        h('a', { class: 'btn is-quiet', href: '#/' }, 'Home')
      )
    )
  );
}

/** "Forgot your password?": the address, then the code from the e-mail and a new password. */
export function forgotView(model) {
  let body;
  if (model.step === 'done') {
    body = [
      h('p', { class: 'gate-text' }, 'Your password is changed. Sign in with it now.'),
      h('div', { class: 'signin-actions' }, h('a', { class: 'btn is-primary', href: '#/sign-in' }, 'Sign in')),
    ];
  } else if (model.step === 'code') {
    body = [
      h(
        'p',
        { class: 'gate-text' },
        'If ',
        h('strong', { class: 'signin-who' }, model.email),
        ' has an account, a code is on its way to it. It can take a minute.'
      ),
      form(
        'reset',
        model.busy,
        model.submitReset,
        codeBoxes(
          { ...model, idPrefix: 'reset' },
          { label: 'Code from the e-mail', hint: 'Six digits, in the e-mail from Cranium.' }
        ),
        passwordField(
          'reset-password',
          'New password',
          'new-password',
          model.newRef,
          `At least ${PASSWORD_MIN} characters.`
        ),
        passwordField('reset-again', 'New password again', 'new-password', model.againRef),
        problemLine(model.problem, ACCOUNT_WORDS, 'forgot-problem'),
        h(
          'div',
          { class: 'signin-actions' },
          submit(model.busy, 'Set the new password'),
          h('button', { type: 'button', class: 'btn is-quiet', onClick: model.startOver }, 'Send another code')
        )
      ),
    ];
  } else {
    body = [
      h(
        'p',
        { class: 'gate-text' },
        'Type the address you sign in with. Cranium e-mails a code to it, and you choose a new password with the code.'
      ),
      form(
        'ask',
        model.busy,
        model.submitEmail,
        emailField({ ...model, problem: model.problem === 'missing-email' ? 'missing' : null }),
        problemLine(model.problem, ACCOUNT_WORDS, 'forgot-problem'),
        h('div', { class: 'signin-actions' }, submit(model.busy, 'Send me a code', 'Sending…'))
      ),
    ];
  }
  return gate(
    'customer',
    h(
      'div',
      { class: 'gate-message signin', key: `forgot-${model.step}` },
      h(
        'h1',
        { class: 'gate-title', id: 'page-title', tabindex: '-1' },
        model.step === 'done' ? 'Done' : 'A new password'
      ),
      body,
      h(
        'div',
        { class: 'signin-other' },
        h('a', { class: 'btn is-quiet', href: '#/sign-in' }, icon('arrow-left'), 'Back to sign-in')
      )
    )
  );
}

/** A public page for someone who is not signed in, such as Help: the site's name on top, and the way in. */
export function aloneView(page) {
  return h(
    'div',
    { class: 'cs-alone' },
    h(
      'header',
      { class: 'cs-alone-top' },
      h(
        'a',
        { class: 'cs-brand', href: '#/' },
        brandMark(),
        h('span', { class: 'cs-brand-text' }, h('span', { class: 'cs-brand-name' }, 'Cranium'))
      ),
      h('a', { class: 'btn is-primary is-small', href: '#/sign-in' }, 'Sign in')
    ),
    h('main', { class: 'cs-main', id: 'content', tabindex: '-1' }, page)
  );
}

/** A message alone on the page, while the site starts or signs out. */
export function waitingView(text) {
  return gate('customer', h('div', { class: 'gate-message' }, h('p', { class: 'gate-text', role: 'status' }, text)));
}
