/**
 * The console's Team page (docs/accounts.md): every account that signs in to the console, its tier and its
 * state, and what a release manager changes about them. For release managers: the API refuses anybody else,
 * and the console's nav leaves the page out for a viewer.
 *
 * What a release manager does here, each of it in the activity log (account.*) with what it changed:
 *
 *   invite              Cognito makes the account and e-mails the invitation, with a temporary password
 *   send it again       while the person has not signed in yet
 *   change the tier     viewer or release manager
 *   disable, enable     a disabled account can neither sign in nor read, within a minute
 *   reset               a new password and a new authenticator app: the account is replaced, with its tier,
 *                       and Cognito e-mails a new invitation (why, in docs/accounts.md)
 *   remove              signed out everywhere and deleted
 *
 * The console never sees, sets or shows a password. Nobody changes their own account here, and the page does
 * not offer a change that would leave no enabled release manager: the API refuses both all the same.
 *
 * The page's script is fetched when the page is opened (app.js), and draws with views.js.
 */

import { ApiError, TIERS, dateAndTime, exactTime, isAccountId, timeAgo } from './core.js';
import {
  SPACER,
  badge,
  card,
  consequences,
  dialogButton,
  dialogFrame,
  empty,
  failure,
  filterBar,
  filterSelect,
  filtered,
  h,
  icon,
  loadProblem,
  loading,
  onTheWebsite,
  pageHead,
} from './views.js';

let app = null;

const listing = { value: null, error: null, loadedAt: 0, loading: false };
const invite = { email: '', tier: 'viewer', busy: false, error: null };

/** Hand the page what it needs from app.js: the state, the API, loading, drawing and the dialogs. */
export function connect(given) {
  app = given;
}

export function resources() {
  return [listing];
}

/** Hold the refresh while something is being typed or sent. */
export function holdStill() {
  return invite.busy || invite.email !== '' || app?.dialogs?.isOpen() === true;
}

// Reading the reply into known shapes.

const STATUSES = ['confirmed', 'pending', 'reset', 'other'];
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const text = (value, limit) => (typeof value === 'string' ? value.replace(/[\p{C}]/gu, '').slice(0, limit) : '');
const time = (value) => (typeof value === 'string' && TIME.test(value) ? value : null);

function readAccount(raw, you) {
  if (raw === null || typeof raw !== 'object' || !isAccountId(raw.id)) return null;
  return {
    id: raw.id,
    email: text(raw.email, 320),
    name: text(raw.name, 60),
    tier: TIERS.includes(raw.tier) ? raw.tier : 'none',
    enabled: raw.enabled === true,
    status: STATUSES.includes(raw.status) ? raw.status : 'other',
    mfa: typeof raw.mfa === 'boolean' ? raw.mfa : null,
    createdAt: time(raw.createdAt),
    lastSignIn: time(raw.lastSignIn),
    you: raw.id === you,
  };
}

/** The reply of GET /api/team, or throws. Nothing in it is a password: anything but these fields is dropped. */
export function readTeam(body) {
  if (body === null || typeof body !== 'object' || !Array.isArray(body.accounts)) {
    throw new ApiError(0, 'unreadable', 'The server sent a reply the console could not read.');
  }
  const you = isAccountId(body.you) ? body.you : null;
  return { you, accounts: body.accounts.map((raw) => readAccount(raw, you)).filter((account) => account !== null) };
}

export async function refresh() {
  await app.load(listing, async () => readTeam(await app.api.team()));
}

const reload = () => app.load(listing, async () => readTeam(await app.api.team()));

// What may be offered for an account.

/** Can change things now: enabled, signed in with their own password, and a release manager. */
const writes = (account) => account.enabled && account.status === 'confirmed' && account.tier === 'release-manager';

/** Whether taking this account out of the release managers who can write leaves another. */
export function leavesAReleaseManager(accounts, account) {
  return !writes(account) || accounts.some((other) => other.id !== account.id && writes(other));
}

/** The state an account is shown with: disabled goes before how far it got in signing in. */
export function stateOf(account) {
  return account.enabled ? account.status : 'disabled';
}

const who = (account) => account.email || account.name || 'This account';
const TIER_WORDS = { 'release-manager': 'Release manager', viewer: 'Viewer', none: 'No tier' };

// Dialogs: every change goes through one, which says what follows and has the button that does it.

/**
 * Open the dialog of one change. `danger` marks one that cannot be taken back from here as it was.
 * `run` makes the change; `done` is said once it is made.
 */
