/**
 * The Account page: who is signed in, and their e-mail alerts (docs/fleet.md, "Alerts";
 * cloud/api/src/handlers/alerts.mjs). The script is fetched when the page is opened (app.js), from
 * the address in the masthead.
 *
 * A release manager asks for the alerts at their own address, the one their account has, and no
 * other: AWS Notifications then sends a link to confirm, and nothing is sent until it is followed.
 * Every alert e-mail has a link to stop them, and so does this page. A viewer sees what the alerts
 * are and what went out, and cannot ask for them. Which addresses get them is never shown, only
 * how many.
 */

import { ALERT_KIND_WORDS, boardName, boardOf, deploymentHref, deviceHref, duration, plural } from './core.js';
import { badge, card, facts, freshness, h, icon, linkTo, loadProblem, mono, pageHead, pending, when, whenAt } from './views.js';

const STATES = {
  none: ['idle', 'minus-circle', 'Not asked for'],
  pending: ['act', 'clock', 'Waiting for you to confirm'],
  confirmed: ['good', 'check-circle', 'On'],
};

function whoCard(ctx) {
  const { me, sessionLeft } = ctx.state;
  return card({ key: 'who', title: 'Signed in' },
    facts([
      ['Address', me.email || 'Not known'],
      ['Role', me.canWrite ? 'Release manager' : 'Viewer'],
      me.sub ? ['Account', mono(me.sub)] : null,
      ['Session', sessionLeft > 0 ? `ends in ${duration(sessionLeft)}` : 'ended'],
    ]),
    h('p', { class: 'card-note', key: 'note' },
      'The activity log files what you do under your account, with the address it had at the time.'));
}

function alertControls(alerts, ctx) {
  if (!alerts.canSubscribe) {
    return h('p', { class: 'quiet', key: 'who' }, ctx.state.me?.canWrite
      ? 'Your account has no e-mail address to send them to.'
      : 'Release managers can ask for them, at their own address.');
  }
  const busy = ctx.state.alerts.busy;
  if (alerts.subscription === 'confirmed') {
    return h('div', { class: 'button-row', key: 'controls' },
      h('button', { type: 'button', class: 'btn is-small', disabled: busy, onClick: () => ctx.actions.unsubscribeAlerts() },
        icon('x'), 'Stop the alerts'));
  }
  return h('div', { class: 'button-row', key: 'controls' },
    h('button', { type: 'button', class: 'btn is-small is-primary', disabled: busy, onClick: () => ctx.actions.subscribeAlerts() },
      icon('bell'), alerts.subscription === 'pending' ? 'Send the link again' : `Send alerts to ${alerts.email}`),
    alerts.subscription === 'pending'
      ? h('p', { class: 'quiet' }, 'Look for the e-mail from AWS Notifications, also among unwanted mail. Its link works for two days.')
      : null);
}

function ruleList(rules) {
  return h('ul', { class: 'alert-rules', key: 'rules' },
    h('li', null, `A board offline for more than ${rules.offlineMinutes} minutes, and when it is back`),
    h('li', null, 'An update that failed or was rolled back, and a deployment that stopped by itself'),
    h('li', null, 'A board that restarted itself for being stuck'),
    h('li', null, `A board whose position moved by more than ${rules.movedMetres >= 1000 ? `${rules.movedMetres / 1000} km` : `${rules.movedMetres} m`}`));
}

function sentRow(item, ctx) {
  const devices = ctx.state.devices.value?.devices ?? [];
  const href = item.thing ? deviceHref(item.thing) : deploymentHref(item.deployment);
  return h('li', { class: 'row alert-row', key: `${item.at} ${item.subject}` },
    h('div', { class: 'row-main' },
      linkTo(href, { class: 'row-title' }, item.subject.replace(/^Cranium: /, '')),
      h('span', { class: 'row-note' },
        ALERT_KIND_WORDS[item.kind] ?? item.kind, ' · ',
        item.thing ? boardName(boardOf(item.thing, devices), { short: true }) : mono(item.deployment ?? ''),
        item.count > 1 ? ` · ${plural(item.count, 'alert')} in one e-mail` : '')),
    whenAt(item.at, ctx.state.now));
}

function alertsCard(ctx) {
  const resource = ctx.state.alerts;
  const alerts = resource.value;
  if (!alerts) {
    return card({ key: 'alerts', title: 'E-mail alerts' }, loadProblem(resource, 'the alerts', ctx), pending(resource, 'the alerts'));
  }
  const [tone, iconName, label] = STATES[alerts.subscription];
  return card({ key: 'alerts', title: 'E-mail alerts', className: 'alerts-card' },
    h('div', { class: 'alerts-state', key: 'state' }, badge(tone, iconName, label),
      h('span', { class: 'quiet' }, alerts.subscribers === 0
        ? 'Nobody gets them yet.'
        : `${plural(alerts.subscribers, 'address gets', 'addresses get')} them.`)),
    h('p', { key: 'lead' }, 'An e-mail, through Amazon SNS, for:'),
    ruleList(alerts.rules),
    h('p', { class: 'card-note', key: 'limit' },
      `At most one e-mail ${alerts.rules.everyMinutes === 60 ? 'an hour' : `every ${alerts.rules.everyMinutes} minutes`} for each `,
      'board and kind of alert; what happens in between comes with the next one. Each names the board and links to it ',
      'here. No secret, no network name and no position is in one.'),
    alertControls(alerts, ctx));
}

function sentCard(ctx) {
  const alerts = ctx.state.alerts.value;
  if (!alerts) return null;
  return card({ key: 'sent', title: 'Sent lately' },
    alerts.recent.length === 0
      ? h('p', { class: 'quiet', key: 'none' }, 'No alert has gone out in the last 30 days.')
      : h('ul', { class: 'rows', key: 'rows' }, alerts.recent.map((item) => sentRow(item, ctx))),
    alerts.recent.length > 0 ? h('p', { class: 'card-note', key: 'when' }, 'Newest first. ', when(alerts.recent[0].at, ctx.state.now)) : null);
}

export function accountPageView(ctx) {
  return h('div', { class: 'page is-account' },
    pageHead({ title: 'Account', lede: 'Who is signed in, and the e-mail alerts.', tools: freshness(ctx.state.alerts, ctx) }),
    h('div', { class: 'split', key: 'split' },
      h('div', { class: 'stack', key: 'left' }, whoCard(ctx), alertsCard(ctx)),
      h('div', { class: 'stack', key: 'right' }, sentCard(ctx))));
}
