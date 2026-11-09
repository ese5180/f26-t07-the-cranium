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
 *
 * The Alerts page (#/alerts, console 2.13.0): the alert rules, which go for everybody who gets the
 * alerts, each with its switch and its thresholds; how alerts reach people; and what went out. Every
 * member reads it; a release manager changes the rules, and each change is on record.
 */

import {
  ALERT_KIND_WORDS,
  ALERT_RULES,
  boardName,
  readAlertRules,
  boardOf,
  deploymentHref,
  deviceHref,
  duration,
  plural,
} from './core.js';
import {
  badge,
  card,
  choice,
  facts,
  freshness,
  h,
  icon,
  linkTo,
  loadProblem,
  mono,
  pageHead,
  pending,
  when,
  whenAt,
} from './views.js';

const STATES = {
  none: ['idle', 'minus-circle', 'Not asked for'],
  pending: ['act', 'clock', 'Waiting for you to confirm'],
  confirmed: ['good', 'check-circle', 'On'],
};

function whoCard(ctx) {
  const { me, sessionLeft } = ctx.state;
  return card(
    { key: 'who', title: 'Signed in' },
    facts([
      ['Address', me.email || 'Not known'],
      ['Role', me.canWrite ? 'Release manager' : 'Viewer'],
      me.sub ? ['Account', mono(me.sub)] : null,
      ['Session', sessionLeft > 0 ? `ends in ${duration(sessionLeft)}` : 'ended'],
    ]),
    h(
      'p',
      { class: 'card-note', key: 'note' },
      'The activity log files what you do under your account, with the address it had at the time.'
    )
  );
}

function alertControls(alerts, ctx) {
  if (!alerts.canSubscribe) {
    return h(
      'p',
      { class: 'quiet', key: 'who' },
      ctx.state.me?.canWrite
        ? 'Your account has no e-mail address to send them to.'
        : 'Release managers can ask for them, at their own address.'
    );
  }
  const busy = ctx.state.alerts.busy;
  if (alerts.subscription === 'confirmed') {
    return h(
      'div',
      { class: 'button-row', key: 'controls' },
      h(
        'button',
        { type: 'button', class: 'btn is-small', disabled: busy, onClick: () => ctx.actions.unsubscribeAlerts() },
        icon('x'),
        'Stop the alerts'
      )
    );
  }
  return h(
    'div',
    { class: 'button-row', key: 'controls' },
    h(
      'button',
      {
        type: 'button',
        class: 'btn is-small is-primary',
        disabled: busy,
        onClick: () => ctx.actions.subscribeAlerts(),
      },
      icon('bell'),
      alerts.subscription === 'pending' ? 'Send the link again' : `Send alerts to ${alerts.email}`
    ),
    alerts.subscription === 'pending'
      ? h(
          'p',
          { class: 'quiet' },
          'Look for the e-mail from AWS Notifications, also among unwanted mail. Its link works for two days.'
        )
      : null
  );
}

/** What each rule is about, in words, with its thresholds as they are. */
export const RULE_WORDS = Object.freeze({
  offline: {
    title: 'A board is offline',
    text: (rule) => `A board offline for more than ${plural(rule.minutes, 'minute')}, and when it is back.`,
    fields: { minutes: ['Offline for more than', 'min'] },
  },
  issue: {
    title: 'A new Memfault issue',
    text: () => 'Memfault groups a crash or a trace event of a board into an issue it has not had before.',
    fields: {},
  },
  crashLoop: {
    title: 'A crash loop',
    text: (rule) =>
      `A board restarts unexpectedly (a crash, an assert, a fault or a watchdog) ${plural(rule.reboots, 'time')} ` +
      `in ${plural(rule.minutes, 'minute')}.`,
    fields: { reboots: ['Restarts', null], minutes: ['Within', 'min'] },
  },
  rollout: {
    title: 'A staged rollout stopped by itself',
    text: () => 'Its canary failed, too many boards of a stage failed, or its health gate found a problem.',
    fields: {},
  },
  voltage: {
    title: 'Low supply voltage',
    text: (rule) => `A board's supply voltage, from its Memfault heartbeat, is under ${rule.mv} mV.`,
    fields: { mv: ['Under', 'mV'] },
  },
});

function ruleList(alerts) {
  const rules = readAlertRules(alerts.alertRules);
  const on = Object.keys(ALERT_RULES).filter((id) => rules[id].on);
  return h(
    'ul',
    { class: 'alert-rules', key: 'rules' },
    on.map((id) => h('li', { key: id }, RULE_WORDS[id].text(rules[id]))),
    h('li', { key: 'update' }, 'An update that failed or was rolled back'),
    h('li', { key: 'stuck' }, 'A board that restarted itself for being stuck'),
    h(
      'li',
      { key: 'moved' },
      `A board whose position moved by more than ${alerts.rules.movedMetres >= 1000 ? `${alerts.rules.movedMetres / 1000} km` : `${alerts.rules.movedMetres} m`}`
    )
  );
}

function sentRow(item, ctx) {
  const devices = ctx.state.devices.value?.devices ?? [];
  const href = item.thing ? deviceHref(item.thing) : deploymentHref(item.deployment);
  return h(
    'li',
    { class: 'row alert-row', key: `${item.at} ${item.subject}` },
    h(
      'div',
      { class: 'row-main' },
      linkTo(href, { class: 'row-title' }, item.subject.replace(/^Cranium: /, '')),
      h(
        'span',
        { class: 'row-note' },
        ALERT_KIND_WORDS[item.kind] ?? item.kind,
        ' · ',
        item.thing ? boardName(boardOf(item.thing, devices), { short: true }) : mono(item.deployment ?? ''),
        item.count > 1 ? ` · ${plural(item.count, 'alert')} in one e-mail` : ''
      )
    ),
    whenAt(item.at, ctx.state.now)
  );
}

function alertsCard(ctx) {
  const resource = ctx.state.alerts;
  const alerts = resource.value;
  if (!alerts) {
    return card(
      { key: 'alerts', title: 'E-mail alerts' },
      loadProblem(resource, 'the alerts', ctx),
      pending(resource, 'the alerts')
    );
  }
  const [tone, iconName, label] = STATES[alerts.subscription];
  return card(
    { key: 'alerts', title: 'E-mail alerts', className: 'alerts-card' },
    h(
      'div',
      { class: 'alerts-state', key: 'state' },
      badge(tone, iconName, label),
      h(
        'span',
        { class: 'quiet' },
        alerts.subscribers === 0
          ? 'Nobody gets them yet.'
          : `${plural(alerts.subscribers, 'address gets', 'addresses get')} them.`
      )
    ),
    h('p', { key: 'lead' }, 'An e-mail, through Amazon SNS, for:'),
    ruleList(alerts),
    h(
      'p',
      { class: 'card-note', key: 'page' },
      linkTo('#/alerts', {}, 'Alert rules'),
      ': turn each on or off and set when it goes.'
    ),
    h(
      'p',
      { class: 'card-note', key: 'limit' },
      `At most one e-mail ${alerts.rules.everyMinutes === 60 ? 'an hour' : `every ${alerts.rules.everyMinutes} minutes`} for each `,
      'board and kind of alert; what happens in between comes with the next one. Each names the board and links to it ',
      'here. No secret, no network name and no position is in one.'
    ),
    alertControls(alerts, ctx)
  );
}

function sentCard(ctx) {
  const alerts = ctx.state.alerts.value;
  if (!alerts) return null;
  return card(
    { key: 'sent', title: 'Sent lately' },
    alerts.recent.length === 0
      ? h('p', { class: 'quiet', key: 'none' }, 'No alert has gone out in the last 30 days.')
      : h(
          'ul',
          { class: 'rows', key: 'rows' },
          alerts.recent.map((item) => sentRow(item, ctx))
        ),
    alerts.recent.length > 0
      ? h('p', { class: 'card-note', key: 'when' }, 'Newest first. ', when(alerts.recent[0].at, ctx.state.now))
      : null
  );
}

export function accountPageView(ctx) {
  return h(
    'div',
    { class: 'page is-account' },
    pageHead({
      title: 'Account',
      lede: 'Who is signed in, and the e-mail alerts.',
      tools: freshness(ctx.state.alerts, ctx),
    }),
    h(
      'div',
      { class: 'split', key: 'split' },
      h('div', { class: 'stack', key: 'left' }, whoCard(ctx), alertsCard(ctx)),
      h('div', { class: 'stack', key: 'right' }, sentCard(ctx))
    )
  );
}

// The Alerts page.

/** The rules as the page edits them: a copy of the server's, until saved or put back. */
function draftOf(ctx) {
  const resource = ctx.state.alerts;
  resource.draft ??= JSON.parse(JSON.stringify(resource.value.alertRules));
  return resource.draft;
}

/** What the draft changes of the rules: { <rule>: { <field>: value } }, only what differs. */
export function ruleChanges(saved, draft) {
  const changes = {};
  for (const id of Object.keys(ALERT_RULES)) {
    for (const [name, value] of Object.entries(draft[id] ?? {})) {
      if (saved[id]?.[name] !== value) changes[id] = { ...(changes[id] ?? {}), [name]: value };
    }
  }
  return changes;
}

function ruleField(ctx, id, name, rule, editable) {
  const [label, unit] = RULE_WORDS[id].fields[name];
  const [low, high] = ctx.state.alerts.value.ruleLimits?.[id]?.[name] ?? ALERT_RULES[id].fields[name];
  if (!editable) return h('span', { class: 'quiet', key: name }, `${label} ${rule[name]}${unit ? ` ${unit}` : ''}`);
  return h(
    'label',
    { class: 'field is-inline', key: name },
    h('span', { class: 'field-label' }, label),
    h('input', {
      class: 'input is-number',
      type: 'number',
      min: String(low),
      max: String(high),
      step: '1',
      value: String(rule[name]),
      disabled: !rule.on,
      onInput: (event) => {
        const read = Number(event.target.value);
        if (Number.isInteger(read) && read >= low && read <= high) {
          draftOf(ctx)[id][name] = read;
          ctx.state.alerts.editing = true;
          ctx.actions.redraw();
        }
      },
    }),
    unit ? h('span', { class: 'quiet' }, unit) : null
  );
}

function ruleRow(ctx, id, editable) {
  const rules = editable ? draftOf(ctx) : ctx.state.alerts.value.alertRules;
  const rule = rules[id];
  const words = RULE_WORDS[id];
  return h(
    'li',
    { class: 'row alert-rule', key: id },
    h(
      'div',
      { class: 'row-main' },
      editable
        ? choice(
            {
              key: 'on',
              type: 'checkbox',
              name: `rule-${id}`,
              checked: rule.on,
              disabled: ctx.state.alerts.busy,
              onChange: (event) => {
                draftOf(ctx)[id].on = event.target.checked;
                ctx.state.alerts.editing = true;
                ctx.actions.redraw();
              },
            },
            words.title,
            h('span', { class: 'choice-note' }, words.text(rule))
          )
        : [
            h('span', { class: 'row-title', key: 'title' }, words.title),
            h('span', { class: 'row-note', key: 'text' }, words.text(rule)),
          ],
      Object.keys(words.fields).length > 0
        ? h(
            'div',
            { class: 'staged-choices', key: 'fields' },
            Object.keys(words.fields).map((name) => ruleField(ctx, id, name, rule, editable))
          )
        : null
    ),
    editable
      ? null
      : badge(rule.on ? 'good' : 'idle', rule.on ? 'check-circle' : 'minus-circle', rule.on ? 'On' : 'Off')
  );
}

function rulesCard(ctx) {
  const alerts = ctx.state.alerts.value;
  const editable = alerts.canChangeRules && ctx.state.me?.canWrite === true;
  const changes = editable ? ruleChanges(alerts.alertRules, draftOf(ctx)) : {};
  const changed = Object.keys(changes).length > 0;
  return card(
    { key: 'rules', title: 'Rules' },
    h(
      'p',
      { class: 'card-lede', key: 'lede' },
      'Which alerts go out, for everybody who gets them. At most one e-mail an hour for each board and kind of alert; ',
      'what happens in between comes with the next one.'
    ),
    h(
      'ul',
      { class: 'rows', key: 'list' },
      Object.keys(ALERT_RULES).map((id) => ruleRow(ctx, id, editable))
    ),
    editable
      ? h(
          'div',
          { class: 'button-row', key: 'save' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn is-small is-primary',
              disabled: !changed || ctx.state.alerts.busy,
              onClick: async () => {
                if (await ctx.actions.setAlertRules(changes)) {
                  ctx.state.alerts.draft = null;
                  ctx.state.alerts.editing = false;
                  ctx.actions.redraw();
                }
              },
            },
            icon('check'),
            'Save the rules'
          ),
          changed
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn is-small',
                  disabled: ctx.state.alerts.busy,
                  onClick: () => {
                    ctx.state.alerts.draft = null;
                    ctx.state.alerts.editing = false;
                    ctx.actions.redraw();
                  },
                },
                'Put back'
              )
            : null
        )
      : h(
          'p',
          { class: 'card-note', key: 'who' },
          'Release managers change these; each change is in the activity log.'
        ),
    h(
      'p',
      { class: 'card-note', key: 'always' },
      'These always go too: an update that failed or was rolled back, a board that restarted itself for being stuck, ',
      'and a board that moved.'
    )
  );
}