export function openChange({ title, lines, action, iconName, danger = false, run, done }) {
  if (!app?.dialogs || app.dialogs.isOpen()) return null;
  let self = null;
  const model = { sending: false, error: null };
  const submit = () =>
    app.dialogs.submit(self, model, async () => {
      await run();
      self.close(true);
      app.notify(done);
      await reload();
      app.draw();
    });
  self = app.dialogs.open(() =>
    dialogFrame({
      title,
      busy: model.sending,
      onClose: () => self.close(),
      onSubmit: submit,
      body: consequences(lines),
      error: model.error ? failure('Nothing was changed.', model.error, null, app.dialogs.signIn) : null,
      foot: [
        dialogButton({ key: 'keep', disabled: model.sending, onClick: () => self.close() }, 'Cancel'),
        SPACER(),
        dialogButton(
          { key: 'go', className: danger ? 'is-danger' : 'is-primary', submit: true, sending: model.sending },
          icon(iconName),
          action
        ),
      ],
    })
  );
  return self;
}

/** The changes an account offers, as [key, label, icon, open]: none for your own. */
export function actionsFor(account, accounts) {
  if (account.you) return [];
  const api = () => app.api;
  const name = who(account);
  const keeps = leavesAReleaseManager(accounts, account);
  const out = [];
  if (account.enabled && account.status === 'pending') {
    out.push([
      'resend',
      'Send the invitation again',
      'send',
      () =>
        openChange({
          title: `Send the invitation again to ${name}`,
          lines: [
            'They get a new temporary password by e-mail, which works for 3 days.',
            'The earlier temporary password stops working.',
          ],
          action: 'Send it again',
          iconName: 'send',
          run: () => api().resendTeamInvitation(account.id),
          done: `The invitation to ${name} is sent again.`,
        }),
    ]);
  }
  if (account.tier === 'viewer' || account.tier === 'none') {
    out.push([
      'promote',
      'Make release manager',
      'shield',
      () =>
        openChange({
          title: `Make ${name} a release manager`,
          lines: [
            'They can upload and revoke firmware, deploy, and manage the team and the customers.',
            'It counts at once for what they may change; what the console shows follows at their next sign-in.',
          ],
          action: 'Make release manager',
          iconName: 'shield',
          run: () => api().setTeamTier(account.id, 'release-manager'),
          done: `${name} is a release manager now.`,
        }),
    ]);
  }
  if (account.tier === 'release-manager' && keeps) {
    out.push([
      'demote',
      'Make viewer',
      'user',
      () =>
        openChange({
          title: `Make ${name} a viewer`,
          lines: ['They can look at everything, and change nothing.', 'It counts at once.'],
          action: 'Make viewer',
          iconName: 'user',
          danger: true,
          run: () => api().setTeamTier(account.id, 'viewer'),
          done: `${name} is a viewer now.`,
        }),
    ]);
  }
  if (!account.enabled) {
    out.push([
      'enable',
      'Enable',
      'check',
      () =>
        openChange({
          title: `Enable ${name}`,
          lines: ['They can sign in again, with the password and authenticator they had.'],
          action: 'Enable',
          iconName: 'check',
          run: () => api().setTeamEnabled(account.id, true),
          done: `${name} can sign in again.`,
        }),
    ]);
  } else if (keeps) {
    out.push([
      'disable',
      'Disable',
      'ban',
      () =>
        openChange({
          title: `Disable ${name}`,
          lines: [
            'They cannot sign in, and stop reading the console within a minute.',
            'Their tier and their authenticator stay, for when the account is enabled again.',
          ],
          action: 'Disable',
          iconName: 'ban',
          danger: true,
          run: () => api().setTeamEnabled(account.id, false),
          done: `${name} is disabled.`,
        }),
    ]);
  }
  if (account.enabled && account.status !== 'pending' && account.tier !== 'none' && keeps) {
    out.push([
      'reset',
      'Reset password and authenticator',
      'key',
      () =>
        openChange({
          title: `Reset the password and authenticator of ${name}`,
          lines: [
            'Their account is replaced by a new one with the same tier, and they get a new invitation by e-mail ' +
              'with a temporary password. Nobody here sees it.',
            'At the next sign-in they choose a password and set up an authenticator app again.',
            'Their sessions end now. Earlier entries of the activity log keep the old account’s id.',
          ],
          action: 'Reset',
          iconName: 'key',
          danger: true,
          run: () => api().resetTeamMember(account.id),
          done: `${name} gets a new invitation.`,
        }),
    ]);
  }
  if (keeps) {
    out.push([
      'remove',
      'Remove',
      'x',
      () =>
        openChange({
          title: `Remove ${name}`,
          lines: [
            'They are signed out everywhere and their account is deleted.',
            'This cannot be undone: to let them in again, invite them again.',
          ],
          action: 'Remove',
          iconName: 'x',
          danger: true,
          run: () => api().removeTeamMember(account.id),
          done: `${name} is removed.`,
        }),
    ]);
  }
  return out;
}

