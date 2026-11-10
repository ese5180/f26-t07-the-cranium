/**
 * The team: the console's Team page (docs/accounts.md), the people who sign in to the console and what each
 * may do. Release managers only, for reading as for changing, on the website: never a viewer, never an API
 * token, never a phone app's session (app.mjs). Every change goes on record in the activity log with what it
 * changed, before and after (account.*); never a password, which this code never sees, sets or shows.
 *
 *   GET  /api/team                              -> { you, accounts: [Account], lastSignInFrom }
 *   POST /api/team { email, tier }              -> 201 { account }   account.invite
 *        Cognito makes the account and e-mails the invitation, with a temporary password
 *   POST /api/team/{id}/resend                  -> { account }       account.resend   while pending
 *   POST /api/team/{id}/tier { tier }           -> { account }       account.tier
 *   POST /api/team/{id}/disable                 -> { account }       account.disable
 *   POST /api/team/{id}/enable                  -> { account }       account.enable
 *   POST /api/team/{id}/reset                   -> { account }       account.reset
 *        A new password and a new authenticator: the account is replaced by a new one with the same tier,
 *        and Cognito e-mails its invitation. This pool can neither e-mail a reset code (its recovery is for
 *        an administrator only) nor forget an authenticator while MFA is required: see docs/accounts.md
 *   POST /api/team/{id}/remove                  -> { removed: id }   account.remove
 *
 * Account: { id, email, name, tier: release-manager | viewer | none, enabled, status: confirmed | pending |
 * reset | other, mfa: true | false | null, createdAt, lastSignIn, you }. lastSignIn is the newest sign-in the
 * activity log holds for the account (account.sign_in), or null: Cognito does not say when this pool's users
 * last signed in.
 *
 * Guards: nobody demotes, disables, resets or removes their own account, and a change that would leave no
 * enabled, confirmed release manager is refused. Both are asked of Cognito at the moment of the change.
 */

import { RELEASE_MANAGERS, VIEWERS } from '../auth.mjs';
import { badRequest, conflict, field, notFound } from '../http.mjs';
import { change, entryFromItem } from '../lib/audit.mjs';

// A Cognito sub.
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Enough to refuse what is plainly not an address; Cognito decides the rest.
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;
// How many accounts the page lists, with their groups and authenticators, at most.
const MAX_LISTED = 200;
// How many accounts are asked about at once.
const AT_ONCE = 8;
// How much of the activity log is read for the last sign-ins.
const SIGN_IN_LIMIT = 200;
const SIGN_IN_BUDGET = 1000;

export const TIERS = Object.freeze({ 'release-manager': RELEASE_MANAGERS, viewer: VIEWERS });
const STATUS = Object.freeze({ CONFIRMED: 'confirmed', FORCE_CHANGE_PASSWORD: 'pending', RESET_REQUIRED: 'reset' });

function requireAccountId(value) {
  if (typeof value !== 'string' || !ACCOUNT_ID.test(value)) {
    throw badRequest('invalid_account', 'That is not the id of an account.');
  }
  return value;
}

function requireEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL.test(email) || /[\p{C}]/u.test(email)) {
    throw badRequest('invalid_email', 'Give their e-mail address, such as name@example.com.');
  }
  return email;
}

function requireTier(value) {
  if (typeof value !== 'string' || !Object.hasOwn(TIERS, value)) {
    throw badRequest('invalid_tier', 'The tier is viewer or release-manager.');
  }
  return value;
}

/** The tier that a list of groups gives: a release manager is that, whatever else. */
export function tierOf(groups) {
  if (!Array.isArray(groups)) return 'none';
  if (groups.includes(RELEASE_MANAGERS)) return 'release-manager';
  return groups.includes(VIEWERS) ? 'viewer' : 'none';
}

/** Whether an account may change things now: enabled, confirmed and a release manager. */
const writes = (account) => account.enabled && account.status === 'CONFIRMED' && account.tier === 'release-manager';

/**
 * Whether a change that takes `id` out of the release managers who can write leaves at least one other. Pure,
 * so that the rule is tested on its own: the API asks it with Cognito's answer of the moment.
 */
export function anotherReleaseManager(accounts, id) {
  return accounts.some((account) => account.sub !== id && writes(account));
}

/** Run `work` for each item, AT_ONCE at a time, in order. */
async function each(items, work) {
  const out = new Array(items.length);
  for (let start = 0; start < items.length; start += AT_ONCE) {
    const part = items.slice(start, start + AT_ONCE);
    const done = await Promise.all(part.map(work));
    done.forEach((value, index) => {
      out[start + index] = value;
    });
  }
  return out;
}