function deliveryCard(ctx) {
  const alerts = ctx.state.alerts.value;
  const [tone, iconName, label] = STATES[alerts.subscription];
  return card(
    { key: 'delivery', title: 'How they reach you' },
    facts([
      ['E-mail', badge(tone, iconName, label)],
      [
        'Who gets them',
        alerts.subscribers === 0 ? 'Nobody yet' : `${plural(alerts.subscribers, 'address', 'addresses')}`,
      ],
      ['Open pages and apps', ctx.state.liveUpdates ? 'Shown at once, as they go out' : 'Shown at the next refresh'],
    ]),
    alertControls(alerts, ctx),
    h(
      'p',
      { class: 'card-note', key: 'push' },
      'Each alert also shows on every open page of the console, and in the phone and desktop apps while they are open. ',
      'A notification on a phone that is not showing the app needs Apple’s and Google’s push services, which are not ',
      'set up: the e-mail is that alert.'
    )
  );
}

export function alertsPageView(ctx) {
  const resource = ctx.state.alerts;
  if (!resource.value) {
    return h(
      'div',
      { class: 'page' },
      pageHead({ title: 'Alerts', lede: 'The alert rules, and what went out.' }),
      loadProblem(resource, 'the alerts', ctx),
      pending(resource, 'the alerts')
    );
  }
  return h(
    'div',
    { class: 'page is-alerts' },
    pageHead({
      title: 'Alerts',
      lede: 'The alert rules, how alerts reach people, and what went out.',
      tools: freshness(resource, ctx),
    }),
    h(
      'div',
      { class: 'split', key: 'split' },
      h('div', { class: 'stack', key: 'left' }, rulesCard(ctx)),
      h('div', { class: 'stack', key: 'right' }, deliveryCard(ctx), sentCard(ctx))
    )
  );
}