// Changes from the page itself.

async function sendInvite() {
  if (invite.busy) return;
  invite.busy = true;
  invite.error = null;
  app.draw();
  try {
    const reply = await app.api.inviteTeamMember({ email: invite.email.trim(), tier: invite.tier });
    const email = text(reply?.account?.email, 320) || invite.email.trim();
    invite.email = '';
    app.notify(`Invited ${email}. The invitation goes out by e-mail, with a temporary password.`);
  } catch (error) {
    invite.error = error;
  } finally {
    invite.busy = false;
    await reload();
    app.draw();
  }
}

// Drawing.

const STATE_BADGES = {
  confirmed: ['good', 'check', 'Active', 'Has signed in with their own password'],
  pending: ['warn', 'clock', 'Invited', 'Has not signed in yet'],
  reset: ['warn', 'key', 'Reset', 'Has to choose a new password'],
  disabled: ['idle', 'ban', 'Disabled', 'Cannot sign in'],
  other: ['idle', 'minus', 'Other state', 'The sign-in service reports another state'],
};

function stateBadge(account) {
  const [tone, iconName, label, title] = STATE_BADGES[stateOf(account)] ?? STATE_BADGES.other;
  return badge(tone, iconName, label, title);
}

function tierBadge(account) {
  if (account.tier === 'release-manager') return badge('good', 'shield', 'Release manager');
  if (account.tier === 'viewer') return badge('idle', 'user', 'Viewer');
  return badge('warn', 'alert', 'No tier', 'In neither group: cannot use the console');
}

function mfaBadge(account) {
  if (account.mfa === true) return badge('good', 'lock', 'Authenticator', 'An authenticator app is set up');
  if (account.mfa === false) return badge('warn', 'lock', 'No authenticator', 'Sets one up at the first sign-in');
  return null;
}

function inviteCard() {
  return card(
    { key: 'invite', title: 'Invite a person' },
    h(
      'form',
      {
        class: 'team-invite',
        novalidate: true,
        'aria-busy': invite.busy ? 'true' : null,
        onSubmit(event) {
          event.preventDefault();
          sendInvite();
        },
      },
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label' }, 'E-mail address'),
        h('input', {
          class: 'input',
          id: 'team-email',
          type: 'email',
          autocomplete: 'off',
          inputmode: 'email',
          autocapitalize: 'off',
          spellcheck: 'false',
          value: invite.email,
          readonly: invite.busy,
          onInput: (event) => {
            invite.email = event.target.value;
          },
        })
      ),
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label' }, 'Tier'),
        h(
          'select',
          {
            class: 'input',
            id: 'team-tier',
            value: invite.tier,
            onChange: (event) => {
              invite.tier = event.target.value;
            },
          },
          TIERS.map((tier) => h('option', { key: tier, value: tier, selected: invite.tier === tier }, TIER_WORDS[tier]))
        )
      ),
      h(
        'div',
        { class: 'button-row' },
        h(
          'button',
          { type: 'submit', class: 'btn is-primary', 'aria-disabled': invite.busy ? 'true' : null },
          icon('plus'),
          invite.busy ? 'Inviting…' : 'Invite'
        )
      )
    ),
    h(
      'p',
      { class: 'card-note' },
      'The invitation goes out by e-mail with a temporary password, which works for 3 days. At the first sign-in ' +
        'they choose a password and set up an authenticator app; nobody here sees either.'
    ),
    invite.error ? failure('Nobody was invited.', invite.error) : null
  );
}

function accountRow(ctx, account, accounts) {
  const actions = actionsFor(account, accounts);
  const lonely = !account.you && !leavesAReleaseManager(accounts, account);
  return h(
    'li',
    { class: 'team-account', key: account.id },
    h(
      'div',
      { class: 'team-head' },
      h(
        'div',
        { class: 'team-who' },
        h('span', { class: 'team-email' }, account.email || h('span', { class: 'quiet' }, 'No address')),
        h(
          'span',
          { class: 'team-meta quiet' },
          account.name ? `${account.name} · ` : '',
          account.createdAt
            ? h(
                'time',
                { datetime: account.createdAt, title: exactTime(account.createdAt) },
                `added ${dateAndTime(account.createdAt)}`
              )
            : 'added at an unknown time',
          ' · ',
          account.lastSignIn
            ? h(
                'time',
                { datetime: account.lastSignIn, title: exactTime(account.lastSignIn) },
                `last signed in ${timeAgo(account.lastSignIn, ctx.state.now)}`
              )
            : 'no sign-in on record'
        )
      ),
      h(
        'span',
        { class: 'team-badges' },
        account.you ? badge('idle', 'user', 'You') : null,
        tierBadge(account),
        stateBadge(account),
        mfaBadge(account)
      )
    ),
    account.you
      ? h('p', { class: 'card-note' }, 'Your own account: another release manager changes it.')
      : lonely
        ? h(
            'p',
            { class: 'card-note' },
            'The only enabled release manager: make somebody else one before you demote, disable, reset or remove them.'
          )
        : null,
    actions.length === 0
      ? null
      : ctx.state.app
        ? h('div', { class: 'button-row team-actions' }, onTheWebsite(ctx, 'team'))
        : h(
            'div',
            { class: 'button-row team-actions' },
            actions.map(([key, label, iconName, open]) =>
              h(
                'button',
                { key, type: 'button', class: 'btn is-small', 'data-action': key, onClick: () => open() },
                icon(iconName),
                label
              )
            )
          )
  );
}