function view(account, { you, lastSignIns = new Map() }) {
  return {
    id: account.sub,
    email: account.email ?? '',
    name: account.name ?? '',
    tier: account.tier,
    enabled: account.enabled === true,
    status: STATUS[account.status] ?? 'other',
    mfa: typeof account.mfa === 'boolean' ? account.mfa : null,
    createdAt: Number.isFinite(account.createdAt) ? new Date(account.createdAt).toISOString() : null,
    lastSignIn: lastSignIns.get(account.sub) ?? null,
    you: account.sub === you,
  };
}

/** The words of an account's state, for the record of a change. */
function stateWords(account) {
  if (account === null) return null;
  if (!account.enabled) return 'disabled';
  return STATUS[account.status] ?? 'other';
}

const authenticatorWords = (account) =>
  account?.mfa === true ? 'set up' : account?.mfa === false ? 'not set up' : null;

export function createTeamHandlers({ aws, directory, log = () => {} }) {
  /** An account as Cognito has it now, with its tier, or null. */
  async function lookUp(sub) {
    const [member, groups] = await Promise.all([aws.getTeamMember(sub), aws.listUserGroups(sub)]);
    return member === null ? null : { ...member, tier: tierOf(groups) };
  }

  async function existing(id, entry) {
    const account = await lookUp(id);
    if (account === null) throw notFound('unknown_account', 'There is no account with this id.');
    entry.detail.email = account.email;
    return account;
  }

  /** Every account with its tier; the authenticators only where `withMfa`. */
  async function everyone({ withMfa }) {
    const listed = (await aws.listTeam()).slice(0, MAX_LISTED);
    return each(listed, async (member) => {
      const [groups, full] = await Promise.all([
        aws.listUserGroups(member.sub),
        withMfa ? aws.getTeamMember(member.sub) : null,
      ]);
      return { ...member, ...(full ?? {}), tier: tierOf(groups) };
    });
  }

  function notYourself(caller, id, what) {
    if (caller.sub === id) {
      throw conflict('own_account', `You cannot ${what} your own account. Ask another release manager.`);
    }
  }

  /** Refuse a change that would leave nobody who can manage the console. */
  async function keepAReleaseManager(account) {
    if (!writes(account)) return;
    if (!anotherReleaseManager(await everyone({ withMfa: false }), account.sub)) {
      throw conflict(
        'last_release_manager',
        'This is the only enabled release manager. Make somebody else a release manager first.'
      );
    }
  }

  /** The newest sign-in of each account in the activity log. Never throws: the list does without. */
  async function lastSignIns() {
    const found = new Map();
    try {
      const { items } = await aws.searchAudit({
        low: '0',
        high: '~',
        actions: ['account.sign_in'],
        outcomes: ['ok'],
        limit: SIGN_IN_LIMIT,
        budget: SIGN_IN_BUDGET,
      });
      for (const item of items) {
        const entry = entryFromItem(item);
        if (entry !== null && entry.actor.sub !== '' && !found.has(entry.actor.sub))
          found.set(entry.actor.sub, entry.at);
      }
    } catch (error) {
      log({ level: 'warn', event: 'team_sign_ins_unread', error: String(error?.code ?? error?.name ?? 'error') });
    }
    return found;
  }

  async function answer(sub, caller) {
    const account = await lookUp(sub);
    return { body: { account: account === null ? null : view(account, { you: caller.sub }) } };
  }

  async function switchTo(enabled, { caller, params, entry }) {
    const id = requireAccountId(params.id);
    entry.target = id;
    if (!enabled) notYourself(caller, id, 'disable');
    const account = await existing(id, entry);
    if (!enabled) await keepAReleaseManager(account);
    const result = await aws.setTeamMemberEnabled(id, enabled);
    if (!result.ok) throw notFound('unknown_account', 'There is no account with this id.');
    change(entry, 'account', stateWords(account), stateWords({ ...account, enabled }));
    return answer(id, caller);
  }

  return {
    async list({ caller }) {
      // A read, and still for release managers only, asked of Cognito now.
      await directory.requireLiveWriter(caller);
      const [accounts, signIns] = await Promise.all([everyone({ withMfa: true }), lastSignIns()]);
      return {
        body: {
          you: caller.sub,
          lastSignInFrom: 'activity-log',
          accounts: accounts
            .map((account) => view(account, { you: caller.sub, lastSignIns: signIns }))
            .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : a.id < b.id ? -1 : 1)),
        },
      };
    },

    async invite({ caller, entry, json }) {
      const body = json();
      const email = requireEmail(field(body, 'email'));
      entry.detail.email = email;
      const tier = requireTier(field(body, 'tier'));
      entry.detail.tier = tier;
      const result = await aws.inviteTeamMember({ email });
      if (!result.ok) throw conflict('account_exists', 'There is an account with this e-mail address already.');
      const sub = result.member.sub;
      entry.target = sub;
      change(entry, 'email', null, email);
      change(entry, 'account', null, 'pending');
      const added = await aws.addTeamMemberToGroup(sub, TIERS[tier]);
      if (!added.ok) throw notFound('unknown_account', 'The new account was gone before it had a tier.');
      change(entry, 'tier', null, tier);
      return {
        status: 201,
        body: { account: view({ ...result.member, tier }, { you: caller.sub }) },
      };
    },

    async resend({ caller, params, entry }) {
      const id = requireAccountId(params.id);
      entry.target = id;
      const account = await existing(id, entry);
      if (account.status !== 'FORCE_CHANGE_PASSWORD') {
        throw conflict('account_not_invited', 'This person has signed in already: there is no invitation to send.');
      }
      const result = await aws.resendTeamInvitation(account.email);
      if (!result.ok && result.reason === 'not_found') {
        throw notFound('unknown_account', 'There is no account with this id.');
      }
      if (!result.ok) throw conflict('account_not_invited', 'This person has signed in already.');
      return answer(id, caller);
    },

    async tier({ caller, params, entry, json }) {
      const id = requireAccountId(params.id);
      entry.target = id;
      const tier = requireTier(field(json(), 'tier'));
      entry.detail.tier = tier;
      notYourself(caller, id, 'change the tier of');
      const account = await existing(id, entry);
      if (account.tier === tier) return answer(id, caller);
      if (tier !== 'release-manager') await keepAReleaseManager(account);
      // The new group first and the old one second, so that the account is never without a tier.
      const added = await aws.addTeamMemberToGroup(id, TIERS[tier]);
      if (!added.ok) throw notFound('unknown_account', 'There is no account with this id.');
      const other = tier === 'release-manager' ? VIEWERS : RELEASE_MANAGERS;
      await aws.removeTeamMemberFromGroup(id, other);
      change(entry, 'tier', account.tier, tier);
      return answer(id, caller);
    },

    async disable(request) {
      return switchTo(false, request);
    },

    async enable(request) {
      return switchTo(true, request);
    },

    async reset({ caller, params, entry }) {
      const id = requireAccountId(params.id);
      entry.target = id;
      notYourself(caller, id, 'reset');
      const account = await existing(id, entry);
      if (account.status === 'FORCE_CHANGE_PASSWORD') {
        throw conflict(
          'account_not_signed_in',
          'This person has not signed in yet, so there is nothing to reset: send the invitation again.'
        );
      }
      if (!account.enabled) {
        throw conflict('account_disabled', 'This account is disabled, and a reset would enable it. Enable it first.');
      }
      if (account.tier === 'none') {
        throw conflict('account_has_no_tier', 'This account has no tier. Give it one first.');
      }
      await keepAReleaseManager(account);
      const removed = await aws.deleteTeamMember(id);
      if (!removed.ok) throw notFound('unknown_account', 'There is no account with this id.');
      change(entry, 'account', stateWords(account), 'pending');
      change(entry, 'authenticator', authenticatorWords(account), 'not set up');
      const made = await aws.inviteTeamMember({ email: account.email });
      if (!made.ok) throw conflict('account_exists', 'An account with this address was made again a moment ago.');
      entry.detail.replacement = made.member.sub;
      await aws.addTeamMemberToGroup(made.member.sub, TIERS[account.tier]);
      return { body: { account: view({ ...made.member, tier: account.tier }, { you: caller.sub }) } };
    },

    async remove({ caller, params, entry }) {
      const id = requireAccountId(params.id);
      entry.target = id;
      notYourself(caller, id, 'remove');
      const account = await existing(id, entry);
      await keepAReleaseManager(account);
      const result = await aws.deleteTeamMember(id);
      if (!result.ok) throw notFound('unknown_account', 'There is no account with this id.');
      change(entry, 'account', stateWords(account), null);
      change(entry, 'tier', account.tier, null);
      return { body: { removed: id } };
    },
  };
}