export function teamView(ctx) {
  const data = listing.value;
  const head = pageHead({
    title: 'Team',
    lede: 'Everybody who signs in to this console, and what they may do.',
    how: {
      title: 'How the team works',
      text: [
        'Each person’s row says what they may do and how their account stands.',
        'Every change here is in the activity log. No password is ever shown or set here.',
      ],
    },
  });
  if (data === null) {
    return h(
      'div',
      { class: 'page team-page', key: 'page' },
      head,
      loadProblem(listing, 'the team', ctx),
      listing.error ? null : loading('the team')
    );
  }
  const shown = filtered(ctx, 'team', data.accounts, {
    words: (account) => [account.email, account.name, TIER_WORDS[account.tier]],
    keep: (account, filters) =>
      (filters.tier === '' || account.tier === filters.tier) &&
      (filters.status === '' || stateOf(account) === filters.status),
  });
  const total = data.accounts.length;
  return h(
    'div',
    { class: 'page team-page', key: 'page' },
    head,
    loadProblem(listing, 'the team', ctx),
    h(
      'div',
      { class: 'team-layout' },
      card(
        { key: 'list', title: total === 1 ? '1 account' : `${total} accounts` },
        total === 0
          ? empty({ iconName: 'users', title: 'No accounts.', text: 'Invite the first person.' })
          : [
              filterBar(ctx, 'team', {
                label: 'accounts',
                placeholder: 'Search by e-mail or name',
                shown: shown.length,
                total,
                controls: [
                  filterSelect(ctx, 'team', {
                    name: 'tier',
                    label: 'Tier',
                    all: 'Any tier',
                    options: [
                      ['release-manager', 'Release managers'],
                      ['viewer', 'Viewers'],
                      ['none', 'No tier'],
                    ],
                  }),
                  filterSelect(ctx, 'team', {
                    name: 'status',
                    label: 'Status',
                    all: 'Any status',
                    options: [
                      ['confirmed', 'Active'],
                      ['pending', 'Invited'],
                      ['reset', 'Reset'],
                      ['disabled', 'Disabled'],
                    ],
                  }),
                ],
              }),
              shown.length === 0
                ? h('p', { class: 'quiet filter-none', key: 'none' }, 'No accounts match. Try other words, or Clear.')
                : h(
                    'ul',
                    { class: 'team-list', key: 'rows' },
                    shown.map((account) => accountRow(ctx, account, data.accounts))
                  ),
            ]
      ),
      h(
        'div',
        { class: 'team-side' },
        ctx.state.app
          ? card(
              { key: 'invite', title: 'Invite a person' },
              h(
                'p',
                { class: 'card-note' },
                'The apps show the team; inviting and every other change is made on the console’s website.'
              ),
              onTheWebsite(ctx, 'team', 'Invite on the website')
            )
          : inviteCard(),
        card(
          { key: 'about', title: 'Resetting an account' },
          h(
            'p',
            { class: 'card-note' },
            'A reset gives the person a new password and a new authenticator in one step: their account is ' +
              'replaced, with its tier, and a new invitation goes out by e-mail.'
          ),
          h(
            'details',
            { class: 'more is-spaced' },
            h('summary', null, 'Details'),
            h(
              'p',
              { class: 'card-note' },
              'This pool requires an authenticator app and lets only an administrator recover an account, so ' +
                'Cognito can neither e-mail a reset code nor forget an authenticator. See docs/accounts.md.'
            )
          )
        )
      )
    )
  );
}

// For the tests: the page's own state, and setting it as a reply would.
export const _internal = {
  listing,
  invite,
  set(body) {
    listing.value = readTeam(body);
    listing.error = null;
  },
};
