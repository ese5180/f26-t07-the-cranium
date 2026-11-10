/**
 * Everything the console draws.
 *
 * A view is a function from the console's state to a description of the page: a tree
 * of plain objects made with h(). render() turns such a tree into DOM the first time
 * and afterwards changes only what differs, so a page that refreshes every few seconds
 * keeps its focus, its scroll position and its announcements to screen readers.
 *
 * render() is the only code here that writes to the document, and it can only create
 * elements, set attributes and set text. There is no way to hand it markup: a string
 * always becomes a text node, whatever it contains. Inline styles and inline event
 * handlers are refused outright, because the page's content security policy forbids
 * them; the one style API in use is setProperty for custom properties.
 *
 * No dependencies.
 */

import {
  CODE_LENGTH,
  FIRST_WITH_NO_BUTTON,
  SESSION_WARNING_S,
  SIGN_IN_WORDS,
  STEPS,
  actorOf,
  alreadyRuns,
  asksForButton,
  boardName,
  boardOf,
  BLUETOOTH_ONLY_TYPES,
  boardTypeLabel,
  busyBoards,
  compatibilityWords,
  offeredBoards,
  canRetryUpload,
  clockTime,
  compareVersions,
  dateAndTime,
  dayLabel,
  deploymentHref,
  describeAudit,
  describeChanges,
  describeCounts,
  describeDeployment,
  describeExecution,
  describeHistory,
  describeUpdate,
  deviceActivity,
  deviceHref,
  duration,
  exactBytes,
  exactTime,
  failedCheck,
  fileSize,
  IMAGE_CHECKS,
  installStanding,
  isRefusal,
  isRestarting,
  isThing,
  isUnderWay,
  isUnfinished,
  isUnregistered,
  nameOf,
  parseVersion,
  plainMessage,
  plural,
  reviewImage,
  revocationState,
  sentence,
  shortAccount,
  signalQuality,
  singleLine,
  stillFinishing,
  timeAgo,
  timeOfDay,
  TOKEN_DAYS,
  TOKEN_NAME_LIMIT,
  tokenDays,
  toldByDate,
  versionOfDeployment,
} from './core.js';
// The map, commands and alerts (docs/fleet.md).
import { canCommand, distanceWords, positionSteps, unplacedReason } from './core.js';
// The update history (GET /api/updates): every update however it came.
import { describeOutcome, updateHow, updateSummary, updateTime, updateTotals } from './core.js';
// Search and filters of the long lists (docs/search-filters.md).
import {
  ACTIVITY_KINDS,
  ACTIVITY_OUTCOMES,
  filtering,
  filtersHash,
  filtersSet,
  matchesSearch,
  cleanSearch,
  readFilters,
} from './core.js';

// Drawing.

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const PROPERTIES = new Set(['value', 'checked', 'disabled', 'hidden', 'indeterminate']);
const HANDLERS = Symbol('handlers');
const TREE = Symbol('tree');
const NO_PROPS = Object.freeze({});

/**
 * Describe an element. Children may be descriptions, strings, numbers, arrays of
 * those, or null/false for "nothing here".
 */
export function h(tag, props, ...children) {
  const node = { tag, props: props ?? NO_PROPS, children: [], key: props?.key ?? null, el: null };
  collect(node.children, children);
  return node;
}

function collect(into, items) {
  for (const item of items) {
    if (item === null || item === undefined || item === false || item === true) continue;
    if (Array.isArray(item)) collect(into, item);
    else if (typeof item === 'object') into.push(item);
    else into.push({ tag: null, text: String(item), children: null, key: null, el: null });
  }
}

function dispatch(event) {
  const handler = event.currentTarget[HANDLERS]?.[event.type];
  if (handler) handler(event);
}

function setProp(el, name, value, before) {
  if (name === 'key' || name === 'ref') return;
  if (name === 'vars') {
    for (const property of Object.keys(before ?? NO_PROPS)) {
      if (!value || !(property in value)) el.style.removeProperty(property);
    }
    for (const [property, text] of Object.entries(value ?? NO_PROPS)) {
      if (!property.startsWith('--')) throw new Error('Only custom properties may be set from script');
      el.style.setProperty(property, String(text));
    }
    return;
  }
  if (/^on[A-Z]/.test(name)) {
    const type = name.slice(2).toLowerCase();
    const handlers = el[HANDLERS] ?? (el[HANDLERS] = {});
    if (!(type in handlers)) el.addEventListener(type, dispatch);
    handlers[type] = typeof value === 'function' ? value : null;
    return;
  }
  if (name === 'style' || name.startsWith('on') || name === 'srcdoc') {
    throw new Error(`The attribute ${name} is not allowed`);
  }
  if (PROPERTIES.has(name)) {
    const next = name === 'value' ? String(value ?? '') : Boolean(value);
    if (el[name] !== next) el[name] = next;
    return;
  }
  if (value === null || value === undefined || value === false) el.removeAttribute(name);
  else el.setAttribute(name, value === true ? '' : String(value));
}

function setProps(el, before, after) {
  for (const name of Object.keys(before)) {
    if (!(name in after)) setProp(el, name, null, before[name]);
  }
  for (const name of Object.keys(after)) {
    if (before[name] !== after[name] || PROPERTIES.has(name)) setProp(el, name, after[name], before[name]);
  }
}

let created = [];

function create(node, svg) {
  if (node.tag === null) {
    node.el = document.createTextNode('');
    node.el.textContent = node.text;
    return node.el;
  }
  const inSvg = svg || node.tag === 'svg';
  node.el = inSvg ? document.createElementNS(SVG_NAMESPACE, node.tag) : document.createElement(node.tag);
  setProps(node.el, NO_PROPS, node.props);
  for (const child of node.children) node.el.appendChild(create(child, inSvg));
  settleSelect(node);
  if (typeof node.props.ref === 'function') created.push([node.props.ref, node.el]);
  return node.el;
}

/**
 * A select's value picks one of its options, so it is set again once its options are in place.
 * Set before them, it picks none, and the select then reads back as '', so that a later value
 * of '' (the first option, say) would look already set and never be.
 */
function settleSelect(node) {
  if (node.tag !== 'select' || !('value' in node.props)) return;
  const next = String(node.props.value ?? '');
  if (node.el.value !== next || node.el.selectedIndex === -1) node.el.value = next;
}

function same(a, b) {
  return a.tag === b.tag && a.key === b.key;
}

function update(before, after, svg) {
  after.el = before.el;
  if (after.tag === null) {
    if (before.text !== after.text) after.el.textContent = after.text;
    return;
  }
  const inSvg = svg || after.tag === 'svg';
  setProps(after.el, before.props, after.props);
  updateChildren(after.el, before.children, after.children, inSvg);
  settleSelect(after);
}

function updateChildren(parent, before, after, svg) {
  // Children with a key are matched by it, the others in order. A key that turns up
  // twice is matched once; its second bearer is treated like a child without one.
  const keyed = new Map();
  const loose = [];
  for (const child of before) {
    if (child.key === null || keyed.has(child.key)) loose.push(child);
    else keyed.set(child.key, child);
  }

  const gone = [];
  let nextLoose = 0;
  for (const child of after) {
    let match = null;
    if (child.key !== null) {
      match = keyed.get(child.key) ?? null;
      keyed.delete(child.key);
    } else if (nextLoose < loose.length) {
      match = loose[nextLoose];
      nextLoose += 1;
    }
    if (match && same(match, child)) {
      update(match, child, svg);
    } else {
      create(child, svg);
      if (match) gone.push(match);
    }
  }
  for (const child of keyed.values()) gone.push(child);
  for (let index = nextLoose; index < loose.length; index += 1) gone.push(loose[index]);
  for (const child of gone) parent.removeChild(child.el);

  let position = parent.firstChild;
  for (const child of after) {
    if (child.el === position) position = position.nextSibling;
    else parent.insertBefore(child.el, position);
  }
}

/** Draw a description into a container, or bring what is there up to date. */
export function render(container, node) {
  const before = container[TREE];
  if (before && same(before, node)) update(before, node, false);
  else container.replaceChildren(create(node, false));
  container[TREE] = node;

  const ready = created;
  created = [];
  for (const [ref, el] of ready) ref(el);
}

// Icons: drawn here, stroked in the current text colour.

const RING = ['circle', { cx: 12, cy: 12, r: 9 }];
const ICONS = {
  check: [['polyline', { points: '5 12.5 10 17.5 19 7' }]],
  'check-circle': [RING, ['polyline', { points: '8 12.4 11 15.4 16.2 9.4' }]],
  x: [['path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }]],
  'x-circle': [RING, ['path', { d: 'M9 9l6 6M15 9l-6 6' }]],
  clock: [RING, ['polyline', { points: '12 7.5 12 12 15 14' }]],
  alert: [
    ['path', { d: 'M12 4.5l8.5 14.5h-17z' }],
    ['path', { d: 'M12 10.5v3.5M12 16.6v.1' }],
  ],
  ban: [RING, ['path', { d: 'M5.7 5.7l12.6 12.6' }]],
  'minus-circle': [RING, ['path', { d: 'M8 12h8' }]],
  minus: [['path', { d: 'M6 12h12' }]],
  undo: [
    ['polyline', { points: '8 5 4 9 8 13' }],
    ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 0 11H10' }],
  ],
  download: [
    ['path', { d: 'M12 4v11.5M5 20h14' }],
    ['polyline', { points: '7 11 12 16 17 11' }],
  ],
  upload: [
    ['path', { d: 'M12 16V4.5M5 20h14' }],
    ['polyline', { points: '7 9 12 4 17 9' }],
  ],
  restart: [
    ['path', { d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3' }],
    ['polyline', { points: '19.5 3.5 19.5 7.5 15.5 7.5' }],
  ],
  shield: [
    ['path', { d: 'M12 3.5l7 2.6v5.4c0 4.2-2.8 7.4-7 9-4.2-1.6-7-4.8-7-9V6.1z' }],
    ['polyline', { points: '9 12.2 11.2 14.4 15.2 9.9' }],
  ],
  pulse: [['polyline', { points: '3 12 7.5 12 10 6 14 18 16.5 12 21 12' }]],
  press: [RING, ['circle', { cx: 12, cy: 12, r: 3.5 }]],
  stop: [['rect', { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2 }]],
  hourglass: [['path', { d: 'M7 4h10M7 20h10M8 4c0 4.5 4 5.5 4 8s-4 3.5-4 8M16 4c0 4.5-4 5.5-4 8s4 3.5 4 8' }]],
  offline: [['path', { d: 'M3.5 9.5a12 12 0 0 1 17 0M7 13a7 7 0 0 1 10 0M12 17v.1M5 4l14 16' }]],
  online: [['path', { d: 'M3.5 9.5a12 12 0 0 1 17 0M7 13a7 7 0 0 1 10 0M12 17v.1' }]],
  chip: [
    ['rect', { x: 7, y: 7, width: 10, height: 10, rx: 1.5 }],
    ['path', { d: 'M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3' }],
  ],
  package: [['path', { d: 'M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7zM4.5 7.7l7.5 4.3 7.5-4.3M12 12v8.5' }]],
  send: [['path', { d: 'M20.5 3.5L10 14M20.5 3.5l-6.5 17-4-6.5-6.5-4z' }]],
  list: [['path', { d: 'M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5v.1M4.5 12v.1M4.5 17.5v.1' }]],
  user: [
    ['circle', { cx: 12, cy: 8.5, r: 3.5 }],
    ['path', { d: 'M5 20a7 7 0 0 1 14 0' }],
  ],
  copy: [
    ['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }],
    ['path', { d: 'M5 15V6a2 2 0 0 1 2-2h8' }],
  ],
  'arrow-right': [
    ['path', { d: 'M5 12h14' }],
    ['polyline', { points: '13 6 19 12 13 18' }],
  ],
  'arrow-left': [
    ['path', { d: 'M19 12H5' }],
    ['polyline', { points: '11 6 5 12 11 18' }],
  ],
  key: [
    ['circle', { cx: 8, cy: 15.5, r: 4 }],
    ['path', { d: 'M11 12.6l8.5-8.6M15.5 8l3 3' }],
  ],
  lock: [
    ['rect', { x: 5.5, y: 11, width: 13, height: 9, rx: 2 }],
    ['path', { d: 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3' }],
  ],
  plus: [['path', { d: 'M12 5.5v13M5.5 12h13' }]],
  swap: [
    ['polyline', { points: '8 4 4 8 8 12' }],
    ['path', { d: 'M4 8h13' }],
    ['polyline', { points: '16 12 20 16 16 20' }],
    ['path', { d: 'M20 16H7' }],
  ],
  file: [['path', { d: 'M7 3.5h7l4 4v13H7zM14 3.5v4h4' }]],
  'sign-out': [
    ['path', { d: 'M10 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H10M9.5 12H20' }],
    ['polyline', { points: '16 8 20 12 16 16' }],
  ],
  // The map, commands and alerts.
  locate: [
    ['circle', { cx: 12, cy: 12, r: 6.5 }],
    ['circle', { cx: 12, cy: 12, r: 1.6 }],
    ['path', { d: 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3' }],
  ],
  pin: [
    ['path', { d: 'M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z' }],
    ['circle', { cx: 12, cy: 10, r: 2.4 }],
  ],
  bell: [['path', { d: 'M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14zM10 20.5h4' }]],
  more: [['path', { d: 'M5.5 12v.1M12 12v.1M18.5 12v.1' }]],
  // The sections of the console (console 2.7): one set, the same stroke as every icon above.
  home: [['path', { d: 'M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6h-6v6H5.5A1.5 1.5 0 0 1 4 19z' }]],
  layers: [['path', { d: 'M12 4l8.5 4.5L12 13 3.5 8.5zM3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5' }]],
  phone: [
    ['rect', { x: 7, y: 3, width: 10, height: 18, rx: 2 }],
    ['path', { d: 'M11 17.5h2' }],
  ],
  users: [
    ['circle', { cx: 9, cy: 9, r: 3.2 }],
    ['path', { d: 'M3.5 19.5a5.5 5.5 0 0 1 11 0M15.5 6.2a3.2 3.2 0 0 1 0 5.8M17.5 14.5a5.5 5.5 0 0 1 3 5' }],
  ],
  code: [['path', { d: 'M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15' }]],
  bluetooth: [['path', { d: 'M7 7.5l10 9-5 4.5v-18l5 4.5-10 9' }]],
  'chevron-right': [['polyline', { points: '9.5 5.5 16 12 9.5 18.5' }]],
  'chevron-left': [['polyline', { points: '14.5 5.5 8 12 14.5 18.5' }]],
  chart: [['path', { d: 'M4 4.5v15h16M8 15.5l3.5-4 3 2.5L19 8' }]],
  search: [
    ['circle', { cx: 10.5, cy: 10.5, r: 6 }],
    ['path', { d: 'M15 15l5 5' }],
  ],
  filter: [['path', { d: 'M4 6h16M7 12h10M10 18h4' }]],
};

/** A decorative icon. Its meaning is always also given in words next to it. */
export function icon(name, className = '') {
  const shapes = ICONS[name] ?? ICONS.minus;
  return h(
    'svg',
    {
      class: `icon ${className}`.trim(),
      viewBox: '0 0 24 24',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    shapes.map(([tag, attributes]) => h(tag, attributes))
  );
}

// Brand artwork. All of it is decoration: it says nothing that the words beside it do not.

const DOME = 'M2 18a14 14 0 0 1 28 0v9a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z';
const GROOVES = 'M7 30V18a9 9 0 0 1 18 0v12M12 30V18a4 4 0 0 1 8 0v12';

/** The mark: a dome cut with the grooves of a record. */
export function brandMark(className = '') {
  return h(
    'svg',
    {
      class: `brand-mark ${className}`.trim(),
      viewBox: '0 0 32 32',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    h('path', { class: 'brand-dome', d: DOME }),
    h('path', { class: 'brand-grooves', d: GROOVES })
  );
}

/** The same dome at the scale of a wall, rising from the bottom edge of what holds it. */
function domeArt(className = '') {
  const grooves = [];
  for (let radius = 52, step = 0; radius < 430; step += 1, radius += 34 + step * 1.5) {
    grooves.push(
      h('path', {
        key: String(step),
        class: 'art-groove',
        pathLength: '1',
        d: `M${500 - radius} 1000V540a${radius} ${radius} 0 0 1 ${radius * 2} 0V1000`,
        vars: { '--step': String(step) },
      })
    );
  }
  return h(
    'svg',
    {
      class: `dome-art ${className}`.trim(),
      viewBox: '0 0 1000 1000',
      preserveAspectRatio: 'xMidYMax meet',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    h('path', { class: 'art-dome', d: 'M40 1000V540a460 460 0 0 1 920 0V1000z' }),
    grooves
  );
}

/** Thin arches in the corner of a panel: the dome again, as a watermark. */
function archWatermark() {
  const lines = [];
  for (let radius = 60; radius <= 420; radius += 60) {
    lines.push(
      h('path', {
        key: String(radius),
        d: `M${440 - radius} 480V${440}a${radius} ${radius} 0 0 1 ${radius * 2} 0V480`,
      })
    );
  }
  return h(
    'svg',
    {
      class: 'arch-watermark',
      viewBox: '0 0 880 480',
      preserveAspectRatio: 'xMaxYMax meet',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    lines
  );
}

// Line drawings for pages with nothing on them yet.

const DRAWINGS = {
  // A development board: its chip, its pin headers, a button and an LED.
  chip: [
    ['rect', { x: 18, y: 14, width: 124, height: 72, rx: 5 }],
    ['rect', { x: 66, y: 34, width: 32, height: 32, rx: 2, class: 'is-accent' }],
    [
      'path',
      { d: 'M74 34v-5M82 34v-5M90 34v-5M74 66v5M82 66v5M90 66v5M66 42h-5M66 50h-5M66 58h-5M98 42h5M98 50h5M98 58h5' },
    ],
    ['path', { d: 'M26 22h40M122 78h12M26 78h28' }],
    ['rect', { x: 8, y: 40, width: 10, height: 20, rx: 1.5 }],
    ['circle', { cx: 122, cy: 30, r: 4 }],
    ['circle', { cx: 122, cy: 50, r: 7 }],
  ],
  // Two flash slots: one holds an image, the other is free.
  package: [
    ['rect', { x: 20, y: 16, width: 120, height: 28, rx: 3, class: 'is-accent' }],
    ['rect', { x: 20, y: 56, width: 120, height: 28, rx: 3, class: 'is-dashed' }],
    ['path', { d: 'M32 26h44M32 34h28' }],
    ['path', { d: 'M122 24l6 2.2v4c0 3.2-2.4 5.2-6 6.8-3.6-1.6-6-3.6-6-6.8v-4z' }],
  ],
  // A release on its way out to three boards.
  send: [
    ['circle', { cx: 28, cy: 50, r: 10, class: 'is-accent' }],
    ['path', { d: 'M38 50h30M68 50c16 0 18-26 34-26h14M68 50h48M68 50c16 0 18 26 34 26h14' }],
    ['rect', { x: 116, y: 15, width: 26, height: 18, rx: 2 }],
    ['rect', { x: 116, y: 41, width: 26, height: 18, rx: 2 }],
    ['rect', { x: 116, y: 67, width: 26, height: 18, rx: 2 }],
  ],
  // A ledger: lines that have not been written yet.
  list: [
    ['path', { d: 'M48 12v76' }],
    ['circle', { cx: 48, cy: 26, r: 5, class: 'is-accent' }],
    ['circle', { cx: 48, cy: 50, r: 5 }],
    ['circle', { cx: 48, cy: 74, r: 5 }],
    ['path', { class: 'is-dashed', d: 'M64 26h64M64 50h48M64 74h56' }],
  ],
};

function drawing(name) {
  const shapes = DRAWINGS[name];
  if (!shapes) return null;
  return h(
    'svg',
    {
      class: 'drawing',
      viewBox: '0 0 160 100',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    shapes.map(([tag, attributes], index) => h(tag, { ...attributes, key: String(index) }))
  );
}

// Small pieces used by every view.

function badge(tone, iconName, label, title) {
  return h('span', { class: `badge is-${tone}`, title }, icon(iconName), h('span', null, label));
}

function mono(content, className = '') {
  return h('span', { class: `mono ${className}`.trim() }, content);
}

const TECHNICAL = /(\d+\.\d+\.\d+\+\d+|(?:[\w-]+\/)*(?:[\w*-]+\.)?signed\.bin)/;

/** A sentence from core.js, with the versions and the file names in it set in the monospace face. */
function prose(text) {
  return String(text ?? '')
    .split(TECHNICAL)
    .map((part, index) => (index % 2 ? mono(part) : part));
}

/** A link when there is somewhere valid to go, plain text otherwise. */
function linkTo(href, props, ...children) {
  return href ? h('a', { ...props, href }, children) : h('span', props, children);
}

/**
 * A board by what people call it (boardName in core.js), as a link to its page. Its thing
 * name is the tooltip; where there is room, boardThing() writes it out next to the name.
 */
function boardLabel(board, className = '', href = deviceHref(board.thing)) {
  return linkTo(href, { class: `mono ${className}`.trim(), title: board.thing }, boardName(board));
}

/**
 * The thing name of a board that has a name of its own, smaller and quieter, after a space
 * that sets it apart from the name in what is read and copied; nothing for a board without one.
 */
function boardThing(board, className = '') {
  if (boardName(board) === board.thing) return null;
  return [' ', h('span', { class: `board-thing mono ${className}`.trim() }, board.thing)];
}

/** A time, told relative to now, with the exact time as its tooltip. */
function when(iso, now, prefix = '') {
  if (!iso) return null;
  return h('time', { datetime: iso, title: exactTime(iso) }, `${prefix}${timeAgo(iso, now)}`);
}

/** The same, with the time of day written out: for where the exact moment matters. */
function whenAt(iso, now, prefix = '') {
  if (!iso) return null;
  // Old enough to be told by its date already: the day is not said twice.
  if (toldByDate(iso, now)) return h('time', { datetime: iso, title: exactTime(iso) }, `${prefix}${dateAndTime(iso)}`);
  return [when(iso, now, prefix), ` (${clockTime(iso, now)})`];
}

/** The time of day alone: for an entry under a heading that names its day. */
function whenInDay(iso) {
  if (!iso) return null;
  return h('time', { datetime: iso, title: exactTime(iso) }, timeOfDay(iso));
}

function whenLoaded(resource, now) {
  return when(new Date(resource.loadedAt).toISOString(), now);
}

/**
 * A person, named by the address their account showed at the time. The address is
 * display data that its owner can change; the account id is the identity, and is the
 * tooltip of the name wherever a person is named.
 */
function who(person) {
  return h('span', { class: 'who', title: person?.sub ? `Account ${person.sub}` : null }, nameOf(person));
}

function signed(number) {
  return number < 0 ? `−${Math.abs(number)}` : String(number);
}

function button(className, onClick, ...children) {
  return h('button', { type: 'button', class: `btn ${className}`.trim(), onClick }, children);
}

function meter(percent, label) {
  return h(
    'div',
    {
      class: 'meter',
      role: 'progressbar',
      'aria-label': label,
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(percent),
      vars: { '--progress': `${percent}%` },
    },
    h('span', { class: 'meter-fill' })
  );
}

function facts(rows) {
  return h(
    'dl',
    { class: 'facts' },
    rows
      .filter(Boolean)
      .map(([term, ...value]) => h('div', { class: 'fact', key: term }, h('dt', null, term), h('dd', null, value)))
  );
}

function factNote(text) {
  return h('span', { class: 'fact-note' }, text);
}

/**
 * One whole split into parts, read at a glance. Each part is a block as wide as its
 * share, with its amount printed on it where it fits; the accessible name gives every
 * part in words, and so does the legend next to it. `tone` picks the fill.
 */
function segments(parts, label, { thin = false } = {}) {
  const shown = parts.filter((part) => part.amount > 0);
  return h(
    'div',
    {
      class: `segments ${thin ? 'is-thin' : ''}`.trim(),
      role: 'img',
      'aria-label': label,
    },
    shown.map((part) =>
      h(
        'span',
        {
          key: part.key,
          class: `segment is-${part.tone}`,
          title: `${part.name}: ${part.amount}`,
          vars: { '--share': String(part.amount) },
        },
        thin ? null : h('span', { class: 'segment-value' }, String(part.amount))
      )
    )
  );
}

/** The parts of a board count, as `segments` and describeCounts see them. */
function countParts(counts, atButton = 0) {
  return describeCounts(counts, atButton).map((entry) => ({
    key: entry.name,
    amount: entry.count,
    tone: entry.tone,
    name: entry.label,
  }));
}

function countWords(counts, atButton = 0) {
  return describeCounts(counts, atButton)
    .map((entry) => `${entry.count} ${entry.label}`)
    .join(', ');
}

/** A row of big numbers, each with what it counts. */
function stats(rows) {
  return h(
    'dl',
    { class: 'stats' },
    rows
      .filter(Boolean)
      .map(([label, value, note]) =>
        h(
          'div',
          { key: label, class: 'stat' },
          h('dt', { class: 'stat-label' }, label),
          h('dd', { class: 'stat-value' }, String(value)),
          note ? h('dd', { class: 'stat-note' }, note) : null
        )
      )
  );
}

/**
 * One tile per board: filled while it is online, an outline once it has gone quiet, a
 * dashed outline if it has never reported. The words next to the tiles count the same.
 */
function boardTiles(devices, phone = new Set()) {
  const rank = (device) => {
    if (isUp(device)) return 0;
    if (phone.has(device.thing)) return 3;
    return device.lastSeen ? 1 : 2;
  };
  // A board without Wi-Fi never connects: it is no board that has never connected (fleet.js).
  const looks = ['is-on', 'is-off', 'is-never', 'is-phone'];
  const ordered = [...devices].sort((a, b) => rank(a) - rank(b));
  return h(
    'span',
    { class: 'tiles', 'aria-hidden': 'true' },
    ordered.map((device) =>
      h('span', { key: device.thing, class: `tile ${looks[rank(device)]}`, title: boardName(device, { full: true }) })
    )
  );
}

/** Nothing here yet: what that means, and what to do next. `action` is a link drawn as a button. */
function empty({ iconName, title, text, command, action }) {
  return h(
    'div',
    { class: 'empty' },
    drawing(iconName) ?? h('span', { class: 'empty-icon' }, icon(iconName)),
    h('p', { class: 'empty-title' }, title),
    text ? h('p', { class: 'empty-text' }, text) : null,
    command ? h('code', { class: 'code' }, command) : null,
    action ? h('a', { class: 'btn', href: action.href, onClick: action.onClick ?? null }, action.label) : null
  );
}

const NO_BOARDS = {
  iconName: 'chip',
  title: 'No boards are registered yet.',
  text: 'Provision one with',
  command: 'python3 tools/provision_device.py',
};

const NOTICE_ROLES = { bad: 'alert', warn: 'status' };

/**
 * A boxed message. `said` is announced to a screen reader: at once for bad news, in
 * turn for a warning. `more` is shown with it and not announced. Whatever changes
 * while the message stands, such as a time or a request id, goes there, or it would be
 * read out again at every change.
 */
function notice(tone, iconName, said, { more = null, action = null } = {}) {
  return h(
    'div',
    { class: `notice is-${tone}` },
    icon(iconName),
    h(
      'div',
      { class: 'notice-text' },
      h('span', { class: 'notice-said', role: NOTICE_ROLES[tone] ?? null }, said),
      more
    ),
    action
  );
}

/** How to refer to a failed request: the server's code for it and the request id. */
function problemRef(error) {
  const coded = error.status >= 400 && error.code && !['gateway', 'http', 'unauthorized'].includes(error.code);
  if (!coded && !error.requestId) return null;
  return h(
    'span',
    { class: 'notice-ref dotted' },
    coded ? h('span', null, 'Code ', mono(error.code)) : null,
    error.requestId ? h('span', null, 'Request ', mono(error.requestId)) : null
  );
}

/**
 * A failed action: what did not happen, then the server's own words. Only a refusal
 * (a 4xx reply) says for certain that nothing was done; after anything else the
 * request may have been carried out all the same, and the notice says so. When the
 * session has ended, `signIn` is the way on.
 */
function failure(refusal, error, extra, signIn) {
  const lead = isRefusal(error) ? refusal : 'It is not certain whether this went through.';
  return notice('bad', 'x-circle', [h('strong', null, lead, ' '), sentence(plainMessage(error))], {
    more: [extra ?? null, problemRef(error)],
    action: error.status === 401 && signIn ? button('is-small', signIn, 'Sign in again') : null,
  });
}

function loadProblem(resource, what, ctx) {
  return resource.error ? loadNotice([resource], what, ctx) : null;
}

/** What could not be read. `failed` holds the resources this one notice speaks for. */
function loadNotice(failed, what, ctx) {
  const [{ error }] = failed;
  const stale = failed.filter((resource) => resource.value !== null);
  const oldest = stale.reduce((first, resource) => (resource.loadedAt < first.loadedAt ? resource : first), stale[0]);
  return h(
    'div',
    { key: `problem-${what}`, class: 'page-notice' },
    notice(
      'bad',
      'alert',
      [
        h('strong', null, stale.length > 0 ? `Could not refresh ${what}. ` : `Could not load ${what}. `),
        sentence(plainMessage(error)),
      ],
      {
        // The age changes with the clock and the request id with every retry.
        more: [
          stale.length > 0 ? [' Showing what was loaded ', whenLoaded(oldest, ctx.state.now), '.'] : null,
          problemRef(error),
        ],
        action: button('is-small', ctx.actions.refresh, 'Try again'),
      }
    )
  );
}

/**
 * The same for a page that reads several things. One lost connection fails them all
 * alike: that is one problem, with one way to try again. `items` is [resource, what].
 */
function loadProblems(items, ctx) {
  const failed = items.filter(([resource]) => resource.error);
  if (failed.length === 0) return null;
  const [[{ error: first }]] = failed;
  const alike = failed.every(([{ error }]) => error.message === first.message);
  if (failed.length > 1 && alike)
    return loadNotice(
      failed.map(([resource]) => resource),
      'this page',
      ctx
    );
  return failed.map(([resource, what]) => loadProblem(resource, what, ctx));
}

/** The server knows of no such thing: nothing to try again, and the way back instead. */
function missing(resource) {
  return resource.error?.status === 404;
}

function loading(what) {
  return h('p', { class: 'loading', key: 'loading' }, `Loading ${what}…`);
}

/** What a card shows while its data is on the way; nothing once loading has failed. */
function pending(resource, what) {
  return resource.error ? null : loading(what);
}

function copyButton(value, label, ctx) {
  return h(
    'button',
    {
      type: 'button',
      class: 'btn is-quiet is-icon',
      title: `Copy ${label}`,
      'aria-label': `Copy ${label}`,
      onClick: () => ctx.actions.copy(value, label),
    },
    icon('copy')
  );
}

/**
 * How fresh the page is: live while the live API tells it of changes (docs/live.md) or while it is
 * being polled often, otherwise when it was loaded.
 */
function freshness(resource, ctx) {
  const { interval, now, liveUpdates } = ctx.state;
  const polled = interval > 0 && interval <= 10000;
  const live = liveUpdates === true || polled;
  return h(
    'div',
    { class: 'freshness' },
    live
      ? h(
          'span',
          {
            class: 'freshness-live',
            title: polled
              ? `Refreshing by itself every ${interval / 1000} s. Paused while this tab is in the background.`
              : 'Refreshing by itself as soon as something changes. Paused while this tab is in the background.',
          },
          h('span', { class: 'live-dot' }),
          // The rate is left out where the row is narrow; the tooltip keeps it.
          h(
            'span',
            null,
            'Live',
            polled ? h('span', { class: 'freshness-rate' }, ` · every ${interval / 1000} s`) : null
          )
        )
      : resource.loadedAt
        ? h('span', { class: 'freshness-age' }, 'Updated ', whenLoaded(resource, now))
        : null,
    h(
      'button',
      {
        type: 'button',
        class: 'btn is-quiet is-icon',
        title: 'Refresh now',
        'aria-label': 'Refresh now',
        onClick: ctx.actions.refresh,
      },
      icon('restart', resource.loading ? 'is-spinning' : '')
    )
  );
}

function pageHead({ title, lede, meta, back, tools, eyebrow }) {
  return h(
    'header',
    { class: 'page-head' },
    back ? h('a', { class: 'back', href: back.href }, icon('chevron-left'), back.label) : null,
    h(
      'div',
      { class: 'page-head-row' },
      h(
        'div',
        { class: 'page-head-text' },
        // The eyebrow says what kind of thing the title names, so it is part of the
        // heading: a list of headings reads "Deployment of 1.2.3+5", not "1.2.3+5".
        h(
          'h1',
          { class: 'page-title', id: 'page-title', tabindex: '-1' },
          eyebrow ? h('span', { class: 'eyebrow' }, eyebrow, ' ') : null,
          title
        ),
        lede ? h('p', { class: 'page-lede' }, lede) : null,
        meta ? h('div', { class: 'page-meta dotted' }, meta) : null
      ),
      tools ? h('div', { class: 'page-tools' }, tools) : null
    )
  );
}

// Search and filters (docs/search-filters.md): one bar for every long list. A search box, the filters that
// suit the list, how many rows are shown of how many, and Clear. On a phone the filters fold under a
// Filters button, with the count of those that are set; from 700 px wide they stand in a row. What the bar
// holds is the page's (state.filters, kept in the address by app.js), and each change goes through ctx.actions.

/**
 * The bar. `filters` are the page's (core.js readFilters), the search as typed among them as q; `controls` are
 * its filters, made with filterSelect; `shown` and `total` count rows, or `count` says it in words where the
 * list is read from the server a page at a time.
 */
export function filterBar(ctx, view, { label, placeholder, controls = [], shown = null, total = null, count = null }) {
  const filters = ctx.state.filters?.[view] ?? {};
  const set = filtersSet(filters);
  const narrowed = filtering({ ...filters, q: cleanSearch(filters.q ?? '') });
  const open = ctx.state.filtersOpen === true;
  let counted = count;
  if (counted === null && shown !== null && total !== null) {
    counted = narrowed ? `${shown} of ${total} shown` : `${total} shown`;
  }
  return h(
    'section',
    {
      key: 'filter-bar',
      class: `filter-bar ${open ? 'is-open' : ''} ${controls.length > 0 ? 'has-controls' : ''}`
        .replace(/\s+/g, ' ')
        .trim(),
      role: 'search',
      'aria-label': `Search and filter ${label}`,
    },
    h(
      'div',
      { class: 'filter-row' },
      h(
        'label',
        { class: 'filter-search' },
        icon('search', 'is-small'),
        h('span', { class: 'sr-only' }, `Search ${label}`),
        h('input', {
          class: 'input filter-input',
          type: 'search',
          value: filters.q ?? '',
          placeholder,
          maxlength: '100',
          autocomplete: 'off',
          autocapitalize: 'off',
          spellcheck: 'false',
          enterkeyhint: 'search',
          onInput: (event) => ctx.actions.setFilter(view, 'q', event.currentTarget.value),
        })
      ),
      controls.length > 0
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn is-small filter-toggle',
              'aria-expanded': open ? 'true' : 'false',
              onClick: ctx.actions.toggleFilters,
            },
            icon('filter', 'is-small'),
            'Filters',
            set > 0 ? h('span', { class: 'chip-count', 'aria-label': `${set} set` }, String(set)) : null
          )
        : null
    ),
    controls.length > 0 ? h('div', { class: 'filter-controls' }, controls) : null,
    h(
      'div',
      { class: 'filter-foot' },
      h('p', { class: 'filter-count', role: 'status' }, counted ?? ''),
      narrowed
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn is-small is-quiet filter-clear',
              onClick: () => ctx.actions.clearFilters(view),
            },
            icon('x', 'is-small'),
            'Clear'
          )
        : null
    )
  );
}

/** One filter of the bar: a labelled select of `options` ([value, words, title?]), with `all` for no filter. */
export function filterSelect(ctx, view, { name, label, all, options }) {
  const value = ctx.state.filters?.[view]?.[name] ?? '';
  return h(
    'label',
    { class: 'inline-field filter-field', key: name },
    h('span', { class: 'inline-field-label' }, label),
    h(
      'select',
      {
        class: 'input is-select',
        value,
        onChange: (event) => ctx.actions.setFilter(view, name, event.currentTarget.value),
      },
      h('option', { value: '', key: '', selected: value === '' }, all),
      options.map(([option, words, title = null]) =>
        h('option', { value: option, key: option, title, selected: value === option }, words)
      )
    )
  );
}

/** One filter of the bar that is a day: from or to, as <input type="date"> writes it. */
export function filterDay(ctx, view, { name, label }) {
  const value = ctx.state.filters?.[view]?.[name] ?? '';
  return h(
    'label',
    { class: 'inline-field filter-field', key: name },
    h('span', { class: 'inline-field-label' }, label),
    h('input', {
      class: 'input filter-day',
      type: 'date',
      value,
      onChange: (event) => ctx.actions.setFilter(view, name, event.currentTarget.value),
    })
  );
}

/** The rows of a short list that the page's search and filters keep: `keep(row, filters)` and `words(row)`. */
export function filtered(ctx, view, rows, { words, keep = () => true }) {
  const filters = { ...readFilters(view), ...ctx.state.filters?.[view] };
  return rows.filter((row) => keep(row, filters) && matchesSearch(words(row), filters.q ?? ''));
}

/** A list that the search and filters left empty: say so, with Clear. */
export function noneMatch(ctx, view, what) {
  return card(
    { key: 'none-match' },
    empty({
      iconName: 'search',
      title: `No ${what} match.`,
      text: 'Try other words, or clear the search and filters to see them all.',
    }),
    h(
      'p',
      { class: 'button-row filter-none', key: 'clear' },
      button('', () => ctx.actions.clearFilters(view), icon('x', 'is-small'), 'Clear the search and filters')
    )
  );
}

function card({ key, title, more, className = '' }, ...body) {
  return h(
    'section',
    { key, class: `card ${className}`.trim() },
    title || more
      ? h(
          'header',
          { class: 'card-head' },
          title ? h('h2', { class: 'eyebrow' }, title) : null,
          more ? h('a', { class: 'card-more', href: more.href }, more.label, icon('chevron-right')) : null
        )
      : null,
    // The body is the group of a grouped list (console 2.7): the heading stands above it.
    h('div', { class: 'card-body' }, body)
  );
}

function presence(device, now) {
  // A board that is restarting is off for the moment, whatever its last connection says.
  if (isRestarting(device)) return badge('idle', 'restart', 'Restarting');
  if (device.online) {
    const reported = device.lastSeen ? `Last heartbeat ${timeAgo(device.lastSeen, now)}` : null;
    return badge('good', 'online', 'Online', reported);
  }
  if (!device.lastSeen) return badge('idle', 'minus-circle', 'Never connected');
  return badge('idle', 'offline', 'Offline', `Last heartbeat ${exactTime(device.lastSeen)}`);
}

/**
 * The state of a board and when its last heartbeat arrived, or null for one that has never had
 * one. The API says whether it is online. This page does not work that out again from the time.
 */
function heartbeatWords(device, now) {
  let words = ['Offline', 'last heartbeat'];
  if (isRestarting(device)) words = ['Restarting', 'last heartbeat'];
  else if (device.online) words = ['Online', 'heartbeat'];
  if (device.lastSeen) return when(device.lastSeen, now, `${words[0]}, ${words[1]} `);
  return device.online ? words[0] : null;
}

/** An icon and a few words for a state; `description` comes from core.js. */
function statusLine(description, extra) {
  return h(
    'span',
    { class: `status is-${description.tone} ${description.quiet ? 'is-quiet' : ''}`.trim() },
    icon(description.icon),
    h('span', null, description.title ?? description.label),
    extra ?? null
  );
}

const REVOCATION_OPEN =
  'The server has not recorded that the image is refused and that every open ' +
  'deployment of this release is cancelled.';

/** The badges of a release: its status, and a warning while its revocation is not finished. */
function releaseBadge(release) {
  if (release.status === 'active') return badge('good', 'check-circle', 'Active');
  return [
    badge('bad', 'ban', 'Revoked'),
    revocationState(release) === 'incomplete' ? badge('warn', 'alert', 'Revocation incomplete', REVOCATION_OPEN) : null,
  ];
}

function signalBars(quality, old = false) {
  return h(
    'svg',
    { class: `signal ${old ? 'is-old' : ''}`.trim(), viewBox: '0 0 22 16', 'aria-hidden': 'true', focusable: 'false' },
    [0, 1, 2, 3].map((index) =>
      h('rect', {
        key: String(index),
        class: index < quality.bars ? 'is-on' : null,
        x: String(index * 6),
        y: String(11 - index * 3.67),
        width: '4',
        height: String(5 + index * 3.67),
        rx: '1',
      })
    )
  );
}

/** A message at the foot of the page. It stays until its time is up, or until it is closed. */
export function toastView(message, close) {
  return h(
    'div',
    { class: 'toast-body' },
    h('span', { class: 'toast-text' }, message),
    h(
      'button',
      {
        type: 'button',
        class: 'toast-close',
        title: 'Close',
        'aria-label': 'Close',
        onClick: close,
      },
      icon('x', 'is-small')
    )
  );
}

// Where the scale of a signal reading starts and ends, in dBm.
const SIGNAL_FLOOR = -90;
const SIGNAL_CEILING = -40;
// The bands of signalQuality in core.js, weakest first, with the reading each one starts at.
const SIGNAL_BANDS = [
  ['Weak', SIGNAL_FLOOR],
  ['Fair', -75],
  ['Good', -67],
  ['Excellent', -55],
];

function onSignalScale(rssi) {
  const place = (rssi - SIGNAL_FLOOR) / (SIGNAL_CEILING - SIGNAL_FLOOR);
  return `${Math.round(Math.min(1, Math.max(0, place)) * 1000) / 10}%`;
}

/** A reading on the scale of a signal meter: the four bands, and a needle where the board is. */
function signalScale(device) {
  const quality = signalQuality(device.rssi);
  if (!quality) return null;
  return h(
    'div',
    {
      class: 'signal-scale',
      role: 'img',
      'aria-label': `Wi-Fi signal ${signed(device.rssi)} dBm, ${quality.label.toLowerCase()}`,
    },
    h(
      'div',
      { class: 'signal-track' },
      SIGNAL_BANDS.map(([label, from], index) => {
        const to = SIGNAL_BANDS[index + 1]?.[1] ?? SIGNAL_CEILING;
        return h(
          'span',
          {
            key: label,
            class: `signal-band ${label === quality.label ? 'is-here' : ''}`.trim(),
            vars: { '--span': String(to - from) },
          },
          h('span', { class: 'signal-band-name' }, label)
        );
      }),
      h('span', { class: 'signal-needle', vars: { '--at': onSignalScale(device.rssi) } })
    )
  );
}

// What a board's flash holds: the bootloader and the two slots.

/**
 * One row of the flash map. A row only ever fills while bytes are really arriving; a
 * slot that holds an image is said in words, because nothing reports how full it is.
 */
function flashRow(name, { version, none = 'No new image', state, tone = 'idle', iconName = null, receiving = null }) {
  return h(
    'li',
    {
      key: name,
      class: `flash-row is-${tone} ${receiving === null ? '' : 'is-receiving'}`.trim(),
      vars: receiving === null ? null : { '--fill': `${receiving}%` },
    },
    h('span', { class: 'flash-name' }, name),
    h('span', { class: 'flash-version' }, version ? mono(version) : h('span', { class: 'flash-none' }, none)),
    h('span', { class: 'flash-state' }, iconName ? icon(iconName, 'is-small') : null, h('span', null, state))
  );
}

const WORKED_OUT = 'Worked out from the step the board last reported.';

function flashMap(title, primary, secondary, { swapping = false, heading = 'h3', note = WORKED_OUT } = {}) {
  return h(
    'section',
    { class: 'flash', key: 'flash', 'aria-label': title },
    h(heading, { class: 'eyebrow flash-title' }, title),
    h(
      'ul',
      { class: 'flash-rows' },
      h(
        'li',
        { key: 'boot', class: 'flash-row is-boot' },
        h('span', { class: 'flash-name' }, 'Bootloader'),
        h('span', { class: 'flash-version' }, mono('MCUboot')),
        h('span', { class: 'flash-state' }, 'Checks every signature')
      ),
      flashRow('Primary slot', primary),
      swapping ? h('li', { key: 'swap', class: 'flash-swap', 'aria-hidden': 'true' }, icon('swap')) : null,
      flashRow('Secondary slot', secondary)
    ),
    h('p', { class: 'flash-note' }, note)
  );
}

const FLASH_NOW = 'Flash memory now';
const FLASH_ENDED = 'Flash memory when this update ended';
const FLASH_SEEN = 'Flash memory when last seen';

// A map of the moment an update ended, for a board whose version then is not on record.
const STAYED_IN_PLACE = { none: 'Previous firmware', state: 'Stayed in place', tone: 'run' };

/**
 * What each slot holds at this point of an update, told from the phase the board last
 * reported. Null where the phase does not say.
 *
 * `description` is what describeExecution() made of the same execution: a cancelled
 * update can end in several ways, and the map says the same as the words above it.
 *
 * A map headed "when this update ended" only ever names what the job recorded then, or
 * no version: what the board reports today is another moment, on a map headed that way.
 */
function slotsOfExecution(execution, known, target, description, deployment) {
  const { phase, ranAtEnd, reported, progress, startedAt, online } = execution;
  // What an offline board last said is not what its flash holds now.
  const flashNow = online ? FLASH_NOW : FLASH_SEEN;
  const latest = reported ?? known?.fw?.version ?? null;
  const previous = latest && latest !== target ? latest : null;
  const stays = {
    version: latest,
    none: 'Version not reported',
    state: online ? 'Runs from here, not touched' : 'Ran from here, not touched',
    tone: 'run',
  };
  const old = { version: previous, none: 'Previous firmware' };
  // A slot at work, or what it was at when a board that has gone offline was last heard of.
  const atWork = (state, was, iconName) => (online ? { state, tone: 'live', iconName } : { state: was, tone: 'idle' });
  const restarting = () =>
    flashMap(
      flashNow,
      { ...stays, ...atWork('Being replaced', 'Was being replaced', 'restart') },
      { version: target, ...atWork('Bootloader checks the signature', 'Was with the bootloader', 'shield') },
      { swapping: online }
    );
  const onTrial = () =>
    flashMap(
      flashNow,
      { version: target, ...atWork('Runs on trial', 'Was on trial', 'pulse') },
      { ...old, state: 'Kept to fall back on' }
    );
  const ranFromHere = {
    version: ranAtEnd,
    none: 'Previous firmware',
    state: 'Ran from here, not touched',
    tone: 'run',
  };

  switch (phase) {
    case 'waiting_for_device':
    case 'starting':
      return flashMap(flashNow, stays, { state: 'Nothing written yet' });
    case 'waiting_for_button':
      return flashMap(flashNow, stays, { state: 'Nothing is written until Button 1 is pressed' });
    case 'downloading':
      return flashMap(flashNow, stays, {
        version: target,
        ...atWork('Receiving the image', 'Was receiving the image', 'download'),
        receiving: online ? (progress ?? 0) : null,
      });
    case 'verifying':
      return flashMap(flashNow, stays, {
        version: target,
        ...atWork('Written, being checked', 'Was being checked', 'shield'),
      });
    case 'rebooting':
      return restarting();
    case 'testing':
      return onTrial();
    case 'succeeded':
      return flashMap(
        FLASH_ENDED,
        {
          version: ranAtEnd ?? target,
          state: 'Ran from here, confirmed',
          tone: 'good',
          iconName: 'check',
        },
        { none: 'Previous firmware', state: 'No longer needed' }
      );
    case 'rolled_back':
      return flashMap(
        FLASH_ENDED,
        { ...ranFromHere, state: 'Put back by the bootloader', tone: 'good', iconName: 'undo' },
        { version: target, state: 'Started but never confirmed', tone: 'bad', iconName: 'x-circle' }
      );
    case 'declined':
    case 'refused':
      return flashMap(FLASH_ENDED, ranFromHere, { state: 'Nothing written' });
    case 'failed':
      return flashMap(FLASH_ENDED, ranFromHere, {
        version: target,
        state: 'Not installed',
        tone: 'bad',
        iconName: 'x-circle',
      });
    case 'cancelled': {
      // No job holds what a cancelled board ran. Before it started, it ran what it had before.
      if (!startedAt) return flashMap(FLASH_ENDED, STAYED_IN_PLACE, { state: 'Nothing written' });
      // It had gone too far to be stopped: the new firmware is what the board reports.
      if (description.installed) {
        return flashMap(
          flashNow,
          {
            version: target,
            state: online ? 'Runs from here, confirmed' : 'Ran from here, confirmed',
            tone: 'good',
            iconName: 'check',
          },
          { none: 'Previous firmware', state: 'No longer needed' }
        );
      }
      const reached = known?.ota?.job === deployment ? known.ota.state : null;
      if (reached === 'rebooting') return restarting();
      if (reached === 'testing') return onTrial();
      // How it ended is not known, so there is no map of that: only the board's latest report.
      if (description.unsure) {
        return flashMap(
          flashNow,
          { ...stays, state: online ? 'What the board reports' : 'What the board last reported', iconName: null },
          { none: 'Not reported by the board', state: 'How this update ended is not known' },
          { note: 'A board that AWS has cancelled cannot report the end of that update.' }
        );
      }
      // It stopped there, or another deployment installed it later: when this one ended, the board had not.
      return flashMap(FLASH_ENDED, STAYED_IN_PLACE, { version: target, state: 'Not installed' });
    }
    default:
      return null;
  }
}

/** The same, told from what a board last reported about itself. */
function slotsOfDevice(device) {
  const { fw, ota, online } = device;
  // On a map of when an offline board was last seen, that is over.
  const onTrialWords = online ? 'Runs on trial' : 'Was on trial';
  const confirmedWords = online ? 'Runs from here, confirmed' : 'Ran from here, confirmed';
  const running = {
    version: fw?.version ?? null,
    none: 'Version not reported',
    state: fw?.confirmed ? confirmedWords : fw ? onTrialWords : 'Nothing reported',
    tone: fw?.confirmed ? 'good' : fw ? 'live' : 'idle',
    iconName: fw?.confirmed ? 'check' : fw ? 'pulse' : null,
  };
  const target = versionOfDeployment(ota?.job);
  // The page's title is a level above: a board's page has no other heading in between.
  const options = {
    heading: 'h2',
    note: ota ? WORKED_OUT : 'The board reports what it runs, and nothing about its other slot.',
  };
  const title = online ? FLASH_NOW : FLASH_SEEN;
  if (!ota || ota.state === 'idle') {
    return flashMap(title, running, { none: 'Not reported by the board', state: 'No update under way' }, options);
  }
  if (ota.state === 'awaiting_user') {
    return flashMap(
      title,
      running,
      {
        none: 'Not reported by the board',
        state: online ? 'Nothing is written until Button 1 is pressed' : describeUpdate(device).title,
      },
      options
    );
  }
  if (ota.state === 'testing') {
    return flashMap(
      title,
      { ...running, state: onTrialWords, tone: online ? 'live' : 'idle', iconName: 'pulse' },
      { none: 'Previous firmware', state: 'Kept to fall back on' },
      options
    );
  }
  // A phone may be writing here; nothing is installed without a press of Button 1 at the board.
  if (ota.state === 'bluetooth') {
    return flashMap(
      title,
      running,
      {
        none: 'Not reported by the board',
        state: online ? 'A phone may be sending an image over Bluetooth' : describeUpdate(device).title,
      },
      options
    );
  }
  // It went quiet in the middle of this, and may have moved on since: old news is told as old news.
  if (!online) return flashMap(title, running, { version: target, state: describeUpdate(device).title }, options);
  if (ota.state === 'downloading') {
    return flashMap(
      title,
      running,
      {
        version: target,
        state: 'Receiving the image',
        tone: 'live',
        iconName: 'download',
        receiving: ota.progress ?? 0,
      },
      options
    );
  }
  return flashMap(
    title,
    running,
    { version: target, state: 'Written, being checked', tone: 'live', iconName: 'shield' },
    { ...options, swapping: ota.state === 'rebooting' }
  );
}

// The step indicator for one board's update.

const STEP_STATES = {
  done: { icon: 'check', label: 'done' },
  current: { icon: null, label: 'in progress' },
  failed: { icon: null, label: 'stopped here' },
  // Where a board that was stopped, or went quiet, had got to. Nothing went wrong there.
  stopped: { icon: 'minus', label: 'stopped here' },
  skipped: { icon: null, label: 'not reached' },
  upcoming: { icon: null, label: 'not started' },
  // Nobody can tell from here: a board that AWS has cancelled no longer reports.
  unknown: { icon: 'minus', label: 'not known' },
};
const DOWNLOAD_STEP = 2;
// What each step is drawn with while it is not done: the same order as STEPS in core.js.
const STEP_ICONS = ['send', 'press', 'download', 'shield', 'restart', 'pulse', 'check-circle'];
// Whose turn it is decides what the current step is called.
const CURRENT_WORDS = { act: 'your turn', wait: 'waiting' };

/** Pressing the button is somebody's turn. For a viewer, who cannot deploy either, that is not said to be theirs. */
function currentWord(tone, viewer) {
  return viewer && tone === 'act' ? 'waiting for someone' : CURRENT_WORDS[tone];
}

/** The mark of a step that stopped: the way back for a rollback, otherwise what stopped it. */
function failedMark(description) {
  if (description.icon === 'undo' || description.icon === 'ban') return description.icon;
  return description.tone === 'warn' ? 'minus' : 'x';
}

function stepList(description, { compact = false, preview = false, viewer = false } = {}) {
  const at = description.steps.findIndex((step) => step.state === 'failed');
  const look = `is-${description.tone ?? 'idle'} ${compact ? 'is-compact' : ''} ${preview ? 'is-preview' : ''}`;
  // The mark of a step that failed takes the tone of the headline above it.
  return h(
    'ol',
    { class: `steps ${look}`.replace(/\s+/g, ' ').trim(), 'aria-label': 'Steps of the update' },
    description.steps.map((step, index) => {
      const state = STEP_STATES[step.state];
      const current = step.state === 'current';
      const failed = step.state === 'failed';
      const downloading = current && index === DOWNLOAD_STEP && description.progress !== null;
      let path = '';
      if (at > 0 && index <= at) {
        path = 'is-on-return';
        if (index === 0) path += ' is-return-start';
        if (index === at) path += ' is-return-end';
      }
      let mark = state.icon ?? STEP_ICONS[index];
      if (failed) mark = failedMark(description);
      return h(
        'li',
        {
          // By position: what a step is called changes with its state.
          key: String(index),
          class: `step is-${step.state} ${downloading ? 'has-progress' : ''} ${path}`.replace(/\s+/g, ' ').trim(),
          'aria-current': current ? 'step' : null,
          // The rail from this step to the next fills as the image comes in.
          vars: downloading ? { '--progress': `${description.progress}%` } : null,
        },
        h('span', { class: 'step-mark' }, icon(mark)),
        h('span', { class: 'step-label' }, step.label, downloading ? ` ${description.progress}%` : null),
        // A list of what every update goes through has no states to tell.
        preview ? null : h('span', { class: 'sr-only' }, ': '),
        preview
          ? null
          : h(
              'span',
              { class: 'step-state' },
              step.word ?? (current ? (currentWord(description.tone, viewer) ?? state.label) : state.label)
            )
      );
    })
  );
}

/**
 * The way back when an update stops: an arc over the steps, from where it stopped to
 * where it began, with what the board runs now. Nothing to draw if it stopped nowhere
 * in particular.
 */
function returnPath(execution, description) {
  const at = description.steps.findIndex((step) => step.state === 'failed');
  if (at < 1) return null;
  const { phase, ranAtEnd } = execution;
  // What the job recorded when it ended, which says nothing about the board today.
  let words = ['It stayed on the firmware it had', ranAtEnd ? [': ', mono(ranAtEnd)] : null];
  if (phase === 'rolled_back') {
    words = ['It went back to the previous firmware', ranAtEnd ? [': ', mono(ranAtEnd)] : null];
  } else if (phase === 'declined' || phase === 'refused') {
    words = ['Nothing was installed', ranAtEnd ? ['. It stayed on ', mono(ranAtEnd)] : null];
  }
  return h(
    'div',
    {
      class: `return-path is-${description.tone} ${at < 3 ? 'is-short' : ''}`.trim(),
      key: 'return',
      vars: { '--at': String(at) },
    },
    h('span', { class: 'return-arc', 'aria-hidden': 'true' }),
    h('p', { class: 'return-label' }, icon('undo'), h('span', null, words))
  );
}

// Sign-in and other moments when there is no console to show.

/** The frame of a page without the console: the brand, a message, and the dome beside it. */
function gateFrame(className, message) {
  return h(
    'div',
    { class: className },
    h(
      'div',
      { class: 'gate-copy' },
      h(
        'div',
        { class: 'gate-brand' },
        brandMark(),
        h(
          'span',
          { class: 'gate-brand-text' },
          h('span', { class: 'gate-brand-name' }, 'Cranium'),
          h('span', { class: 'gate-brand-sub' }, 'Firmware console')
        )
      ),
      message,
      h('p', { class: 'gate-foot' }, 'Upload signed firmware, offer it to boards, watch each one update.')
    ),
    h('div', { class: 'gate-art' }, domeArt())
  );
}

/** A single message in the middle of the page, with at most one thing to do. */
export function gateView({ iconName = 'lock', title, text, detail, code, action, waiting, leaving }) {
  const moving = waiting || leaving;
  return gateFrame(
    `gate ${moving ? 'is-moving' : ''}`.trim(),
    h(
      'div',
      { class: 'gate-message' },
      // The padlock is what every gate has by default; the mark above says as much.
      iconName === 'lock' ? null : h('span', { class: 'gate-icon' }, icon(iconName)),
      h('h1', { class: 'gate-title', id: 'page-title', tabindex: '-1' }, title),
      text ? h('p', { class: 'gate-text' }, text) : null,
      detail ? h('p', { class: 'gate-text' }, detail, code ? [' ', mono(code)] : null) : null,
      action ? button(`is-large ${action.quiet ? '' : 'is-primary'}`.trim(), action.run, action.label) : null
    )
  );
}

// The console's own sign-in page: the e-mail address and the password, then the code from
// the authenticator app in six boxes. app.js keeps the state and does the work; nothing
// here holds the password. Its field has no value from the state and no name, and the
// form never goes anywhere: the page's policy forbids sending a form (form-action 'none').

const SIGN_IN_LEAD = 'With your e-mail address, your password and the code from your authenticator app.';

/** What went wrong, said at once to a screen reader: a new element for every attempt. */
function signInProblemLine(model) {
  if (!model.problem) return null;
  return h(
    'p',
    { class: 'signin-problem', id: 'signin-problem', role: 'alert', key: `problem-${model.tries}` },
    icon('alert'),
    h('span', null, SIGN_IN_WORDS[model.problem] ?? SIGN_IN_WORDS.failed)
  );
}

function signInForm(model, key, onSubmit, ...body) {
  return h(
    'form',
    {
      class: 'signin-form',
      key,
      novalidate: true,
      'aria-busy': model.busy ? 'true' : null,
      onSubmit(event) {
        event.preventDefault();
        if (!model.busy) onSubmit();
      },
    },
    body
  );
}

/** The button that sends; while its request is on the way it keeps the focus and only says so. */
function signInButton(model, label) {
  return h(
    'button',
    {
      key: 'send',
      type: 'submit',
      class: 'btn is-large is-primary',
      'aria-disabled': model.busy ? 'true' : null,
    },
    model.busy ? 'Checking…' : label
  );
}

function passwordStep(model) {
  const wrong = model.problem === 'wrong-password' || model.problem === 'missing';
  return signInForm(
    model,
    'password',
    model.submitPassword,
    h(
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
    ),
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
    signInProblemLine(model),
    h(
      'div',
      { class: 'signin-actions', key: 'actions' },
      signInButton(model, 'Continue'),
      h('button', { type: 'button', class: 'btn is-quiet', onClick: model.forgotPassword }, 'Forgot your password?')
    )
  );
}

function codeStep(model) {
  const wrong = model.problem === 'wrong-code';
  return signInForm(
    model,
    'code',
    model.submitCode,
    h(
      'div',
      { class: 'field', key: 'code' },
      h('span', { class: 'field-label', id: 'code-label' }, 'Code from your authenticator app'),
      h(
        'div',
        {
          class: `code-boxes ${wrong ? 'is-wrong' : ''}`.trim(),
          role: 'group',
          'aria-labelledby': 'code-label',
          'aria-describedby': model.problem ? 'signin-problem code-hint' : 'code-hint',
        },
        model.digits.map((digit, index) =>
          h('input', {
            key: `digit-${index}`,
            id: `code-digit-${index + 1}`,
            class: 'code-digit',
            type: 'text',
            inputmode: 'numeric',
            pattern: '[0-9]*',
            // The first box is where a browser or a phone fills in the whole code.
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
      h(
        'span',
        { class: 'field-hint', id: 'code-hint' },
        'The six digits it shows now. The code goes in by itself once the last digit is typed.'
      )
    ),
    signInProblemLine(model),
    h(
      'div',
      { class: 'signin-actions', key: 'actions' },
      signInButton(model, 'Sign in'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn is-quiet',
          'aria-disabled': model.busy ? 'true' : null,
          onClick: model.startOver,
        },
        'Start again'
      )
    )
  );
}

/**
 * The console's own sign-in page.
 *
 * @param {object} model  step ('password' or 'code'), email, digits, busy, problem (a key
 *                        of SIGN_IN_WORDS), tries, lead, and what each control does
 */
export function signInView(model) {
  const code = model.step === 'code';
  return gateFrame(
    'gate is-signin',
    h(
      'div',
      { class: 'gate-message signin', key: code ? 'code' : 'password' },
      h('h1', { class: 'gate-title', id: 'page-title', tabindex: '-1' }, code ? 'Enter the code' : 'Sign in'),
      code
        ? h('p', { class: 'gate-text' }, 'Signing in as ', h('strong', { class: 'signin-who' }, model.email), '.')
        : h('p', { class: 'gate-text' }, model.lead ?? SIGN_IN_LEAD),
      code ? codeStep(model) : passwordStep(model),
      h(
        'div',
        { class: 'signin-other', key: 'other' },
        h(
          'button',
          { type: 'button', class: 'btn is-quiet', onClick: model.useAwsPage },
          'Use the AWS sign-in page',
          icon('arrow-right')
        ),
        h('p', { class: 'signin-note' }, 'The same account and the same code, on Amazon’s page.')
      )
    )
  );
}

// The masthead: sections and who is signed in.

// [view, label, icon, primary]: a primary section is a tab of its own on a phone; the rest are under More.
const SECTIONS = [
  ['overview', 'Overview', 'home', true],
  ['devices', 'Devices', 'chip', true],
  ['map', 'Map', 'pin', true],
  ['diagnostics', 'Diagnostics', 'chart', false],
  ['events', 'Events', 'list', false],
  ['firmware', 'Firmware', 'package', false],
  ['deployments', 'Deployments', 'send', true],
  // An update over Bluetooth: in the phone app, for release managers (bluetooth.js).
  ['bluetooth', 'Bluetooth', 'bluetooth', false],
  // Board types, groups, staged rollouts and "Update everything" (fleet.js).
  ['fleet', 'Fleet', 'layers', false],
  // What Memfault knows of the boards: issues, traces and backtraces (memfault-page.js).
  ['memfault', 'Memfault', 'alert', false],
  // The alert rules and the alerts that went out (account.js).
  ['alerts', 'Alerts', 'bell', false],
  ['activity', 'Activity', 'clock', false],
  // The phone apps: where to get them, and how to put them on a phone (apps.js).
  ['apps', 'Apps', 'phone', false],
  // The customer site's customers: for release managers only (cloud/api/src/handlers/customers.mjs).
  ['customers', 'Customers', 'users', false],
  ['developer', 'Developer', 'code', false],
];
const SECTION_OF = {
  device: 'devices',
  deployment: 'deployments',
  serial: 'developer',
  setup: 'developer',
  history: 'developer',
  tokens: 'developer',
  database: 'developer',
  rollout: 'fleet',
  issue: 'memfault',
};

/** Where Developer leads: a viewer has no use for the serial console's controls. */
function sectionHref(view, ctx) {
  if (view !== 'developer') return `#/${view}`;
  return ctx.state.me?.canWrite === false || serialPagesHidden() ? '#/history' : '#/serial';
}

// The pages that need a board's USB serial port.
export const SERIAL_PAGES = Object.freeze(['serial', 'setup']);

/**
 * Whether the Serial console and Board setup are left out: in a phone app with no serial port, which is
 * the iPhone app (iOS gives apps no way to a USB serial device) and an Android app without the bridge's
 * usb.* (app.js makes that navigator.serial). On a website the pages stay, and say what a browser lacks.
 */
export function serialPagesHidden(win = globalThis) {
  const inApp = Boolean(win?.webkit?.messageHandlers?.cranium || win?.craniumNative);
  return inApp && !win?.navigator?.serial;
}

/**
 * The sections: a sidebar on a wide screen, a tab bar at the foot of a phone's screen. On a phone
 * the primary sections are tabs and the rest are in the sheet that More opens (state.moreOpen,
 * app.js); the sheet's links are drawn only while it is open, so that there is one link per section.
 */
export function navView(ctx) {
  const current = SECTION_OF[ctx.state.route.view] ?? ctx.state.route.view;
  const shown = SECTIONS.filter(([view]) => {
    if (view === 'customers') return ctx.state.me?.canWrite === true;
    if (view === 'bluetooth') return ctx.state.app?.ble === true && ctx.state.me?.canWrite === true;
    return true;
  });
  const open = ctx.state.moreOpen === true;
  const inMore = shown.some(([view, , , primary]) => !primary && view === current);
  return h(
    'div',
    { class: 'nav-body' },
    h(
      'ul',
      { class: 'nav-list', key: 'list' },
      shown.map(([view, label, iconName, primary]) =>
        h(
          'li',
          { key: view, class: primary ? 'nav-item' : 'nav-item is-secondary' },
          h(
            'a',
            {
              class: 'nav-link',
              href: sectionHref(view, ctx),
              // Keeps the room the name takes in bold, so that the sections stay where they are.
              'data-label': label,
              'aria-current': view === current ? 'page' : null,
            },
            icon(iconName, 'nav-icon'),
            h('span', { class: 'nav-label' }, label)
          )
        )
      ),
      h(
        'li',
        { key: 'more', class: 'nav-item is-more' },
        h(
          'button',
          {
            type: 'button',
            class: `nav-link nav-more-toggle ${inMore || open ? 'is-current' : ''}`.trim(),
            'aria-expanded': open ? 'true' : 'false',
            'aria-controls': 'nav-sheet',
            onClick: () => ctx.actions?.toggleMore?.(),
          },
          icon('more', 'nav-icon'),
          h('span', { class: 'nav-label' }, 'More')
        )
      )
    ),
    h(
      'div',
      { class: 'nav-sheet', id: 'nav-sheet', key: 'sheet', hidden: !open },
      h('button', {
        type: 'button',
        class: 'nav-sheet-backdrop',
        tabindex: '-1',
        'aria-label': 'Close',
        onClick: () => ctx.actions?.closeMore?.(),
      }),
      open
        ? h(
            'div',
            { class: 'nav-sheet-panel', role: 'group', 'aria-label': 'More' },
            h('span', { class: 'nav-sheet-grip', 'aria-hidden': 'true' }),
            h(
              'ul',
              { class: 'nav-sheet-list' },
              shown
                .filter(([, , , primary]) => !primary)
                .map(([view, label, iconName]) =>
                  h(
                    'li',
                    { key: view },
                    h(
                      'a',
                      {
                        class: 'nav-sheet-link',
                        href: sectionHref(view, ctx),
                        'aria-current': view === current ? 'page' : null,
                      },
                      h('span', { class: 'nav-sheet-icon' }, icon(iconName)),
                      h('span', { class: 'nav-sheet-label' }, label),
                      icon('chevron-right', 'nav-sheet-chevron')
                    )
                  )
                ),
              h(
                'li',
                { key: 'account' },
                h(
                  'a',
                  {
                    class: 'nav-sheet-link',
                    href: '#/account',
                    'aria-current': current === 'account' ? 'page' : null,
                  },
                  h('span', { class: 'nav-sheet-icon' }, icon('user')),
                  h(
                    'span',
                    { class: 'nav-sheet-label' },
                    'Account',
                    ctx.state.me?.email ? h('span', { class: 'nav-sheet-detail' }, ctx.state.me.email) : null
                  ),
                  icon('chevron-right', 'nav-sheet-chevron')
                )
              )
            )
          )
        : null
    )
  );
}

// The pages of the Developer section. Two have a script each (serial.js, history.js);
// API tokens is drawn here, because it talks to the API like the other pages. Events and
// Diagnostics have one too (telemetry.js), which draws with these same pieces.

export {
  NO_BOARDS,
  badge,
  boardLabel,
  boardThing,
  button,
  card,
  empty,
  factNote,
  facts,
  failure,
  freshness,
  linkTo,
  loadProblem,
  loading,
  meter,
  mono,
  notice,
  pageHead,
  pending,
  presence,
  signalBars,
  statusLine,
  when,
  whenAt,
};
// And for the fleet's pages and dialogs (fleet.js), which draw with the same pieces.
export { SPACER, choice, consequences, dialogButton, dialogFrame, problemRef, segments, stats, who };

/**
 * The foot of every page: the console's own version and the commit it was built from (GET /api/me, from
 * cloud/VERSION; docs/versions.md), and where to read what is new in it and to find the phone apps.
 */
export function footView(ctx) {
  const own = ctx.state.me?.console ?? { version: null, commit: null };
  return h(
    'div',
    { class: 'foot-inner' },
    h(
      'p',
      { class: 'foot-version' },
      own.version ? ['Console ', h('span', { class: 'mono' }, own.version)] : 'Console version not known',
      own.commit
        ? h(
            'span',
            { class: 'foot-commit quiet', title: `Built from commit ${own.commit}` },
            ` · ${own.commit.slice(0, 7)}`
          )
        : null
    ),
    // In the phone app: which app, and where its pages came from.
    ctx.state.app?.words ? h('p', { class: 'foot-version quiet' }, ctx.state.app.words) : null,
    h(
      'p',
      { class: 'foot-links' },
      h('a', { href: '#/history' }, 'What\u2019s new'),
      h('a', { href: '#/apps' }, 'Phone apps')
    )
  );
}
// For the customer site (customer/assets/customer-views.js), which draws with the same pieces.
export { domeArt };

export function developerTabs(current) {
  return h(
    'nav',
    { class: 'dev-tabs', key: 'tabs', 'aria-label': 'Developer pages' },
    h('span', { class: 'eyebrow' }, 'Developer'),
    [
      ['serial', 'Serial console'],
      ['setup', 'Board setup'],
      ['history', 'History'],
      ['tokens', 'API tokens'],
      // The console's DynamoDB tables, read only, for release managers (db-page.js).
      ['database', 'Database'],
    ]
      .filter(([view]) => !(SERIAL_PAGES.includes(view) && serialPagesHidden()))
      .map(([view, label]) =>
        h(
          'a',
          {
            key: view,
            class: 'nav-link',
            href: `#/${view}`,
            'data-label': label,
            'aria-current': view === current ? 'page' : null,
          },
          label
        )
      )
  );
}

/** Such a page while its script is on the way, or when it could not be fetched. */
export function scriptPending(ctx, view, title, { tabs = true } = {}) {
  return h(
    'div',
    { class: 'page', key: 'page' },
    tabs ? developerTabs(view) : null,
    pageHead({ title }),
    ctx.state.scriptFailed
      ? notice(
          'bad',
          'alert',
          'This page could not be loaded. The console may have been updated since ' +
            'this tab was opened: reload to get the new version.',
          {
            action: button('is-small', () => location.reload(), 'Reload'),
          }
        )
      : loading('the page')
  );
}

export function accountView(ctx) {
  const { me, sessionLeft } = ctx.state;
  const left = Math.max(0, sessionLeft);
  const ends = new Date(Date.now() + left * 1000);
  let session =
    left > 0
      ? {
          title: `You will be asked to sign in again at ${ends.toLocaleTimeString()}.`,
          text: `Session ends in ${duration(left)}`,
        }
      : { title: 'Sign in again to go on.', text: 'Session ended' };
  // In the phone app the app keeps the sign-in and renews it (bridge.js).
  if (ctx.state.app) session = { title: 'The app keeps this sign-in and renews it.', text: 'Signed in on this phone' };
  const role = me.canWrite ? 'Release manager' : 'Viewer';
  // The account id is what the activity log files this person's actions under.
  const identity = [me.email, me.sub ? `Account ${me.sub}` : ''].filter(Boolean).join(' · ');
  return h(
    'div',
    { class: 'account-box' },
    h(
      'div',
      { class: 'account-who' },
      // The address leads to the Account page: who is signed in, and their e-mail alerts (account.js).
      h(
        'a',
        { class: 'account-link', href: '#/account' },
        h('span', { class: 'account-email', title: identity || null }, me.email || 'Signed in')
      ),
      h(
        'span',
        { class: 'account-meta' },
        h('span', { class: 'account-role' }, icon(me.canWrite ? 'key' : 'user', 'is-small'), role),
        h('span', { class: 'account-session', title: session.title }, session.text)
      )
    ),
    // As admin mode of the customer site (docs/customer-site.md): the way back to it, still signed in.
    ctx.state.customerSite
      ? h('a', { class: 'btn is-small is-quiet', href: ctx.state.customerSite }, icon('arrow-left'), 'Leave admin mode')
      : null,
    // The phone app's own settings: its versions, an update of its pages, the classic app.
    ctx.state.app?.settings ? button('is-small is-quiet', ctx.actions.appSettings, icon('more'), 'App') : null,
    button('is-small', ctx.actions.signOut, icon('sign-out'), 'Sign out')
  );
}

// Overview.

const SCRIPTED_TAG = 'Script, no sign-in';
const SCRIPTED_NOTE =
  'Sent by a script (the test bench, or scripts/firmware/ota.sh without an API token) with AWS credentials, directly to the API ' +
  'function. Nobody signed in. The name is the one the script gave, which has to be an active release manager, ' +
  'so the entry does not show that this person did it.';

/** What the tag on such a line means, said once, in words a touch screen can reach. */
function scriptedKey(entries, className) {
  if (!entries.some((entry) => describeAudit(entry).scripted)) return null;
  return h(
    'p',
    { class: `log-key ${className}`.trim(), key: 'scripted' },
    h('span', { class: 'tag is-warn' }, SCRIPTED_TAG),
    ` ${SCRIPTED_NOTE}`
  );
}

/** The boards of a list, each by its own name and linked to its page, as "A, B and C". */
function boardsInWords(things, devices) {
  return things.flatMap((thing, index) => [
    index === 0 ? null : index === things.length - 1 ? ' and ' : ', ',
    boardLabel(boardOf(thing, devices), 'log-target'),
  ]);
}

/** What the entry is about, as a link: a board by the name it gave at its serial console is found in the list. */
function auditTarget(description, devices) {
  if (!description.label) return null;
  if (description.byName) {
    const board = (devices ?? []).find((device) => device.name === description.label);
    if (board) return boardLabel(board, 'log-target');
  }
  if (description.thing) return boardLabel(boardOf(description.thing, devices ?? []), 'log-target');
  return linkTo(description.href, { class: 'mono log-target' }, description.label);
}

/** One entry of the activity log. The short form is for the overview. */
function activityLine(entry, ctx, compact) {
  const description = describeAudit(entry);
  const devices = ctx.state.devices?.value?.devices;
  // The line says that the deployment was started. How it ended is not in the log, and
  // follows from the deployment as it is now, once it is over.
  const run =
    entry.action === 'deployment.create' && entry.outcome === 'ok'
      ? ((ctx.state.deployments.value ?? []).find((deployment) => deployment.id === entry.target) ?? null)
      : null;
  // Where it went: as the entry names the boards, or, for an entry from before it did, as the deployment does.
  const { boardCount } = description;
  const boards =
    description.boards.length > 0 || !run ? description.boards : run.things.filter((thing) => isThing(thing));
  let where = null;
  if (boards.length > 0 && boards.length <= 2) where = [' to ', boardsInWords(boards, devices)];
  else if (Math.max(boardCount, boards.length) > 0)
    where = ` to ${plural(Math.max(boardCount, boards.length), 'board')}`;
  const { actor } = entry;
  const name = actorOf(entry);
  const account = actor?.sub ? `Account ${actor.sub}` : null;
  const outcome = description.outcome
    ? [' ', badge(description.outcome.tone, description.outcome.icon, description.outcome.label)]
    : null;
  const ending = run && !isUnderWay(run) ? describeDeployment(run) : null;
  return h(
    'li',
    { key: `${entry.at}-${entry.requestId}`, class: 'log-line' },
    h(
      'span',
      { class: `log-icon ${description.outcome ? `is-${description.outcome.tone}` : ''}`.trim() },
      icon(description.icon)
    ),
    h(
      'div',
      { class: 'log-body' },
      h(
        'p',
        { class: 'log-what' },
        // The whole address, in the short form too: its owner can change it, and the part
        // before the @ alone could be anybody's. The tooltip adds the account.
        h(
          'span',
          {
            class: 'log-actor',
            title: compact ? [actor?.email, account].filter(Boolean).join(' · ') || null : account,
          },
          name
        ),
        ` ${description.verb} `,
        auditTarget(description, devices),
        description.tail ? ` ${description.tail}` : null,
        where,
        outcome,
        ending ? [' ', badge(ending.tone, ending.icon, ending.label)] : null,
        description.scripted ? [' ', h('span', { class: 'tag is-warn' }, SCRIPTED_TAG)] : null
      ),
      compact
        ? null
        : h(
            'p',
            { class: 'log-detail dotted' },
            description.facts.map((fact) => auditFact(fact, ctx)),
            // Two accounts can show the same address, or one that looks the same. The id tells them apart.
            actor?.sub
              ? h(
                  'span',
                  { key: 'account', class: 'log-ref', title: account },
                  'Account ',
                  mono(shortAccount(actor.sub))
                )
              : null,
            // A sign-in was asked for by no request: its id is made of the sign-in itself.
            entry.requestId && entry.action !== 'account.sign_in'
              ? h('span', { key: 'request', class: 'log-ref' }, 'Request ', mono(entry.requestId))
              : null
          ),
      compact ? null : auditChanges(entry, ctx)
    ),
    // The full log files its lines under the day, so a line says when in that day.
    h('span', { class: 'log-when' }, compact ? when(entry.at, ctx.state.now) : whenInDay(entry.at))
  );
}

/**
 * One side of a change: "was" or "now", in words as well as in colour, then the value. The old value is
 * struck through, the new one marked inserted; none, and a value that is never shown, say so.
 */
function changeSide(kind, value, row, devices) {
  let shown;
  if (value === null) shown = h('em', { class: 'audit-diff-empty' }, 'none');
  else if (row.hidden)
    shown = h('span', { class: 'tag audit-diff-hidden', title: 'Never recorded or shown' }, 'hidden');
  else {
    const things = row.field === 'boards' ? value.split(' ') : [];
    const words = things.length > 0 && things.every((thing) => isThing(thing)) ? boardsInWords(things, devices) : value;
    shown = h(kind === 'was' ? 'del' : 'ins', { class: 'audit-diff-value' }, words);
  }
  return h(
    'span',
    { class: `audit-diff-side is-${kind}` },
    h('span', { class: 'audit-diff-tag' }, kind === 'was' ? 'was' : 'now'),
    ' ',
    shown
  );
}

/**
 * What an entry changed, before and after, behind a disclosure: a grouped list of fields, each with what
 * it was and what it is now. An entry from before changes were recorded says that none were.
 */
function auditChanges(entry, ctx) {
  const diff = describeChanges(entry);
  if (diff === null) return null;
  const devices = ctx.state.devices?.value?.devices;
  const summary = diff.none ? 'What changed' : `What changed: ${plural(diff.rows.length + diff.omitted, 'field')}`;
  return h(
    'details',
    { class: 'more audit-diff', key: 'changes' },
    h('summary', null, summary, h('span', { class: 'sr-only' }, ` in the entry of ${whenInDay(entry.at)}`)),
    diff.none
      ? h('p', { class: 'audit-diff-none' }, 'No details recorded for this entry.')
      : h(
          'dl',
          { class: 'audit-changes' },
          diff.rows.map((row, index) =>
            h(
              'div',
              { class: 'audit-change', key: `${row.field}-${index}` },
              h('dt', null, row.label),
              h('dd', null, changeSide('was', row.from, row, devices), ' ', changeSide('now', row.to, row, devices))
            )
          )
        ),
    diff.omitted > 0
      ? h('p', { class: 'audit-diff-none' }, `${plural(diff.omitted, 'more change')} left out: an entry keeps a few.`)
      : null
  );
}

/** One fact of a log entry. A digest is shortened: the button next to it copies all of it. */
function auditFact(fact, ctx) {
  if (fact.key === 'sha256') {
    return h(
      'span',
      { key: 'fact-sha256', class: 'digest-row' },
      `${fact.label} `,
      mono(`${fact.value.slice(0, 12)}…`),
      copyButton(fact.value, `the SHA-256 of ${fact.value.slice(0, 12)}…`, ctx)
    );
  }
  if (fact.words) {
    return h('span', { key: `fact-${fact.key}`, title: `Code ${fact.value}` }, `${fact.words}.`);
  }
  // The log keeps a board's thing name; the board is called by its own name, as listed now.
  if (fact.key === 'thing') {
    const board = boardOf(fact.value, ctx.state.devices?.value?.devices);
    return h('span', { key: 'fact-thing' }, `${fact.label} `, boardLabel(board), boardThing(board));
  }
  if (fact.key === 'boards') {
    const things = fact.value.split(' ').filter((thing) => isThing(thing));
    return h(
      'span',
      { key: 'fact-boards' },
      `${fact.label} `,
      boardsInWords(things, ctx.state.devices?.value?.devices)
    );
  }
  return h(
    'span',
    { key: `fact-${fact.key}` },
    fact.phrase ? `${fact.label} ` : `${fact.label}: `,
    fact.code ? mono(fact.value) : fact.value
  );
}

/** The two buttons on the board, while it waits for a person. The words beside it say the same. */
function buttonKeys() {
  return h(
    'div',
    { class: 'keys', 'aria-hidden': 'true' },
    h(
      'span',
      { class: 'key is-lit' },
      h('span', { class: 'key-cap' }),
      h('span', { class: 'key-words' }, h('strong', null, 'Button 1'), 'installs')
    ),
    h(
      'span',
      { class: 'key' },
      h('span', { class: 'key-cap' }),
      h('span', { class: 'key-words' }, h('strong', null, 'Button 2'), 'declines')
    )
  );
}

/** One board of a deployment that is under way, as a line on the overview. */
function boardLine(execution, deployment, ctx, known) {
  const { now } = ctx.state;
  const description = describeExecution(execution, {
    board: known ?? null,
    deployment: deployment.id,
    version: deployment.version,
    unread: ctx.state.devices.value === null,
  });
  const lastSeen = known?.lastSeen ?? null;
  const offline = !execution.online;
  const board = known ?? boardOf(execution.thing);
  return h(
    'li',
    { key: execution.thing, class: `board-run is-${description.tone}` },
    h(
      'div',
      { class: 'board-run-head' },
      h(
        'div',
        { class: 'board-run-who' },
        boardLabel(board, 'board-run-name'),
        h(
          'div',
          { class: 'board-run-state' },
          description.progress !== null
            ? h(
                'span',
                { class: `status is-${description.tone}` },
                icon(description.icon),
                h(
                  'span',
                  null,
                  description.said ?? description.title,
                  h('span', { class: 'said-big' }, ` ${description.progress}%`)
                )
              )
            : statusLine(description),
          description.progress !== null
            ? meter(description.progress, `Download on ${boardName(board)}`)
            : h(
                'span',
                { class: 'board-run-note' },
                prose(description.brief),
                offline && lastSeen ? [' Last seen ', when(lastSeen, now), '.'] : null
              )
        )
      ),
      description.progress !== null
        ? h(
            'p',
            { class: 'board-run-figure', 'aria-hidden': 'true' },
            String(description.progress),
            h('span', { class: 'execution-percent' }, '%')
          )
        : null,
      description.tone === 'act' ? buttonKeys() : null
    ),
    stepList(description, { compact: true, viewer: !ctx.state.me.canWrite })
  );
}

function startedBy(deployment, now, stamp = when) {
  return [
    'Started ',
    stamp(deployment.createdAt, now),
    deployment.createdBy ? [' by ', who(deployment.createdBy)] : null,
  ];
}

const NOT_REGISTERED = 'Not a registered release';

/** The list of releases, or null while it has not been read. */
function releaseList(ctx) {
  return ctx.state.firmware.value?.releases ?? null;
}

/** The boards that report a version that is not in the list of releases. */
function offList(devices, ctx) {
  return (devices ?? []).filter((device) => isUnregistered(device.fw?.version, releaseList(ctx)));
}

/** The oldest of what these boards last said. */
function oldestSeen(boards) {
  return boards.reduce((oldest, device) =>
    Date.parse(device.lastSeen) < Date.parse(oldest.lastSeen) ? device : oldest
  );
}

/**
 * That what is said of these boards is what they last said, and when, for those that are
 * offline. They are the boards the sentence above this one is about, which may not be all
 * there are. `alone` says that "the board" can only be taken for the one that is meant.
 */
function offlineWords(boards, now, alone = boards.length === 1) {
  const quiet = boards.filter((device) => !device.online && device.lastSeen);
  if (quiet.length === 0) return null;
  const seen = when(oldestSeen(quiet).lastSeen, now);
  if (alone) return ['As last reported: the board is offline, last seen ', seen, '.'];
  if (boards.length === 1) return ['As last reported: that board is offline, last seen ', seen, '.'];
  return quiet.length === 1
    ? ['As last reported: 1 of them is offline, last seen ', seen, '.']
    : [`As last reported: ${quiet.length} of them are offline, the oldest report `, seen, '.'];
}

/** The same in a few words, under a figure that counts boards by what they run. */
function asReported(devices, now) {
  const quiet = devices.filter((device) => device.fw && !device.online && device.lastSeen);
  if (quiet.length === 0) return null;
  const seen = when(oldestSeen(quiet).lastSeen, now);
  return h(
    'p',
    { class: 'card-note fleet-note', key: 'reported' },
    quiet.length === 1 ? 'As last reported ' : 'As last reported, the oldest ',
    seen,
    '.'
  );
}

/** The versions of the releases that are revoked, as far as they are known here. */
function revokedVersions(ctx) {
  const releases = ctx.state.firmware.value?.releases ?? [];
  return new Set(releases.filter((release) => release.status !== 'active').map((release) => release.version));
}

/**
 * The first steps with a new console, ticked off as they are done. A step that is done
 * keeps its title only, and the first one that is not is marked as the next thing to do.
 */
function gettingStarted(ctx, have) {
  const { canWrite } = ctx.state.me;
  const done = [have.boards, have.releases, have.deployments];
  const next = done.indexOf(false);
  const step = (index, title, ...text) => {
    const state = done[index] ? 'is-done' : index === next ? 'is-next' : '';
    return h(
      'li',
      {
        key: title,
        class: `guide-step ${state}`.trim(),
        'aria-current': index === next ? 'step' : null,
      },
      h('span', { class: 'guide-mark' }, done[index] ? icon('check') : null),
      h(
        'div',
        null,
        h('p', { class: 'guide-title' }, title, done[index] ? h('span', { class: 'sr-only' }, ' (done)') : null),
        done[index] ? null : h('p', { class: 'guide-text' }, text)
      )
    );
  };
  const list = h(
    'ol',
    { class: 'guide-steps' },
    step(
      0,
      'Register a board',
      'Each board gets its own certificate and name. With the board connected over USB, run ',
      h('code', { class: 'code' }, 'python3 tools/provision_device.py')
    ),
    canWrite
      ? step(
          1,
          'Upload a signed image',
          'Drop ',
          mono('binaries/latest.signed.bin'),
          ' on the ',
          h('a', { href: '#/firmware' }, 'Firmware'),
          ' page. The server checks its signature before it is stored.'
        )
      : step(
          1,
          'Upload a signed image',
          'A release manager uploads a signed build. ',
          'The server checks its signature before it is stored.'
        ),
    canWrite
      ? step(
          2,
          'Deploy it',
          'Start a deployment on the ',
          h('a', { href: '#/deployments' }, 'Deployments'),
          ` page. A board on firmware ${FIRST_WITH_NO_BUTTON} or newer installs it by itself; older firmware ` +
            'waits for someone to press Button 1 on the board.'
        )
      : step(
          2,
          'Deploy it',
          `A release manager deploys the release to boards. A board on firmware ${FIRST_WITH_NO_BUTTON} or newer ` +
            'installs it by itself; older firmware waits for someone to press Button 1 on the board.'
        )
  );
  return card({ key: 'guide', title: 'Getting started', className: 'guide' }, list);
}

/** What every update goes through, for a console that has not seen one yet. */
function updateJourney() {
  const preview = { progress: null, steps: STEPS.map((step) => ({ label: step.name, state: 'upcoming' })) };
  return h(
    'section',
    { class: 'journey', key: 'journey', 'aria-label': 'The steps of an update' },
    h(
      'div',
      { class: 'journey-head' },
      h('p', { class: 'journey-title' }, 'What every update goes through'),
      h(
        'p',
        { class: 'journey-text' },
        'Nothing installs until a release manager deploys it. The board then checks what it received, and ',
        'the bootloader goes back to the previous firmware if the new one cannot reconnect.'
      )
    ),
    stepList(preview, { preview: true })
  );
}

/** On line and not restarting: a board that said it is restarting is off for the moment. */
function isUp(device) {
  return device.online && !isRestarting(device);
}

/** The boards without Wi-Fi, as the fleet says (fleet.js): they are never online, and that is no fault. */
function phoneOnly(ctx) {
  return new Set(
    (ctx.state.fleet?.value?.boards ?? []).filter((board) => board.bluetoothOnly).map((board) => board.thing)
  );
}

/** Boards in the words the tiles draw them in. A board without Wi-Fi is counted apart. */
function boardsCounted(devices, phone = new Set()) {
  const online = devices.filter(isUp).length;
  const bluetooth = devices.filter((device) => !isUp(device) && phone.has(device.thing)).length;
  const quiet = devices.filter((device) => !isUp(device) && !phone.has(device.thing) && device.lastSeen).length;
  const never = devices.length - online - quiet - bluetooth;
  return { online, quiet, never, bluetooth };
}

/** The words next to the tiles, for a fleet of more than one board: one board is said by the figure. */
function tileWords(devices, extra = [], phone = new Set()) {
  const { online, quiet, never, bluetooth } = boardsCounted(devices, phone);
  return h(
    'p',
    { class: 'tile-words dotted', key: 'words' },
    online ? h('span', { key: 'online' }, `${online} online`) : null,
    quiet ? h('span', { key: 'quiet' }, `${quiet} offline`) : null,
    never ? h('span', { key: 'never' }, `${never} never connected`) : null,
    bluetooth ? h('span', { key: 'bluetooth' }, `${bluetooth} Bluetooth only`) : null,
    extra.filter(([, count]) => count > 0).map(([word, count]) => h('span', { key: word }, `${count} ${word}`))
  );
}

function fleetFigure(devices, phone = new Set()) {
  const { online, bluetooth } = boardsCounted(devices, phone);
  return [
    h(
      'p',
      { class: 'figure', key: 'figure' },
      h('span', { class: 'figure-value' }, String(online)),
      // Of the boards that can be online at all: one without Wi-Fi never is.
      h('span', { class: 'figure-unit' }, ` of ${plural(devices.length - bluetooth, 'board')} online`)
    ),
    devices.length > 1 ? boardTiles(devices, phone) : null,
  ];
}

/** How many boards are online, in the panel at the top of the overview. */
function onlineCard(ctx, devices) {
  let body;
  if (devices === null) {
    body = pending(ctx.state.devices, 'boards');
  } else if (devices.length === 0) {
    body = h('p', { class: 'quiet' }, 'No boards are registered yet.');
  } else {
    body = [fleetFigure(devices, phoneOnly(ctx)), devices.length > 1 ? tileWords(devices, [], phoneOnly(ctx)) : null];
  }
  return card({ key: 'online', title: 'Fleet', className: 'is-zone' }, body);
}

// More than this, and the card sends the reader to the page that has them all.
const BOARDS_SHOWN = 6;

function boardsCard(ctx, devices) {
  const { state } = ctx;
  let body;
  if (devices === null) {
    body = pending(state.devices, 'boards');
  } else if (devices.length === 0) {
    body = h('p', { class: 'quiet' }, 'Boards appear here once they are registered.');
  } else {
    const head = h(
      'li',
      { key: 'head', class: 'board-head', 'aria-hidden': 'true' },
      h('span', null, 'Board'),
      h('span', null, 'Firmware'),
      h('span', null, 'Signal'),
      h('span', null, 'Update')
    );
    body = [
      h(
        'ul',
        { class: 'board-list', key: 'list' },
        head,
        devices.slice(0, BOARDS_SHOWN).map((device) => {
          const reported = describeUpdate(device);
          // The panel above and this row say one percentage: the board list is read less often.
          const own = state.deploymentDetails
            .get(device.ota?.job)
            ?.value?.executions.find((execution) => execution.thing === device.thing);
          const progress =
            reported.progress !== null && own?.phase === 'downloading' && own.progress !== null
              ? own.progress
              : reported.progress;
          // A row among rows: the panel above is what asks somebody to press a button.
          const update =
            reported.tone === 'act'
              ? { ...reported, tone: 'wait', title: 'Waiting for its button' }
              : { ...reported, progress };
          const seen = heartbeatWords(device, state.now) ?? 'Never connected';
          return h(
            'li',
            { key: device.thing, class: 'board-line' },
            h('span', { class: `presence-dot ${isUp(device) ? 'is-on' : ''}`.trim() }),
            h(
              'span',
              { class: 'board-line-who' },
              boardLabel(device, 'board-line-name'),
              h('span', { class: 'board-line-note' }, seen)
            ),
            h(
              'span',
              { class: 'board-line-fw' },
              device.fw
                ? [
                    mono(device.fw.version),
                    device.fw.confirmed
                      ? h(
                          'span',
                          { class: 'board-line-mark', title: 'Confirmed' },
                          icon('check', 'is-small'),
                          h('span', { class: 'sr-only' }, ' confirmed')
                        )
                      : h('span', { class: 'tag is-warn' }, 'On trial'),
                    isUnregistered(device.fw.version, releaseList(ctx))
                      ? h('span', { class: 'tag is-warn' }, NOT_REGISTERED)
                      : null,
                  ]
                : h('span', { class: 'quiet' }, 'Not reported')
            ),
            h(
              'span',
              { class: 'board-line-signal' },
              signalWords(device, (quality) => [signalBars(quality), quality.label])
            ),
            h(
              'span',
              { class: 'board-line-update' },
              statusLine(
                update,
                update.progress !== null ? h('span', { class: 'status-value' }, `${update.progress}%`) : null
              )
            )
          );
        })
      ),
      devices.length > BOARDS_SHOWN
        ? h(
            'p',
            { class: 'card-note board-more', key: 'more' },
            h('a', { href: '#/devices' }, `and ${plural(devices.length - BOARDS_SHOWN, 'more board')}`)
          )
        : null,
    ];
  }
  return card(
    {
      key: 'boards',
      title: 'Boards',
      className: 'overview-boards',
      more: { href: '#/devices', label: 'All devices' },
    },
    body
  );
}

/** The boards by the version they report: newest first, boards that have not said last. */
function versionGroups(devices) {
  const groups = new Map();
  for (const device of devices ?? []) {
    const version = device.fw?.version ?? '';
    groups.set(version, (groups.get(version) ?? []).concat(device));
  }
  const versions = [...groups.keys()].sort((a, b) => {
    if (a === '' || b === '') return a === '' ? 1 : -1;
    return compareVersions(parseVersion(b), parseVersion(a));
  });
  return versions.map((version) => ({ version, members: groups.get(version) }));
}

const OLDER_SHADES = 3;

/**
 * The fleet by firmware: a row per version with one tile per board. Rows label themselves,
 * so one board is a tile, not a bar that fills the width to say "1".
 */
function versionRows(devices, newest, revokedOnes, releases) {
  let behind = 0;
  // One board is said by the row: a tile on its own would measure nothing.
  const tiled = devices.length > 1;
  return h(
    'ul',
    { class: 'fleet-list', key: 'versions' },
    versionGroups(devices).map(({ version, members }) => {
      let tone = 'none';
      const unregistered = isUnregistered(version, releases);
      if (version && version === newest?.version) {
        tone = 'newest';
      } else if (unregistered) {
        tone = 'unregistered';
      } else if (version) {
        behind = Math.min(behind + 1, OLDER_SHADES);
        tone = `older-${behind}`;
      }
      const onTrial = members.filter((device) => device.fw && !device.fw.confirmed).length;
      return h(
        'li',
        { key: version || 'none', class: 'fleet-line' },
        h(
          'span',
          { class: 'fleet-name' },
          version ? mono(version, 'fleet-version') : h('span', { class: 'fleet-version quiet' }, 'Not reported'),
          version && newest?.version === version ? h('span', { class: 'tag' }, 'Newest release') : null,
          unregistered ? h('span', { class: 'tag is-warn' }, NOT_REGISTERED) : null,
          onTrial > 0 ? h('span', { class: 'tag is-warn' }, `${onTrial} on trial`) : null
        ),
        h(
          'span',
          { class: 'fleet-count' },
          plural(members.length, 'board'),
          revokedOnes.has(version) ? h('span', { class: 'tag is-bad' }, 'Revoked release') : null
        ),
        tiled
          ? h(
              'span',
              { class: 'tiles', 'aria-hidden': 'true' },
              members.map((device) =>
                h('span', { key: device.thing, class: `tile is-${tone}`, title: boardName(device, { full: true }) })
              )
            )
          : null
      );
    })
  );
}

function fleetCard(ctx, devices, newest) {
  const groups = versionGroups(devices);
  let body;
  if (devices === null) {
    body = pending(ctx.state.devices, 'versions');
  } else if (groups.length === 0) {
    body = h('p', { class: 'quiet' }, 'Versions appear here once a board has reported.');
  } else {
    const current = groups.find(({ version }) => version && version === newest?.version)?.members.length ?? 0;
    const others = offList(devices, ctx).length;
    // None on the newest release because they are on something that is not a release at
    // all is not the same as being behind, and must not read as that.
    const figure =
      current === 0 && others > 0
        ? [others, ` of ${devices.length} on firmware that is not a registered release`]
        : [current, ` of ${devices.length} on the newest release`];
    let headline = null;
    if (newest) {
      headline = h(
        'p',
        { class: 'figure fleet-headline', key: 'headline' },
        h('span', { class: 'figure-value' }, String(figure[0])),
        h('span', { class: 'figure-unit' }, figure[1])
      );
    } else if (ctx.state.firmware.value) {
      headline = h('p', { class: 'fleet-headline', key: 'headline' }, 'No release can be deployed.');
    }
    body = [
      headline,
      asReported(devices, ctx.state.now),
      versionRows(devices, newest, revokedVersions(ctx), releaseList(ctx)),
    ];
  }
  return card(
    {
      key: 'fleet',
      title: 'Firmware in the fleet',
      className: 'is-zone',
      more: { href: '#/devices', label: 'Devices' },
    },
    body
  );
}

/**
 * The newest release, in the sense the fleet card uses the words: the newest one that
 * can be deployed. An upload that is newer still but revoked is mentioned below it.
 * Only when nothing can be deployed is the newest upload shown, as revoked.
 */
/** The newest active release of each board type the releases name, newest type first. */
function newestByType(firmware) {
  const byType = new Map();
  for (const release of firmware?.releases ?? []) {
    if (release.status === 'active' && release.board && !byType.has(release.board)) byType.set(release.board, release);
  }
  return byType;
}

/** With releases for more than one board type: the newest of each, and how many of its boards run it. */
function releasesByTypeCard(ctx, byType) {
  const { state } = ctx;
  const boards = state.fleet?.value?.boards ?? null;
  return card(
    {
      key: 'release',
      title: 'Newest releases',
      className: 'is-zone',
      more: { href: '#/firmware', label: 'Firmware' },
    },
    h(
      'ul',
      { class: 'type-releases' },
      [...byType].map(([type, release]) => {
        const ofType =
          boards === null
            ? null
            : boards.filter((board) => board.type === type && (board.layout ?? 1) === (release.layout ?? 1));
        const on = ofType === null ? null : ofType.filter((board) => board.version === release.version).length;
        return h(
          'li',
          { key: type },
          h(
            'p',
            { class: 'type-release-head' },
            h('span', { class: 'fleet-chip board-chip' }, compatibilityWords(release))
          ),
          h('p', { class: 'release-figure is-small' }, mono(release.version), releaseBadge(release)),
          h(
            'p',
            { class: 'card-note' },
            'Uploaded ',
            when(release.uploadedAt, state.now),
            ' by ',
            who(release.uploadedBy)
          ),
          ofType !== null && ofType.length > 0
            ? h('p', { class: 'card-note' }, `${on} of ${plural(ofType.length, 'board')} on it`)
            : null
        );
      })
    )
  );
}

function releaseCard(ctx, newest) {
  const { state } = ctx;
  const firmware = state.firmware.value;
  // Releases for more than one board type: the newest is said for each (docs/fleet.md).
  const byType = newestByType(firmware);
  if (byType.size > 1) return releasesByTypeCard(ctx, byType);
  const unused =
    firmware && (newest ?? firmware.releases[0])
      ? unusedReleaseWords(newest ?? firmware.releases[0], state.devices.value?.devices)
      : null;
  const latest = firmware?.releases[0] ?? null;
  const shown = newest ?? latest;
  let body;
  if (!firmware) {
    body = pending(state.firmware, 'releases');
  } else if (!shown) {
    body = h('p', { class: 'quiet' }, 'No firmware has been uploaded yet.');
  } else {
    let note = null;
    if (!newest) {
      note = 'No release can be deployed.';
    } else if (latest !== newest) {
      note = [
        'A newer upload, ',
        mono(latest.version),
        ', was revoked',
        latest.revoked?.at ? [' ', when(latest.revoked.at, state.now)] : null,
        '.',
      ];
    }
    body = [
      h('p', { class: 'release-figure', key: 'version' }, mono(shown.version), releaseBadge(shown)),
      h(
        'p',
        { class: 'card-note', key: 'meta' },
        'Uploaded ',
        when(shown.uploadedAt, state.now),
        ' by ',
        who(shown.uploadedBy)
      ),
      h(
        'p',
        { class: 'card-note', key: 'size' },
        fileSize(shown.size),
        ' · SHA-256 ',
        mono(`${shown.sha256.slice(0, 12)}…`)
      ),
      note ? h('p', { class: 'card-note', key: 'note' }, note) : null,
      unused ? h('p', { class: 'card-note', key: 'unused' }, unused) : null,
    ];
  }
  return card(
    {
      key: 'release',
      title: 'Newest release',
      className: 'is-zone',
      more: { href: '#/firmware', label: 'Firmware' },
    },
    body
  );
}

/**
 * The newest release is what could be deployed, which need not be what the boards run. Said
 * when no board that has reported runs it, so that the two versions on a page do not look like
 * a contradiction.
 */
function unusedReleaseWords(release, devices) {
  const reporting = (devices ?? []).filter((device) => device.fw);
  if (reporting.length === 0 || reporting.some((device) => device.fw.version === release.version)) return null;
  if (reporting.length > 1) return 'No board runs this release.';
  const [board] = reporting;
  return ['The board ', board.online ? 'runs ' : 'last reported ', mono(board.fw.version), ', not this release.'];
}

/** The headline for boards that run something that is not a release. */
function unregisteredWords(strangers, devices) {
  const heard = strangers.every((device) => device.online);
  if (devices.length === 1) {
    const [{ fw }] = strangers;
    return `The board ${heard ? 'runs' : 'last reported'} ${fw.version}, which is not a registered release.`;
  }
  const count = strangers.length;
  if (!heard) return `${plural(count, 'board')} last reported firmware that is not a registered release.`;
  return `${plural(count, 'board runs', 'boards run')} firmware that is not a registered release.`;
}

/** Boards that left what the last deployment installed. How they got there is not on record. */
function movedWords(standing, deployment, now) {
  const { moved } = standing;
  if (deployment.things.length > 1) {
    return `${moved.length} of ${deployment.things.length} boards ${moved.length === 1 ? 'has' : 'have'} moved to other firmware since.`;
  }
  const [board] = moved;
  return board.online
    ? ['The board has since moved to ', mono(board.fw.version), '.']
    : ['When last seen, ', when(board.lastSeen, now), ', the board had moved to ', mono(board.fw.version), '.'];
}

/**
 * Boards that report an update, for when no deployment of this console is under way: a job
 * made directly in AWS IoT is not among the deployments. A board names a job of this console
 * by its id, and any other job as none. An offline board only says what it was at, then.
 */
function workWords(devices) {
  const busy = devices.filter((device) => device.ota && device.ota.state !== 'idle');
  if (busy.length === 0) return null;
  const count = busy.length;
  const alone = devices.length === 1;
  const heard = busy.every((device) => device.online);
  const opening = heard ? '' : 'When last seen, ';
  const who = alone ? `${heard ? 'The' : 'the'} board` : plural(count, 'board');
  const update = count === 1 ? 'an update' : 'updates';
  if (busy.every((device) => device.ota.job === null)) {
    const verb = count === 1 ? (heard ? 'is' : 'was') : heard ? 'are' : 'were';
    return `${opening}${who} ${verb} working on ${update} that this console did not start.`;
  }
  if (!heard) return `${opening}${who} reported ${update} in progress.`;
  return `${who} ${count === 1 ? 'reports' : 'report'} ${update} in progress.`;
}

/**
 * One update of the update history, as a row: what it installed and how that ended, and under it
 * where from, how it came and when. A deployment's row leads to the deployment, and on a list of
 * every board's updates any other row leads to its board.
 */
function updateRow(update, ctx, { withBoard = false } = {}) {
  const { now } = ctx.state;
  const outcome = describeOutcome(update);
  let href = null;
  if (update.how === 'deployment') href = deploymentHref(update.deployment);
  else if (withBoard) href = deviceHref(update.thing);
  const time = updateTime(update);
  return h(
    'li',
    { key: update.id, class: 'row history-row update-row' },
    h(
      'div',
      { class: 'row-main' },
      linkTo(href, { class: `mono row-title ${href ? 'cover-link' : ''}`.trim() }, update.to ?? 'Unknown version'),
      h(
        'span',
        { class: 'row-note dotted' },
        withBoard
          ? h('span', { key: 'board' }, boardName(boardOf(update.thing, ctx.state.devices?.value?.devices)))
          : null,
        update.from ? h('span', { key: 'from' }, 'from ', mono(update.from)) : null,
        h('span', { key: 'how', class: 'update-how' }, updateHow(update)),
        time ? h('span', { key: 'when' }, when(time, now)) : null
      )
    ),
    statusLine(outcome),
    href ? h('span', { class: 'row-chevron' }, icon('arrow-right')) : null
  );
}

/** Updates as rows, newest first. */
function updateRows(updates, ctx, options) {
  return h(
    'ul',
    { class: 'rows update-rows', key: 'updates' },
    updates.map((update) => updateRow(update, ctx, options))
  );
}

// How many of the newest updates the Overview lists under its news.
const UPDATES_ON_OVERVIEW = 3;

/**
 * The newest update, if it came some other way than the deployments this console lists, and after
 * the last of them ended: over Bluetooth, by USB or another tool. The Overview tells of it first.
 */
function updateOutsideDeployments(state, lastDone) {
  const newest = state.updates?.value?.updates?.[0] ?? null;
  if (newest === null || newest.how === 'deployment') return null;
  const at = Date.parse(updateTime(newest) ?? '');
  const done = Date.parse(lastDone?.completedAt ?? lastDone?.createdAt ?? '');
  return Number.isNaN(done) || (!Number.isNaN(at) && at > done) ? newest : null;
}

function updatesCard(ctx, devices) {
  const { state } = ctx;
  const { now } = state;
  const deployments = state.deployments.value;
  // Every board's updates however they came (GET /api/updates); null where the list is not to hand.
  const history = state.updates?.value?.updates ?? null;
  const byThing = new Map((devices ?? []).map((device) => [device.thing, device]));
  // Decided by the boards, not by the status of the job: a cancelled deployment can
  // still have a board that is installing, or restarting into the new firmware.
  const active = (deployments ?? []).filter(
    (deployment) => isUnderWay(deployment) || stillFinishing(deployment, devices, now)
  );
  const lastDone = (deployments ?? []).find((deployment) => !active.includes(deployment)) ?? null;
  // What is on the page predates the failure: it cannot say that nothing is going on.
  const outOfDate = Boolean(state.deployments.error);

  let body;
  if (deployments === null) {
    body = pending(state.deployments, 'deployments');
  } else if (active.length === 0 && devices === null && !state.devices.error) {
    // That nothing is going on is for the boards to say as well, and they are on their way.
    body = pending(state.devices, 'boards');
  } else if (active.length === 0) {
    // The tick is for updates that have been through, and only for those: a page that
    // says all is well right after a rollout failed would mislead at a glance. A
    // deployment that went wrong is what the panel opens with, in words, an icon and its
    // outcome bar. Before the first deployment there is nothing to tick off.
    const ending = lastDone ? describeDeployment(lastDone, devices) : null;
    // An update after it that came over Bluetooth, by USB or by another tool: that is the news, and
    // it says why the boards no longer run what the deployment installed.
    const since = updateOutsideDeployments(state, lastDone);
    const sinceOutcome = since ? describeOutcome(since) : null;
    // That a deployment went through is on record. Whether that is still what the boards run
    // is for the boards to say, and an offline board can only say what it last reported.
    const standing = ending?.tone === 'good' && !since ? installStanding(lastDone, devices) : null;
    const strangers = offList(devices, ctx);
    const movedOn = standing?.state === 'moved';
    // A board on firmware that is not a release is what there is to tell, unless the last
    // deployment went wrong or is what the boards report right now.
    const offRecord =
      !outOfDate &&
      strangers.length > 0 &&
      ending?.tone !== 'bad' &&
      ending?.tone !== 'warn' &&
      standing?.state !== 'current';
    // The deployments do not hold a job that was made directly in AWS IoT. The boards tell.
    const work = state.devices.error ? null : workWords(devices);

    let tone = outOfDate ? 'idle' : (ending?.tone ?? 'idle');
    let news = outOfDate ? null : (ending?.said ?? null);
    if (since && !outOfDate) {
      // Its outcome is the tone; the words are in the note, with how it came. One on trial is not over.
      tone = sinceOutcome.tone;
      news = since.outcome === 'pending' ? 'The last update has not ended yet.' : null;
    }
    if (offRecord) {
      tone = 'warn';
      news = unregisteredWords(strangers, devices);
    } else if (movedOn) {
      // Nothing to tick off: the boards have left what that deployment installed.
      tone = 'idle';
      news = null;
    }
    let iconName = since ? sinceOutcome.icon : ending?.icon;
    if (tone === 'idle') iconName = news === null && work ? 'restart' : 'minus-circle';
    else if (offRecord) iconName = 'alert';
    // Called off or one board's result: the words say it. A bar that is one block across
    // measures nothing, so it is for what several boards did.
    const boards = lastDone?.things.length ?? 0;
    const showBar = !since && boards > 1 && (tone === 'bad' || tone === 'warn' || tone === 'good');
    // Neither list can say that nothing is going on while it could not be read.
    const unknown = outOfDate || Boolean(state.devices.error);
    const atRest = !unknown && !work;
    const resting = unknown
      ? 'Whether an update is in progress cannot be told right now.'
      : 'No update is in progress.';
    let after = null;
    // The headline is about these boards, so the note is too, whatever the last deployment did.
    if (offRecord) after = offlineWords(strangers, now, devices.length === 1);
    else if (!outOfDate && movedOn) after = movedWords(standing, lastDone, now);
    else if (!outOfDate && standing && standing.state !== 'current') after = offlineWords(standing.boards, now);
    // The rest of the history, under the news: the newest few, however they came.
    const recent =
      history === null
        ? []
        : history
            .slice(since ? 1 : 0)
            .slice(0, UPDATES_ON_OVERVIEW)
            .filter((update) => !(update.how === 'deployment' && update.deployment === lastDone?.id && !since));
    body = h(
      'div',
      { class: `calm is-${tone}` },
      h('p', { class: `calm-title is-${tone}` }, icon(iconName ?? 'minus-circle'), news ?? work ?? resting),
      since
        ? h(
            'p',
            { class: 'card-note calm-note', key: 'last' },
            'Last update: ',
            linkTo(deviceHref(since.thing), { class: 'mono' }, since.to ?? 'Unknown version'),
            ' ',
            badge(sinceOutcome.tone, sinceOutcome.icon, sinceOutcome.label),
            ' ',
            h(
              'span',
              null,
              devices && devices.length > 1 ? [boardName(boardOf(since.thing, devices)), ', '] : null,
              updateHow(since),
              ', ',
              when(updateTime(since), now)
            )
          )
        : null,
      !since && lastDone
        ? h(
            'p',
            { class: 'card-note calm-note' },
            // Off the record, what the board runs did not come from a deployment: say whose this is.
            offRecord ? 'Last deployment from this console: ' : news ? null : 'Last deployment: ',
            linkTo(deploymentHref(lastDone.id), { class: 'mono' }, lastDone.version ?? lastDone.id),
            ' ',
            badge(ending.tone, ending.icon, ending.label),
            ' ',
            h(
              'span',
              null,
              // A cancelled deployment has no end on record: say that the time is its start.
              lastDone.completedAt ? when(lastDone.completedAt, now) : when(lastDone.createdAt, now, 'started '),
              news && atRest ? '. No update is in progress.' : null
            )
          )
        : null,
      !since && !lastDone
        ? h(
            'p',
            { class: 'card-note' },
            news && atRest ? 'No update is in progress. ' : null,
            'Deployments from this console appear here while boards are being updated.'
          )
        : null,
      news && work ? h('p', { class: 'card-note calm-work', key: 'work' }, work) : null,
      after ? h('p', { class: 'card-note calm-since', key: 'since' }, after) : null,
      showBar
        ? h(
            'div',
            { class: 'calm-outcome' },
            segments(countParts(lastDone.counts), `Boards: ${countWords(lastDone.counts)}.`, { thin: true }),
            // One board's count says what the words above say already.
            boards > 1 ? countList(lastDone.counts) : null
          )
        : null,
      recent.length > 0
        ? h(
            'div',
            { class: 'recent-updates', key: 'recent' },
            h('p', { class: 'eyebrow' }, 'Earlier updates'),
            updateRows(recent, ctx, { withBoard: true })
          )
        : null
    );
  } else {
    body = h(
      'ul',
      { class: 'run-list' },
      active.map((deployment) => {
        const detail = state.deploymentDetails.get(deployment.id)?.value ?? null;
        const counted = describeCounts(deployment.counts).map((entry) => `${entry.count} ${entry.label}`);
        return h(
          'li',
          { key: deployment.id, class: 'run' },
          h(
            'div',
            { class: 'run-head' },
            linkTo(deploymentHref(deployment.id), { class: 'run-version mono' }, deployment.version ?? deployment.id),
            h('span', { class: 'card-note' }, startedBy(deployment, now))
          ),
          deployment.status === 'CANCELED'
            ? h(
                'p',
                { class: 'card-note run-note' },
                isUnderWay(deployment)
                  ? 'This deployment was cancelled. A board that had already started carries on unless it is stopped.'
                  : 'This deployment was cancelled, but a board was already restarting into the new firmware. That cannot be stopped.'
              )
            : null,
          detail
            ? h(
                'ul',
                { class: 'board-runs' },
                detail.executions.map((execution) =>
                  boardLine(execution, deployment, ctx, byThing.get(execution.thing))
                )
              )
            : h('p', { class: 'card-note' }, counted.join(', '))
        );
      })
    );
  }
  return card(
    {
      key: 'updates',
      title: active.length > 0 ? 'Updates in progress' : 'Updates',
      className: `is-zone updates overview-updates ${active.length > 0 ? 'is-active' : ''}`.trim(),
      more: {
        href: '#/deployments',
        label: history !== null && history.length > 0 ? 'All updates' : 'All deployments',
      },
    },
    body,
    // The same sums as the top of the Deployments page.
    history !== null && history.length > 0
      ? h(
          'p',
          { class: 'card-note update-summary', key: 'summary' },
          updateSummary(history, Boolean(state.updates.value.cursor))
        )
      : null
  );
}

function activityCard(ctx) {
  const { state } = ctx;
  const recent = state.recent.value?.entries ?? null;
  let body;
  if (recent === null) {
    body = pending(state.recent, 'activity');
  } else if (recent.length === 0) {
    body = h(
      'p',
      { class: 'quiet' },
      'Nothing has been recorded yet. Uploads, deployments, cancellations and revocations will appear here.'
    );
  } else {
    const shown = recent.slice(0, 5);
    body = [
      h(
        'ul',
        { class: 'log is-compact', key: 'log' },
        shown.map((entry) => activityLine(entry, ctx, true))
      ),
      scriptedKey(shown, 'is-below'),
    ];
  }
  return card(
    {
      key: 'activity',
      title: 'Recent activity',
      className: 'overview-activity',
      more: { href: '#/activity', label: 'All activity' },
    },
    body
  );
}

/**
 * Releases whose revocation the server has not recorded as finished. Until it has, a
 * board may still be able to download or install the image, so this is said on top of
 * the overview, to everyone.
 */
function openRevocations(ctx, firmware) {
  const open = (firmware?.releases ?? []).filter((release) => revocationState(release) === 'incomplete');
  if (open.length === 0) return null;
  const versions = open.map((release, index) => {
    const joint = index === 0 ? null : index === open.length - 1 ? ' and ' : ', ';
    return [joint, mono(release.version)];
  });
  return h(
    'div',
    { key: 'revocations', class: 'page-notice' },
    notice(
      'warn',
      'alert',
      [
        h('strong', null, 'Revocation incomplete. '),
        versions,
        open.length === 1 ? ' is' : ' are',
        ' marked revoked, but the server has not recorded the steps that follow: refusing the image ',
        'and cancelling every open deployment. ',
        ctx.state.me.canWrite
          ? 'Finish revoking on the Firmware page.'
          : 'A release manager can finish revoking on the Firmware page.',
      ],
      { action: h('a', { class: 'btn is-small', href: '#/firmware' }, 'Firmware', icon('arrow-right')) }
    )
  );
}

/** A page is only as fresh as the oldest thing on it that could not be read again. */
function oldestRead(resources) {
  const read = resources.filter((resource) => resource.loadedAt > 0);
  return read.reduce((oldest, resource) => (resource.loadedAt < oldest.loadedAt ? resource : oldest), read[0] ?? null);
}

/**
 * The fleet at a glance (console 2.7): a few figures in one strip, each a way to the page that has
 * the rest. What is not known yet is a dash, never a nought.
 */
function glanceStrip(ctx, devices, newest) {
  const known = devices !== null;
  const phone = phoneOnly(ctx);
  const counted = known ? boardsCounted(devices, phone) : null;
  const updating = known ? devices.filter((device) => deviceActivity(device) !== null).length : null;
  const attention = ctx.state.fleetHealth?.value?.attention?.length ?? null;
  const items = [
    ['online', '#/devices', known ? `${counted.online}/${devices.length - counted.bluetooth}` : '–', 'Online'],
    ['updating', '#/deployments', known ? String(updating) : '–', 'Updating'],
    attention === null
      ? ['offline', '#/devices', known ? String(counted.quiet + counted.never) : '–', 'Offline']
      : ['attention', '#/devices', String(attention), 'Need attention'],
    ['newest', '#/firmware', newest ? newest.version : '–', 'Newest release'],
  ];
  return glance(items);
}

/** A strip of figures: [key, href, value, label] each. `className` says where it is shown. */
function glance(items, className = '') {
  // A way to other pages is a nav; figures that lead nowhere are a group.
  const leads = items.every(([, href]) => href);
  return h(
    leads ? 'nav' : 'div',
    {
      class: `glance ${className}`.trim(),
      key: 'glance',
      role: leads ? null : 'group',
      'aria-label': 'The fleet at a glance',
    },
    h(
      'ul',
      { class: 'glance-list' },
      items.map(([key, href, value, label]) =>
        h(
          'li',
          { key },
          h(
            href ? 'a' : 'span',
            { class: `glance-item is-${key}`, href },
            h('span', { class: 'glance-value' }, value),
            h('span', { class: 'glance-label' }, label)
          )
        )
      )
    )
  );
}

export function overviewView(ctx) {
  const { state } = ctx;
  const devices = state.devices.value?.devices ?? null;
  const firmware = state.firmware.value;
  const deployments = state.deployments.value;
  const newest = firmware?.releases.find((release) => release.status === 'active') ?? null;
  const have = {
    boards: (devices ?? []).length > 0,
    releases: (firmware?.releases ?? []).length > 0,
    deployments: (deployments ?? []).length > 0,
  };
  const loaded = devices !== null && firmware !== null && deployments !== null;
  const started = have.boards && have.releases && have.deployments;
  // A console with nothing in it shows the way in, not five cards that each say
  // "nothing yet". What has been recorded all the same, a refused upload for one, stays.
  const blank = loaded && !have.boards && !have.releases && !have.deployments;
  const recorded = (state.recent.value?.entries ?? []).length > 0;
  // A list that could not be read again may be missing what would finish the steps.
  const failed = [state.devices, state.firmware, state.deployments].filter((resource) => resource.error);

  let cards = null;
  if (!blank) {
    cards = [
      // What needs looking at comes before the rest (fleet.js): the fleet health score first, then its detail.
      ctx.fleet?.healthScoreCard(ctx) ?? null,
      ctx.fleet?.healthCard(ctx) ?? null,
      h(
        'div',
        { class: 'panel on-ink overview-panel', key: 'panel' },
        updatesCard(ctx, devices),
        h(
          'div',
          { class: 'fleet' },
          onlineCard(ctx, devices),
          fleetCard(ctx, devices, newest),
          releaseCard(ctx, newest)
        )
      ),
      h('div', { class: 'overview', key: 'grid' }, boardsCard(ctx, devices), activityCard(ctx)),
    ];
  } else if (recorded) {
    cards = activityCard(ctx);
  }

  return h(
    'div',
    { class: 'page' },
    pageHead({
      title: 'Overview',
      lede: 'What the boards last reported, and what is being updated right now.',
      tools: freshness(oldestRead(failed) ?? state.devices, ctx),
    }),
    blank ? null : glanceStrip(ctx, devices, newest),
    loadProblems(
      [
        [state.devices, 'the boards'],
        [state.firmware, 'the releases'],
        [state.deployments, 'the deployments'],
        [state.recent, 'the activity log'],
      ],
      ctx
    ),
    openRevocations(ctx, firmware),
    loaded && !started && failed.length === 0
      ? h(
          'div',
          { class: `welcome ${blank ? 'panel on-ink' : ''}`.trim(), key: 'welcome' },
          blank ? archWatermark() : null,
          gettingStarted(ctx, have)
        )
      : null,
    blank ? updateJourney() : null,
    cards
  );
}

// Devices.

/** Said after a value that an offline board reported. */
function whenLastSeen(device) {
  return device.online ? null : h('span', { class: 'quiet' }, ' when last seen');
}

function firmwareFact(device, revokedOnes, releases) {
  if (!device.fw) return h('span', { class: 'quiet' }, 'Not reported');
  return [
    mono(device.fw.version, 'fact-strong device-version'),
    // Said of the version and of whether it was confirmed. Whether it is a registered
    // release is a fact about today's list of releases.
    whenLastSeen(device),
    device.fw.confirmed
      ? badge('good', 'check', 'Confirmed')
      : badge(
          'warn',
          'pulse',
          'On trial',
          'Not confirmed yet. The bootloader goes back to the previous firmware if the board ' +
            'restarts before it confirms.'
        ),
    isUnregistered(device.fw.version, releases) ? badge('warn', 'alert', NOT_REGISTERED) : null,
    // Revoking does not touch a board that runs the release.
    revokedOnes.has(device.fw.version)
      ? [badge('bad', 'ban', 'Revoked release'), factNote('To replace it, upload a newer version and deploy that.')]
      : null,
  ];
}

/** `offer` is an update this board is offered and that it has not said anything about yet. */
function updateFact(device, offer) {
  const update = describeUpdate(device);
  const percent = update.progress !== null ? h('span', { class: 'status-value' }, `${update.progress}%`) : null;
  return h(
    'div',
    { class: 'fact-stack' },
    statusLine(update, percent),
    update.progress !== null ? meter(update.progress, `Download on ${boardName(device)}`) : null,
    update.text ? factNote(prose(update.text)) : null,
    offer && !update.deployment
      ? factNote([
          'Offered ',
          offer.version ? mono(offer.version) : 'an update',
          device.online ? '. It has not picked the offer up yet.' : '. It will see the offer when it connects.',
        ])
      : null,
    update.deployment || offer
      ? linkTo(
          deploymentHref(update.deployment ?? offer.deployment),
          { class: 'fact-link' },
          'Open the deployment',
          icon('arrow-right', 'is-small')
        )
      : null
  );
}

/**
 * A board's signal as words and bars. An offline board has no signal to speak of, only the
 * reading it last gave: that is what it is called, in muted type, with no verdict on it.
 */
function signalWords(device, live) {
  const quality = signalQuality(device.rssi);
  if (!quality) return h('span', { class: 'quiet' }, 'Not reported');
  if (device.online) return live(quality);
  return [
    signalBars(quality, true),
    h('span', { class: 'quiet signal-old' }, `${signed(device.rssi)} dBm when last seen`),
  ];
}

function signalFact(device, withScale) {
  return [
    h(
      'span',
      { class: 'signal-fact' },
      signalWords(device, (quality) => [signalBars(quality), `${quality.label} · ${signed(device.rssi)} dBm`])
    ),
    // A needle says where the signal is now. There is no such thing for an offline board.
    withScale && device.online ? signalScale(device) : null,
  ];
}

function uptimeFact(device) {
  if (device.uptime === null) return h('span', { class: 'quiet' }, 'Not reported');
  return [duration(device.uptime), whenLastSeen(device)];
}

/** When the last heartbeat arrived. The state goes with it in the words above, or in the badge. */
function heartbeatFact(device, now) {
  return device.lastSeen ? when(device.lastSeen, now) : h('span', { class: 'quiet' }, 'None yet');
}

function deviceFacts(device, ctx, { offer = openOffer(device, ctx), withScale = false, withHeartbeat = false } = {}) {
  return facts([
    // The list of devices has it in the line under the board's name, and its columns are fixed.
    withHeartbeat ? ['Heartbeat', heartbeatFact(device, ctx.state.now)] : null,
    ['Firmware', firmwareFact(device, revokedVersions(ctx), releaseList(ctx))],
    ['Update', updateFact(device, offer)],
    ['Signal', signalFact(device, withScale)],
    ['Uptime', uptimeFact(device)],
  ]);
}

/**
 * The deployment that is waiting for a board, from the deployments whose record has been
 * read. What a board says only goes as far as its last report; an offline board cannot
 * have said anything about an offer made since.
 */
function openOffer(device, ctx) {
  for (const deployment of ctx.state.deployments.value ?? []) {
    const detail = ctx.state.deploymentDetails.get(deployment.id)?.value;
    if (!isUnderWay(deployment) || !detail) continue;
    const own = detail.executions.find((execution) => execution.thing === device.thing);
    if (own?.status === 'QUEUED') return { deployment: deployment.id, version: deployment.version };
  }
  return null;
}

const NEVER_REPORTED = 'Has not reported to AWS IoT yet.';
const NEVER_REPORTED_HELP = 'Power it up and check that it was provisioned.';

function seenLine(device, now) {
  return heartbeatWords(device, now) ?? NEVER_REPORTED;
}

/** The state of the fleet as a whole, at the top of the Devices page. */
function devicesPanel(devices, ctx) {
  const firmware = ctx.state.firmware.value;
  const onTrial = devices.filter((device) => device.fw && !device.fw.confirmed).length;
  const updating = devices.filter((device) => deviceActivity(device) !== null).length;
  // The newest is marked once the releases are known.
  const newest = firmware?.releases.find((release) => release.status === 'active') ?? null;
  return h(
    'section',
    { class: 'panel on-ink devices-panel', key: 'panel', 'aria-label': 'The fleet at a glance' },
    h(
      'div',
      { class: 'devices-figure' },
      h('h2', { class: 'eyebrow' }, 'Fleet'),
      fleetFigure(devices, phoneOnly(ctx)),
      devices.length > 1
        ? tileWords(
            devices,
            [
              ['updating now', updating],
              ['on trial', onTrial],
            ],
            phoneOnly(ctx)
          )
        : null
    ),
    h(
      'div',
      { class: 'devices-versions' },
      h('h2', { class: 'eyebrow' }, 'Firmware in the fleet'),
      asReported(devices, ctx.state.now),
      versionRows(devices, newest, revokedVersions(ctx), releaseList(ctx))
    )
  );
}

function presenceLook(device, viaPhone) {
  if (isRestarting(device)) return 'is-restarting';
  if (isUp(device)) return 'is-up';
  if (viaPhone) return 'is-phone';
  return device.lastSeen ? 'is-down' : 'is-never';
}

const DEVICE_COLUMNS = ['Board', 'Status', 'Firmware', 'Update', 'Signal', 'Uptime'];

/** How a board stands, for the Devices page's filter: updating, Bluetooth only, online or offline. */
export function boardStanding(device, ctx) {
  if (deviceActivity(device) !== null) return 'updating';
  if (ctx.fleet?.bluetoothOnly(device, ctx)) return 'bluetooth';
  return device.online ? 'online' : 'offline';
}

/** The boards the Devices page's search and filters keep: by name, thing, version, type or group. */
export function devicesShown(ctx, devices) {
  return filtered(ctx, 'devices', devices, {
    words: (device) => [
      boardName(device, { full: true }),
      device.thing,
      device.fw?.version,
      device.fw?.slot0?.version,
      ...(device.attributes ? Object.values(device.attributes) : []),
      ...(ctx.fleet?.groupsOf?.(device, ctx) ?? []),
    ],
    keep: (device, filters) =>
      (filters.status === '' || boardStanding(device, ctx) === filters.status) &&
      (filters.version === '' || (device.fw?.version ?? '').startsWith(filters.version)),
  });
}

function devicesFilters(ctx, devices, shown) {
  const versions = [...new Set(devices.map((device) => device.fw?.version).filter(Boolean))].sort().reverse();
  return filterBar(ctx, 'devices', {
    label: 'boards',
    placeholder: 'Search by name, board, version or group',
    shown: shown.length,
    total: devices.length,
    controls: [
      filterSelect(ctx, 'devices', {
        name: 'status',
        label: 'State',
        all: 'Any state',
        options: [
          ['online', 'Online'],
          ['offline', 'Offline'],
          ['bluetooth', 'Bluetooth only'],
          ['updating', 'Updating'],
        ],
      }),
      filterSelect(ctx, 'devices', {
        name: 'version',
        label: 'Firmware',
        all: 'Any version',
        options: versions.map((version) => [version, version]),
      }),
    ],
  });
}

export function devicesView(ctx) {
  const { state } = ctx;
  const all = state.devices.value?.devices ?? null;
  const devices = all === null ? null : devicesShown(ctx, all);
  let body;
  if (devices === null) {
    body = pending(state.devices, 'boards');
  } else if (all.length === 0) {
    body = card({ key: 'none' }, empty(NO_BOARDS));
  } else if (devices.length === 0) {
    body = [devicesFilters(ctx, all, devices), noneMatch(ctx, 'devices', 'boards')];
  } else {
    const counted = boardsCounted(devices, phoneOnly(ctx));
    body = [
      // On a phone a strip of figures; wider, the panel with the firmware in the fleet.
      glance(
        [
          ['online', null, `${counted.online}/${devices.length - counted.bluetooth}`, 'Online'],
          ['offline', null, String(counted.quiet + counted.never), 'Offline'],
          ['bluetooth', null, String(counted.bluetooth), 'Bluetooth only'],
          [
            'updating',
            '#/deployments',
            String(devices.filter((device) => deviceActivity(device) !== null).length),
            'Updating',
          ],
        ],
        'is-compact'
      ),
      devicesPanel(devices, ctx),
      devicesFilters(ctx, all, devices),
      h(
        'div',
        { class: 'device-grid', key: 'grid' },
        h(
          'div',
          { class: 'device-columns', key: 'columns', 'aria-hidden': 'true' },
          DEVICE_COLUMNS.map((name) => h('span', { key: name }, name))
        ),
        devices.map((device) => {
          // Its type and its groups, and for a board without Wi-Fi what a phone last saw (fleet.js).
          const viaPhone = ctx.fleet?.bluetoothOnly(device, ctx) ?? null;
          return h(
            'article',
            // How it is, for the mark that leads its row on a phone: the badge beside it says it in words.
            { key: device.thing, class: `card device ${presenceLook(device, viaPhone)}` },
            h(
              'header',
              { class: 'device-head' },
              h(
                'div',
                null,
                h('h2', { class: 'device-name' }, boardLabel(device, 'cover-link'), icon('arrow-right', 'is-small')),
                boardName(device) === device.thing ? null : h('p', { class: 'device-thing' }, boardThing(device)),
                ctx.fleet?.boardTags(device, ctx) ?? null,
                h('p', { class: 'device-seen' }, viaPhone ? viaPhone.line : seenLine(device, state.now)),
                device.lastSeen || device.online || viaPhone
                  ? null
                  : h('p', { class: 'device-help' }, NEVER_REPORTED_HELP)
              ),
              viaPhone ? viaPhone.badge : presence(device, state.now),
              identifyButton(device, ctx, { compact: true })
            ),
            deviceFacts(device, ctx)
          );
        })
      ),
      // The groups of boards, made and changed here by release managers (fleet.js).
      ctx.fleet?.groupsCard(ctx) ?? null,
    ];
  }
  return h(
    'div',
    { class: 'page' },
    pageHead({
      title: 'Devices',
      lede: 'Every board registered to this project, as it last reported.',
      // In a phone app with a camera: read a board's QR code and open its page (docs/mobile-apps.md).
      tools: [
        state.app?.scan ? button('is-small', () => ctx.actions.scanBoard(), 'Scan board') : null,
        freshness(state.devices, ctx),
      ],
    }),
    loadProblem(state.devices, 'the boards', ctx),
    body
  );
}

const NOT_LOADED = Object.freeze({ value: null, error: null, loading: true, loadedAt: 0 });

function historyRow(execution, now, last) {
  const version = execution.version ?? versionOfDeployment(execution.deployment);
  // Only a job with this console's kind of name has a page here. Any other was made some
  // other way, directly in AWS IoT, and all this console knows of it is this line.
  const href = deploymentHref(execution.deployment);
  return h(
    'li',
    { key: execution.deployment, class: 'row history-row' },
    h(
      'div',
      { class: 'row-main' },
      linkTo(href, { class: `mono row-title ${href ? 'cover-link' : ''}`.trim() }, version ?? execution.deployment),
      h(
        'span',
        { class: 'row-note' },
        'Offered ',
        when(execution.queuedAt, now),
        isUnfinished(execution.status) ? null : [' · ended ', when(execution.lastUpdatedAt, now)]
      ),
      href ? null : h('span', { class: 'row-note history-outside' }, 'Started outside this console')
    ),
    statusLine(describeHistory(execution.status, last)),
    href ? h('span', { class: 'row-chevron' }, icon('arrow-right')) : null
  );
}

/** The entry of a board's history that the board's own last report speaks of: the one that ended last. */
function newestEnded(executions) {
  const ended = executions.filter((execution) => !isUnfinished(execution.status));
  return ended.reduce(
    (newest, execution) =>
      Date.parse(execution.lastUpdatedAt) > Date.parse(newest.lastUpdatedAt) ? execution : newest,
    ended[0] ?? null
  );
}

/**
 * What matters most on a board's page, on its panel: what the board is doing, if it is
 * doing anything, in words for across a room and with the keys while it waits for a
 * person. Below that, what its flash holds. Nothing on it claims a report that never came.
 */
function boardPanel(device) {
  const heard = device.fw || device.ota;
  const update = describeUpdate(device);
  const working = device.ota && device.ota.state !== 'idle';
  return h(
    'section',
    { class: 'panel on-ink board-panel', key: 'flash', 'aria-label': 'What the board reports' },
    working
      ? h(
          'div',
          { class: `board-run board-now is-${update.tone}`, key: 'now' },
          h(
            'div',
            { class: 'board-run-head' },
            h(
              'div',
              { class: 'board-run-who' },
              h(
                'div',
                { class: 'board-run-state' },
                h(
                  'span',
                  { class: `status is-${update.tone}` },
                  icon(update.icon),
                  h(
                    'span',
                    null,
                    update.title,
                    update.progress !== null ? h('span', { class: 'said-big' }, ` ${update.progress}%`) : null
                  )
                ),
                update.text ? h('span', { class: 'board-run-note' }, prose(update.text)) : null
              )
            ),
            update.progress !== null
              ? h(
                  'p',
                  { class: 'board-run-figure', 'aria-hidden': 'true' },
                  String(update.progress),
                  h('span', { class: 'execution-percent' }, '%')
                )
              : null,
            update.tone === 'act' ? buttonKeys() : null
          )
        )
      : null,
    heard
      ? slotsOfDevice(device)
      : h(
          'div',
          { class: 'board-silent', key: 'silent' },
          h('p', { class: 'board-silent-title' }, icon('minus-circle'), 'Nothing reported yet'),
          h(
            'p',
            { class: 'board-silent-text' },
            device.lastSeen
              ? 'This board has not said what it runs, so nothing is known about its flash memory.'
              : 'This board has not reported to AWS IoT, so nothing is known about its flash memory.'
          )
        )
  );
}

export function deviceView(ctx) {
  const { state } = ctx;
  const { thing } = state.route;
  const resource = state.deviceDetails.get(thing) ?? NOT_LOADED;
  const detail = resource.value;
  // The board as this page last read it, else as the list of boards has it: the name is
  // there before the page's own copy has come.
  const board = detail?.device ?? boardOf(thing, state.devices?.value?.devices);
  const named = boardName(board) !== thing;
  const head = pageHead({
    back: { href: '#/devices', label: 'Devices' },
    eyebrow: 'Board',
    // A name is set in the sans at display size, like a version; a thing name stays monospaced.
    title: named ? h('span', { class: 'board-title' }, boardName(board)) : mono(thing),
    lede: detail
      ? [
          seenLine(detail.device, state.now),
          detail.device.lastSeen || detail.device.online ? null : ` ${NEVER_REPORTED_HELP}`,
        ]
      : null,
    meta: named ? h('span', null, 'AWS IoT thing ', mono(thing)) : null,
    tools: missing(resource)
      ? null
      : [detail ? commandTools(detail.device, ctx) : null, labelButton(thing, ctx), freshness(resource, ctx)],
  });
  if (missing(resource)) {
    return h(
      'div',
      { class: 'page' },
      head,
      card(
        { key: 'none' },
        empty({
          iconName: 'chip',
          title: 'No board with this name is registered.',
          text: 'Check the address, or find the board in the list of devices.',
          action: { href: '#/devices', label: 'All devices' },
        })
      )
    );
  }
  if (!detail) {
    return h(
      'div',
      { class: 'page is-board' },
      head,
      loadProblem(resource, 'this board', ctx),
      pending(resource, 'the board')
    );
  }

  const { device, certificates, executions, olderExecutions: older, memfault } = detail;
  const ended = newestEnded(executions);
  // The board's own history says whether it has an update waiting, without any other list.
  const queued = executions.find((execution) => execution.status === 'QUEUED') ?? null;
  const offer = queued
    ? { deployment: queued.deployment, version: queued.version ?? versionOfDeployment(queued.deployment) }
    : openOffer(device, ctx);
  return h(
    'div',
    { class: 'page is-board' },
    head,
    loadProblem(resource, 'this board', ctx),
    // Its QR code and printable label (labels.js), while the person has them shown.
    state.labelShown === thing ? (ctx.labels?.boardLabel(device, ctx) ?? null) : null,
    commandNotice(device, ctx),
    boardPanel(device),
    h(
      'div',
      { class: 'split', key: 'split' },
      card(
        { key: 'state', title: 'State', className: 'device' },
        h('div', { class: 'device-presence' }, presence(device, state.now)),
        deviceFacts(device, ctx, { offer, withScale: true, withHeartbeat: true })
      ),
      h(
        'div',
        { class: 'stack' },
        locationCard(device, ctx),
        // Its type and flash layout, and the releases it can take (fleet.js).
        ctx.fleet?.compatibilityCard(device, ctx) ?? null,
        memfaultCard(device, memfault ?? null),
        // What Memfault knows of it: reboots with their reasons, events and issues (memfault-page.js).
        ctx.memfault?.boardSection(thing, ctx) ?? null,
        card(
          { key: 'certificates', title: 'Certificates' },
          certificates.length === 0
            ? h(
                'p',
                { class: 'quiet' },
                'No certificate is attached, so this board cannot connect. Run the provisioning tool again.'
              )
            : [
                h(
                  'ul',
                  { class: 'plain-list', key: 'list' },
                  certificates.map((id) => h('li', { key: id }, icon('key', 'is-small'), mono(`${id}…`)))
                ),
                h(
                  'p',
                  { class: 'card-note', key: 'note' },
                  'The start of each certificate ID. The certificate belongs to this board alone; ',
                  'its private key never leaves the board.'
                ),
              ]
        ),
        card(
          {
            key: 'events',
            title: 'Events and log',
            more: { href: filtersHash({ view: 'events' }, { board: thing }), label: 'Open' },
          },
          h(
            'p',
            { class: 'quiet' },
            'What this board reported over time, and every line it printed on its serial console, on the Events page.'
          )
        ),
        card(
          { key: 'history', title: 'Update history' },
          boardHistory(thing, ctx) ??
            (executions.length === 0
              ? h('p', { class: 'quiet' }, 'This board has not been offered an update yet.')
              : [
                  h(
                    'ul',
                    { class: 'rows', key: 'rows' },
                    executions.map((execution) =>
                      historyRow(execution, state.now, execution === ended ? (device.ota?.last ?? null) : null)
                    )
                  ),
                  older > 0
                    ? h(
                        'p',
                        { class: 'card-note history-cut', key: 'cut' },
                        `The newest ${executions.length} are shown. ${plural(older, 'older update is', 'older updates are')} not listed.`
                      )
                    : null,
                ])
        )
      )
    ),
    // Its Memfault heartbeat metrics as charts over 24 h or 7 d, the width of the page (memfault-page.js).
    ctx.memfault?.metricsSection(thing, ctx) ?? null
  );
}

/**
 * A board's every update however it came, from the update history; null until that has come, and
 * from a console that has none, where the board's executions in AWS IoT Jobs are what there is.
 */
function boardHistory(thing, ctx) {
  const updates = ctx.state.boardUpdates?.get(thing)?.value?.updates ?? null;
  if (updates === null) return null;
  if (updates.length === 0) return h('p', { class: 'quiet' }, 'This board has not reported an update yet.');
  return [
    updateRows(updates, ctx),
    ctx.state.boardUpdates.get(thing).value.cursor
      ? h('p', { class: 'card-note history-cut', key: 'cut' }, `The newest ${updates.length} are shown.`)
      : null,
  ];
}

// Firmware.

const CHAIN = [
  ['key', 'Signed at build', 'With the project’s private key'],
  ['shield', 'Checked on upload', 'By this server, with the public key'],
  ['chip', 'Checked at boot', 'By the board’s bootloader'],
];

/** A release whose image was checked against a key that is not this project's current one. */
function signedWithOldKey(release, fingerprint) {
  return Boolean(fingerprint) && Boolean(release.keyHash) && release.keyHash !== fingerprint;
}

function trustPanel(ctx) {
  const fingerprint = ctx.state.firmware.value?.fingerprint ?? '';
  // An image is stored only if it checks out against the key the server holds at that
  // moment, so a stored image with another fingerprint is from before the key was replaced.
  const earlier = (ctx.state.firmware.value?.releases ?? []).filter((release) =>
    signedWithOldKey(release, fingerprint)
  ).length;
  return h(
    'div',
    { class: 'trust' },
    h('h2', { class: 'trust-title' }, icon('shield'), 'The server verifies every upload'),
    h(
      'ol',
      { class: 'chain', key: 'chain' },
      CHAIN.map(([iconName, title, text]) =>
        h(
          'li',
          { key: title, class: 'chain-link' },
          h('span', { class: 'chain-mark' }, icon(iconName)),
          h('span', { class: 'chain-title' }, title),
          h('span', { class: 'chain-text' }, text)
        )
      )
    ),
    h(
      'p',
      null,
      'An image is stored only if its ECDSA P-256 signature checks out against this project’s ',
      'signing key. The board’s bootloader checks the same signature again before it starts the image.'
    ),
    h(
      'p',
      null,
      'The console holds only the public half of that key. It can check a signature; it can never ',
      'make one, and neither can anyone who signs in here.'
    ),
    fingerprint
      ? h(
          'div',
          { class: 'fingerprint' },
          h('p', { class: 'eyebrow' }, 'Signing key fingerprint · SHA-256'),
          h(
            'div',
            { class: 'digest-row' },
            mono(fingerprint, 'digest'),
            copyButton(fingerprint, 'the key fingerprint', ctx)
          ),
          earlier > 0
            ? h(
                'p',
                { class: 'fingerprint-note' },
                `${plural(earlier, 'older release was', 'older releases were')} signed with an earlier key, which has been `,
                `replaced since, so ${earlier === 1 ? 'it shows' : 'they show'} another fingerprint.`
              )
            : null
        )
      : null
  );
}

function dropZone(ctx) {
  const { upload } = ctx.state;
  const slot = ctx.state.firmware.value?.slotSize ?? null;
  return h(
    'label',
    {
      class: `drop ${upload.over ? 'is-over' : ''}`.trim(),
      onDragenter: ctx.actions.dragOver,
      onDragover: ctx.actions.dragOver,
      onDragleave: ctx.actions.dragLeave,
      onDrop: ctx.actions.dropFile,
    },
    h('input', {
      type: 'file',
      class: 'drop-input',
      accept: '.bin,application/octet-stream',
      onChange(event) {
        const [file] = event.target.files;
        event.target.value = '';
        if (file) ctx.actions.chooseFile(file);
      },
    }),
    h('span', { class: 'drop-icon' }, icon('upload')),
    h('span', { class: 'drop-title' }, 'Drop ', mono('latest.signed.bin'), ' here'),
    h('span', { class: 'drop-or' }, 'or ', h('span', { class: 'drop-pick' }, 'choose a file')),
    h(
      'span',
      { class: 'drop-note' },
      slot ? `A signed MCUboot image, up to ${fileSize(slot)}. ` : 'A signed MCUboot image. ',
      'Nothing is sent until you have checked what the file contains.'
    ),
    h(
      'span',
      { class: 'drop-note drop-where' },
      'Each build leaves its signed image in ',
      mono('binaries/latest.signed.bin'),
      ' in your checkout. Git does not track that folder.'
    )
  );
}

/** Enter in a field neither submits a dialog nor starts a new line in a one-line text. */
function ignoreEnter(event) {
  if (event.key === 'Enter' && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA')) {
    event.preventDefault();
  }
}

const CHECK_ICONS = { good: 'check-circle', warn: 'alert', bad: 'x-circle', wait: 'clock' };

// What the browser reads from a file says nothing about its signature. The list of
// checks says so itself, at the place where the decision to upload is made.
const SIGNATURE_UNCHECKED = {
  tone: 'wait',
  text: 'Signature: not checked yet. The server checks it against the project key when you upload.',
};

/**
 * Said while a file waits to be sent and the session is about to end: the console does
 * not leave for the sign-in page by itself while a file is in hand, because the file
 * would be gone on the way back.
 */
function sessionEnding(ctx) {
  const left = ctx.state.sessionLeft;
  if (left >= SESSION_WARNING_S) return null;
  const over = left <= 0;
  return h(
    'div',
    { key: 'session' },
    notice('warn', 'clock', h('strong', null, over ? 'Your session has ended. ' : 'Your session is about to end. '), {
      more: over
        ? 'Sign in again to upload; the file has to be chosen again afterwards.'
        : [
            `It ends in ${left < 60 ? 'less than a minute' : duration(left)}. Upload now, or sign in `,
            'again first; the file has to be chosen again after signing in.',
          ],
      action: button('is-small', ctx.actions.signInAgain, 'Sign in again'),
    })
  );
}

/** False once the release that was just uploaded has been revoked, here or elsewhere. */
function stillRegistered(ctx) {
  const { version } = ctx.state.upload.release;
  const known = ctx.state.firmware.value?.releases.find((release) => release.version === version);
  return !known || known.status === 'active';
}

/**
 * The server looked at this file and said no, and the file is what it said no to. It says
 * so before it has stored anything: a refusal of the file itself is final. A 401 or a 403
 * refuses the account, and whatever else comes back may be tried again.
 */
function refusedForGood(upload) {
  return (
    upload.stage === 'refused' &&
    !canRetryUpload(upload.error) &&
    upload.error.status !== 401 &&
    upload.error.status !== 403
  );
}

/** The newest deployment of the release that was just uploaded, once there is one. */
function deployedAlready(ctx) {
  const { version } = ctx.state.upload.release;
  return (ctx.state.deployments.value ?? []).find((deployment) => deployment.version === version) ?? null;
}

/** A size in bytes, and in larger units where that says something else. */
function sizeWords(bytes) {
  const short = fileSize(bytes);
  return short === exactBytes(bytes) ? short : `${exactBytes(bytes)} (${short})`;
}

/**
 * Where a file stands on its way to the boards. The strip above the panel: a word and a
 * mark for each stage, so that it reads without its colours.
 */
function uploadStages(ctx) {
  const { upload } = ctx.state;
  const finished = upload.stage === 'done' && stillRegistered(ctx);
  const review = upload.stage === 'ready' ? reviewImage(upload, ctx.state.firmware.value) : null;
  const unusable = Boolean(review?.blocked || review?.doomed);
  const sentOff = ['sending', 'checking', 'refused'].includes(upload.stage) || finished;

  // Finished steps stay in ink. Green is for the one result that was proved here.
  const choose = sentOff
    ? { state: 'done', word: 'done' }
    : { state: unusable ? 'failed' : 'act', word: unusable ? 'cannot be used' : 'your turn' };
  let verify = { state: 'ahead', word: 'not started' };
  if (upload.stage === 'sending') verify = { state: 'live', word: 'uploading' };
  else if (upload.stage === 'checking') verify = { state: 'live', word: 'the server is verifying' };
  else if (finished) verify = { state: 'good', word: 'signature valid' };
  else if (refusedForGood(upload)) verify = { state: 'failed', word: 'refused, nothing stored' };
  else if (upload.stage === 'refused') verify = { state: 'failed', word: 'not finished' };
  let deploy = finished ? { state: 'act', word: 'your turn' } : { state: 'ahead', word: 'not started' };
  if (finished && deployedAlready(ctx)) deploy = { state: 'done', word: 'started' };

  const marks = { done: 'check', good: 'check', failed: 'x' };
  const stages = [
    ['Choose a signed image', choose],
    ['The server verifies it', verify],
    ['Deploy it to boards', deploy],
  ];
  return h(
    'ol',
    { class: 'upload-stages', 'aria-label': 'From a file to the boards' },
    stages.map(([label, { state, word }], index) =>
      h(
        'li',
        {
          key: label,
          class: `upload-stage is-${state}`,
          'aria-current': state === 'act' || state === 'live' ? 'step' : null,
        },
        // The words say the same: read out, the mark would run into the name of the stage.
        h(
          'span',
          { class: 'upload-stage-mark', 'aria-hidden': 'true' },
          marks[state] ? icon(marks[state]) : String(index + 1)
        ),
        h(
          'span',
          { class: 'upload-stage-words' },
          h('span', { class: 'upload-stage-label' }, label),
          h('span', { class: 'sr-only' }, ': '),
          h('span', { class: 'upload-stage-word' }, word)
        )
      )
    )
  );
}

/**
 * What the server answered to an upload that it accepted. Every value is from its reply:
 * it answers like this only when every check in IMAGE_CHECKS has passed.
 */
function verifiedResult(ctx) {
  const { release } = ctx.state.upload;
  const { actions } = ctx;
  const fingerprint = ctx.state.firmware.value?.fingerprint ?? '';
  const sizes =
    release.size === null
      ? null
      : [
          'Size',
          sizeWords(release.size),
          release.headerSize === null || release.payloadSize === null
            ? null
            : factNote(
                `${exactBytes(release.headerSize)} of header, ${exactBytes(release.payloadSize)} of firmware, then the signature.`
              ),
        ];
  const deployed = deployedAlready(ctx);
  return h(
    'div',
    { class: 'upload-state is-verified' },
    h('p', { class: 'verified-title' }, icon('shield'), 'Verified by the server'),
    h('p', { class: 'upload-title is-good' }, icon('check-circle'), 'Registered as ', mono(release.version)),
    h(
      'p',
      { class: 'verified-text' },
      deployed
        ? 'The signature is valid and the image is stored. A deployment of it has been started.'
        : 'The signature is valid and the image is stored. It can now be offered to boards.'
    ),
    h(
      'div',
      { class: 'button-row' },
      deployed
        ? h(
            'a',
            { class: 'btn is-primary is-large', href: deploymentHref(deployed.id) },
            'Open its deployment',
            icon('arrow-right')
          )
        : button('is-primary is-large', () => actions.openDeploy(release.version), icon('send'), 'Deploy this release'),
      deployed ? button('', () => actions.openDeploy(release.version), icon('send'), 'Deploy it again') : null,
      button('', actions.resetUpload, 'Upload another')
    ),
    facts([
      [
        'Signature',
        h('span', { class: 'status is-good' }, icon('check-circle'), h('span', null, 'ECDSA P-256, valid')),
      ],
      release.keyHash
        ? [
            'Signing key',
            mono(release.keyHash, 'digest'),
            factNote(
              release.keyHash === fingerprint
                ? 'The fingerprint of this project’s signing key.'
                : 'The fingerprint of the key that signed it.'
            ),
          ]
        : null,
      ['Version', mono(release.version, 'fact-strong'), factNote('Read from the signed header of the image.')],
      sizes,
      release.sha256 ? ['SHA-256', mono(release.sha256, 'digest')] : null,
      release.loadAddress === null ? null : ['Load address', mono(`0x${release.loadAddress.toString(16)}`)],
    ])
  );
}

/**
 * The proof next to the verdict, on the first screen, where the explanation of what the
 * server would check stood before there was a result. The first release has nothing
 * before it to be newer than.
 */
function verifiedProof(ctx) {
  const { version } = ctx.state.upload.release;
  const releases = ctx.state.firmware.value?.releases ?? [];
  const first = releases.length > 0 && releases.every((release) => release.version === version);
  return h(
    'div',
    { class: 'trust verified-checks', key: 'proof' },
    h('h3', { class: 'trust-title' }, icon('shield'), 'What the server checked'),
    h(
      'ul',
      { class: 'checks' },
      IMAGE_CHECKS.map(({ passed, passedFirst }) => {
        const words = first && passedFirst ? passedFirst : passed;
        return h('li', { key: passed, class: 'check is-good' }, icon(CHECK_ICONS.good), h('span', null, words));
      })
    ),
    h(
      'p',
      { class: 'verified-after' },
      'The board’s bootloader checks the same signature again before it starts the image.'
    )
  );
}

/**
 * What the upload panel has to say to a screen reader. The panel changes as a whole from
 * one stage to the next, so its words go through a line that is always there: text that
 * appears together with its live region is not reliably read out. A refusal has a role
 * of its own in the notice that says it.
 */
function uploadSummary(ctx) {
  const { upload } = ctx.state;
  switch (upload.stage) {
    case 'reading':
      return `Reading ${upload.name}.`;
    case 'ready': {
      const review = reviewImage(upload, ctx.state.firmware.value);
      const version = upload.header.ok ? ` Version ${upload.header.version}.` : '';
      return `${upload.name}.${version} ${review.notes.map((note) => note.text).join(' ')}`;
    }
    case 'sending':
      return 'Uploading.';
    case 'checking':
      return 'Uploaded. The server is verifying the signature.';
    case 'done':
      return stillRegistered(ctx)
        ? `Registered as ${upload.release.version}. The signature is valid and the image is stored.`
        : '';
    case 'refused':
      return refusedForGood(upload) ? 'Nothing was stored.' : '';
    default:
      return '';
  }
}

/** Which of the server's checks an image failed, in words, and what that leaves behind. */
function refusalFacts(error) {
  const check = failedCheck(error.code);
  return h(
    'p',
    { class: 'notice-more upload-refusal' },
    check ? ['Check that failed: ', h('strong', null, check), '. '] : null,
    'Nothing was stored.'
  );
}

function uploadPanel(ctx) {
  const { upload } = ctx.state;
  const { actions } = ctx;

  if (upload.stage === 'idle') return dropZone(ctx);
  if (upload.stage === 'reading') {
    return h(
      'div',
      { class: 'upload-state' },
      h('p', { class: 'upload-title' }, icon('file'), mono(upload.name)),
      h('p', { class: 'quiet' }, 'Reading the file…')
    );
  }
  if (upload.stage === 'done') {
    // Revoked since: there is nothing left to offer, and the panel is ready for the next file.
    return stillRegistered(ctx) ? verifiedResult(ctx) : dropZone(ctx);
  }

  const review = reviewImage(upload, ctx.state.firmware.value);
  const busy = upload.stage === 'sending' || upload.stage === 'checking';
  const refused = upload.stage === 'refused';
  // A refusal of the file itself is final: sending the same bytes again cannot end
  // differently, so the way on is another file. A request that failed can be repeated.
  const final = refused && !canRetryUpload(upload.error);
  const ofImage = refusedForGood(upload);
  const percent = Math.round((upload.sent ?? 0) * 100);
  const { header } = upload;
  // What is certain to be refused is not going to be sent, so nothing will check its signature.
  const doomed = review.doomed && !refused;
  // Once the server has refused the file, what was expected of it has no more to say.
  // Before that the list says what is known; the server's answer says the rest.
  let checks = [...review.notes, SIGNATURE_UNCHECKED];
  if (final) checks = [];
  // On its way, the line below says what is being done about the signature.
  else if (review.blocked || refused || doomed || busy) checks = review.notes;
  const ended = ctx.state.sessionLeft <= 0;

  let next = null;
  if (upload.stage === 'sending') {
    // The figure is for the eye. The progress bar carries it for a screen reader, and
    // uploadSummary() says what is going on once.
    next = h(
      'div',
      { class: 'upload-progress' },
      h('p', null, 'Uploading…', h('span', { 'aria-hidden': 'true' }, ` ${percent}%`)),
      meter(percent, 'Upload')
    );
  } else if (upload.stage === 'checking') {
    next = h(
      'div',
      { class: 'upload-progress' },
      h('p', { class: 'upload-verifying' }, 'Uploaded. The server is verifying the signature…'),
      h('div', { class: 'meter is-busy' }, h('span', { class: 'meter-fill' }))
    );
  } else if (final || doomed) {
    next = h(
      'div',
      { class: 'button-row', key: 'another' },
      button('is-primary', actions.resetUpload, icon('file'), 'Choose another file')
    );
  } else if (!review.blocked) {
    next = [
      h(
        'label',
        { class: 'field', key: 'notes' },
        h('span', { class: 'field-label' }, 'Notes ', h('span', { class: 'quiet' }, '(optional)')),
        h('textarea', {
          class: 'input',
          rows: '2',
          maxlength: '500',
          value: upload.notes,
          onKeydown: ignoreEnter,
          onInput: (event) => actions.setUploadNotes(event.target.value),
        }),
        h('span', { class: 'field-hint' }, 'What changed in this build. Shown next to the release.')
      ),
      sessionEnding(ctx),
      // With the session over, the notice above has the one thing that can be done.
      ended
        ? null
        : h(
            'div',
            { class: 'button-row', key: 'send' },
            button('is-primary', actions.startUpload, icon('upload'), refused ? 'Try again' : 'Upload for verification')
          ),
    ];
  }

  return h(
    'div',
    { class: 'upload-state' },
    h(
      'div',
      { class: 'upload-file' },
      h('p', { class: 'upload-title' }, icon('file'), mono(upload.name)),
      busy || final || doomed ? null : button('is-small', actions.resetUpload, 'Choose another file')
    ),
    header.ok
      ? facts([
          ['Version', mono(header.version, 'fact-strong')],
          ['Size', sizeWords(upload.size)],
          ['SHA-256', mono(upload.digest, 'digest')],
          ['Layout', `${exactBytes(header.headerSize)} of header, ${exactBytes(header.payloadSize)} of firmware`],
          upload.recordedAs !== upload.name ? ['Recorded as', mono(upload.recordedAs)] : null,
        ])
      : null,
    checks.length > 0
      ? h(
          'ul',
          { class: 'checks', key: 'checks' },
          checks.map((note) =>
            h(
              'li',
              { key: note.text, class: `check is-${note.tone}` },
              icon(CHECK_ICONS[note.tone]),
              h('span', null, prose(note.text))
            )
          )
        )
      : null,
    refused
      ? failure(
          ofImage ? 'The server refused this image.' : 'The image was not stored.',
          upload.error,
          ofImage ? refusalFacts(upload.error) : null,
          actions.signInAgain
        )
      : null,
    next
  );
}

/** Who did something, with the account id written out: a tooltip cannot be read on a touch screen. */
function byAccount(person) {
  return factNote(['by ', nameOf(person), person?.sub ? [' · account ', mono(person.sub)] : null]);
}

function signedWords(release, fingerprint) {
  if (signedWithOldKey(release, fingerprint))
    return 'Not the current signing key. This release was signed with an earlier key, which has been replaced since.';
  return release.keyHash === fingerprint
    ? 'Matches this project’s signing key.'
    : 'Fingerprint of the key that signed it.';
}

function releaseDetails(release, fingerprint) {
  const sizes =
    `${exactBytes(release.size)}: ${exactBytes(release.headerSize)} of header, ` +
    `${exactBytes(release.payloadSize)} of firmware, then the signature`;
  const { revoked } = release;
  return h(
    'details',
    { class: 'more' },
    h('summary', null, 'Details', h('span', { class: 'sr-only' }, ` of ${release.version}`)),
    facts([
      ['File', mono(release.filename)],
      ['Size', sizes],
      ['File SHA-256', mono(release.sha256, 'digest'), factNote('What a board checks after downloading.')],
      [
        'Image hash',
        mono(release.imageHash, 'digest'),
        factNote('What the signature covers and the bootloader verifies.'),
      ],
      ['Signed with', mono(release.keyHash, 'digest'), factNote(signedWords(release, fingerprint))],
      ['Load address', mono(`0x${(release.loadAddress ?? 0).toString(16)}`)],
      release.board
        ? [
            'Compatible with',
            `${boardTypeLabel(release.board)}, flash layout ${release.layout ?? 1}`,
            factNote(
              'Read from the image\u2019s signed TLVs. A board of another type or layout is never offered it, and refuses it.'
            ),
          ]
        : null,
      ['Uploaded', exactTime(release.uploadedAt), byAccount(release.uploadedBy)],
      revoked ? ['Revoked', exactTime(revoked.at), byAccount(revoked.by)] : null,
      revoked?.enforcedAt
        ? [
            'Enforced',
            exactTime(revoked.enforcedAt),
            factNote('The image is refused and every open deployment of it was cancelled.'),
          ]
        : null,
    ])
  );
}

/** How much of a board's update slot an image takes. */
function slotFit(release, slot) {
  if (!slot) return null;
  const percent = (release.size / slot) * 100;
  const told = percent < 1 ? 'under 1%' : `${Math.round(percent)}%`;
  return h(
    'div',
    { class: 'slot-fit' },
    h(
      'span',
      {
        class: 'slot-fit-bar',
        'aria-hidden': 'true',
        vars: { '--fit': `${Math.min(100, percent).toFixed(2)}%` },
      },
      h('span', { class: 'slot-fit-fill' })
    ),
    h('span', { class: 'slot-fit-words' }, `Takes ${told} of the ${fileSize(slot)} update slot`)
  );
}

// The most releases the timeline shows; the list under it has them all.
const TIMELINE_RELEASES = 6;

/**
 * The releases in the order they were uploaded, evenly spaced, with the time between
 * them written on the line. On a true time axis two uploads an hour apart would land
 * on top of each other next to one from last month.
 */
function releaseTimeline(firmware, devices, now, onInk) {
  const { releases } = firmware;
  const newest = releases.find((release) => release.status === 'active') ?? null;
  const shown = releases.slice(0, TIMELINE_RELEASES).reverse();
  const earlier = releases.length - shown.length;
  const revoked = releases.filter((release) => release.status !== 'active').length;
  const counted = new Map();
  const quiet = new Set();
  for (const device of devices ?? []) {
    if (!device.fw) continue;
    counted.set(device.fw.version, (counted.get(device.fw.version) ?? 0) + 1);
    if (!device.online) quiet.add(device.fw.version);
  }
  const gap = (from, to) => {
    const seconds = (to - Date.parse(from)) / 1000;
    return Number.isFinite(seconds) && seconds >= 0 ? duration(seconds) : '';
  };

  return h(
    'section',
    { class: `timeline-panel ${onInk ? 'panel on-ink' : 'is-on-paper'}`, key: 'timeline' },
    h(
      'div',
      { class: 'timeline-head' },
      h('h2', { class: onInk ? 'eyebrow' : 'section-title timeline-title' }, 'Release timeline'),
      h(
        'p',
        { class: 'timeline-count dotted' },
        h('span', null, plural(releases.length, 'release')),
        revoked > 0 ? h('span', null, `${revoked} revoked`) : null,
        earlier > 0 ? h('span', null, `the newest ${shown.length} shown`) : null
      )
    ),
    h(
      'ol',
      { class: 'timeline', vars: { '--stations': String(shown.length) } },
      shown.map((release, index) => {
        const next = shown[index + 1];
        const isNewest = release === newest;
        const active = release.status === 'active';
        let state = 'is-active';
        if (isNewest) state = 'is-newest';
        else if (!active) state = 'is-revoked';
        let word = 'Active';
        if (isNewest) word = 'Newest release';
        else if (!active) word = 'Revoked';
        const boards = counted.get(release.version) ?? 0;
        return h(
          'li',
          { key: release.version, class: `station ${state}` },
          h('span', { class: 'station-mark' }, active ? null : icon('x')),
          h('span', { class: 'station-version mono' }, release.version),
          h('span', { class: 'station-state' }, word),
          h('span', { class: 'station-when' }, when(release.uploadedAt, now)),
          devices && boards > 0
            ? h(
                'span',
                { class: 'station-boards' },
                `${plural(boards, 'board')} on it${quiet.has(release.version) ? ' when last seen' : ''}`
              )
            : null,
          h(
            'span',
            {
              class: 'station-gap',
              title: next ? 'Time until the next upload' : 'Time since this upload',
            },
            h('span', { class: 'sr-only' }, next ? 'Next upload after ' : 'That was '),
            next ? gap(release.uploadedAt, Date.parse(next.uploadedAt)) : gap(release.uploadedAt, now),
            next ? null : h('span', { class: 'sr-only' }, ' ago')
          )
        );
      }),
      h(
        'li',
        { key: 'now', class: 'station is-now', 'aria-hidden': 'true' },
        h('span', { class: 'station-mark' }),
        h('span', { class: 'station-state' }, 'Now')
      )
    )
  );
}

function releaseRow(release, ctx) {
  const { now, me } = ctx.state;
  const { actions } = ctx;
  const active = release.status === 'active';
  const revocation = revocationState(release);

  // A release manager changes the note of any release, revoked ones too.
  const noteButton = me.canWrite
    ? h(
        'button',
        {
          type: 'button',
          class: 'btn is-small is-quiet',
          'aria-label': `Edit the note of ${release.version}`,
          onClick: () => actions.openNotes(release),
        },
        icon('file'),
        'Edit note'
      )
    : null;
  let controls = null;
  // A release for a board without Wi-Fi is sent from the phone app: no deployment can reach one.
  const overTheAir = !BLUETOOTH_ONLY_TYPES.includes(release.board);
  if (me.canWrite && active) {
    // Every row has the same two buttons. Their names say which release they act on.
    controls = [
      overTheAir
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn is-small',
              'aria-label': `Deploy ${release.version}`,
              onClick: () => actions.openDeploy(release.version),
            },
            icon('send'),
            'Deploy'
          )
        : null,
      h(
        'button',
        {
          type: 'button',
          class: 'btn is-small is-danger-quiet',
          'aria-label': `Revoke ${release.version}`,
          onClick: () => actions.openRevoke(release),
        },
        icon('ban'),
        'Revoke'
      ),
    ];
  } else if (me.canWrite && revocation === 'incomplete') {
    controls = button('is-small is-primary', () => actions.openRevoke(release), icon('ban'), 'Finish revoking');
  } else if (me.canWrite && revocation === 'unknown') {
    // A server that keeps no record of whether a revocation was finished: the way to
    // make sure stays open on every revoked release.
    controls = button('is-small', () => actions.openRevoke(release), 'Apply the revocation again');
  }

  if (noteButton) controls = [...(controls === null ? [] : [controls].flat()), noteButton];
  return h(
    'li',
    { key: release.version, class: `row release ${active ? '' : 'is-revoked'}`.trim() },
    h(
      'div',
      { class: 'release-main' },
      h(
        'div',
        { class: 'release-story' },
        h(
          'div',
          { class: 'release-title' },
          mono(release.version, 'release-version'),
          releaseBadge(release),
          // What the image is built for: its board type and flash layout (docs/fleet.md, Compatibility).
          release.board
            ? h(
                'span',
                { class: 'fleet-chip board-chip', title: 'The board type and flash layout this image is built for' },
                compatibilityWords(release)
              )
            : null
        ),
        // What changed, over up to three lines; the whole note is its title.
        release.notes ? h('p', { class: 'release-notes is-clamped', title: release.notes }, release.notes) : null,
        release.revoked
          ? h(
              'p',
              { class: 'release-revoked' },
              icon('ban', 'is-small'),
              h(
                'span',
                null,
                'Revoked ',
                when(release.revoked.at, now),
                ' by ',
                who(release.revoked.by),
                ': ',
                release.revoked.reason
              )
            )
          : null,
        revocation === 'incomplete'
          ? h(
              'p',
              { class: 'release-revoked is-open' },
              icon('alert', 'is-small'),
              h(
                'span',
                null,
                REVOCATION_OPEN,
                ' Until it has, a board may still be able to download or install it. ',
                me.canWrite ? 'Finish revoking to make sure.' : 'A release manager can finish revoking.'
              )
            )
          : null
      ),
      h(
        'div',
        { class: 'release-numbers' },
        slotFit(release, ctx.state.firmware.value.slotSize),
        h(
          'p',
          { class: 'row-note dotted' },
          h('span', null, fileSize(release.size)),
          h('span', null, 'Uploaded ', when(release.uploadedAt, now), ' by ', who(release.uploadedBy))
        ),
        h(
          'p',
          { class: 'row-note digest-row' },
          'SHA-256 ',
          mono(`${release.sha256.slice(0, 16)}…`),
          copyButton(release.sha256, `the SHA-256 of ${release.version}`, ctx)
        )
      )
    ),
    controls ? h('div', { class: 'release-actions' }, controls) : null,
    // Across the whole row, below the buttons, so that the tables of all releases are
    // equally wide and the keyboard goes through the row from top to bottom.
    releaseDetails(release, ctx.state.firmware.value.fingerprint)
  );
}

export function firmwareView(ctx) {
  const { state } = ctx;
  const firmware = state.firmware.value;
  const { canWrite } = state.me;
  let releases;
  if (!firmware) {
    releases = pending(state.firmware, 'releases');
  } else if (firmware.releases.length === 0) {
    releases = card(
      { key: 'none' },
      empty({
        iconName: 'package',
        title: 'No firmware has been uploaded yet.',
        text: canWrite
          ? prose('Build the firmware, then upload binaries/latest.signed.bin to register the first release.')
          : 'A release manager can upload the first signed image.',
      })
    );
  } else {
    const shown = filtered(ctx, 'firmware', firmware.releases, {
      words: (release) => [
        release.version,
        release.notes,
        release.filename,
        release.uploadedBy?.email,
        release.revoked?.reason,
        release.board,
      ],
      keep: (release, filters) => filters.status === '' || release.status === filters.status,
    });
    releases = [
      filterBar(ctx, 'firmware', {
        label: 'releases',
        placeholder: 'Search by version, notes or who uploaded it',
        shown: shown.length,
        total: firmware.releases.length,
        controls: [
          filterSelect(ctx, 'firmware', {
            name: 'status',
            label: 'Status',
            all: 'Active and revoked',
            options: [
              ['active', 'Active'],
              ['revoked', 'Revoked'],
            ],
          }),
        ],
      }),
      shown.length === 0
        ? noneMatch(ctx, 'firmware', 'releases')
        : card(
            { key: 'releases', className: 'is-flush' },
            h(
              'ul',
              { class: 'rows' },
              shown.map((release) => releaseRow(release, ctx))
            )
          ),
    ];
  }
  const timeline =
    firmware && firmware.releases.length > 0
      ? releaseTimeline(firmware, state.devices.value?.devices ?? null, state.now, !canWrite)
      : null;
  return h(
    'div',
    { class: 'page' },
    pageHead({
      title: 'Firmware',
      lede: 'Signed images that can be offered to boards. A version, once used, is never reused.',
      tools: freshness(state.firmware, ctx),
    }),
    loadProblem(state.firmware, 'the releases', ctx),
    // The one ink panel of the page holds what the reader is here to do: a release manager
    // takes a file from the desk to the boards. A viewer has the releases to read.
    canWrite
      ? h(
          'section',
          { class: 'upload panel on-ink', key: 'upload' },
          h(
            'div',
            { class: 'upload-main', tabindex: '-1', 'data-focus-home': '' },
            h('h2', { class: 'eyebrow' }, 'Upload, verify, deploy'),
            h('p', { class: 'sr-only', role: 'status' }, uploadSummary(ctx)),
            uploadStages(ctx),
            uploadPanel(ctx)
          ),
          state.upload.stage === 'done' && stillRegistered(ctx) ? verifiedProof(ctx) : trustPanel(ctx)
        )
      : null,
    timeline,
    canWrite ? null : h('section', { class: 'card upload is-readonly', key: 'upload' }, trustPanel(ctx)),
    h('h2', { class: 'section-title', key: 'title' }, 'Releases'),
    releases
  );
}

// Deployments.

function countList(counts, atButton, percent = null) {
  return h(
    'ul',
    { class: 'counts' },
    describeCounts(counts, atButton).map((entry) =>
      h(
        'li',
        { key: entry.name, class: `status is-${entry.tone}` },
        icon(entry.icon),
        h(
          'span',
          null,
          `${entry.count} ${entry.label}`,
          percent !== null && entry.name === 'inProgress'
            ? h('span', { class: 'status-value' }, ` · ${percent}%`)
            : null
        )
      )
    )
  );
}

/** The boards that wait for a person, among those of these deployments. */
function waitingForButton(devices, ids) {
  return devices.filter((device) => device.online && device.ota?.state === 'awaiting_user' && ids.has(device.ota.job))
    .length;
}

/** How far the download is, where one board is downloading and so one number can say it. */
function onePercent(devices, ids, updating) {
  const moving = devices.filter(
    (device) =>
      device.online &&
      device.ota?.state === 'downloading' &&
      ids.has(device.ota.job) &&
      Number.isFinite(device.ota.progress)
  );
  return updating === 1 && moving.length === 1 ? moving[0].ota.progress : null;
}

function deploymentRow(deployment, ctx) {
  const now = ctx.state.now;
  const summary = describeDeployment(deployment);
  // Whether a waiting board needs a person, and how far one is, is in what the boards say.
  const devices = ctx.state.devices.value?.devices ?? [];
  const own = new Set([deployment.id]);
  const atButton = waitingForButton(devices, own);
  return h(
    'li',
    { key: deployment.id, class: 'row deployment-row' },
    h(
      'div',
      { class: 'row-main' },
      h(
        'div',
        { class: 'release-title' },
        linkTo(
          deploymentHref(deployment.id),
          { class: 'mono release-version cover-link' },
          deployment.version ?? 'Unknown version'
        ),
        badge(summary.tone, summary.icon, summary.label)
      ),
      deployment.note ? h('p', { class: 'release-notes' }, deployment.note) : null,
      h(
        'p',
        { class: 'row-note dotted' },
        h('span', null, startedBy(deployment, now)),
        h('span', null, plural(deployment.things.length, 'board'))
      )
    ),
    h(
      'div',
      { class: 'row-outcome' },
      // One board is not a share of anything: a full bar would read as a finished one.
      deployment.things.length > 1
        ? segments(countParts(deployment.counts, atButton), `Boards: ${countWords(deployment.counts, atButton)}.`, {
            thin: true,
          })
        : null,
      countList(deployment.counts, atButton, onePercent(devices, own, deployment.counts.inProgress))
    ),
    h('span', { class: 'row-chevron' }, icon('arrow-right'))
  );
}

/**
 * The top of the Deployments page: every update of every board, however it came, and how each ended
 * (GET /api/updates, the newest of them); with the deployments' own figure that matters, how many are under way.
 */
function updatesPanel(updates, cut, deployments, ctx) {
  const totals = updateTotals(updates);
  const parts = [
    ['kept', 'good', 'Kept'],
    ['rolled_back', 'bad', 'Rolled back'],
    ['not_installed', 'warn', 'Not installed'],
    ['pending', 'wait', 'Pending'],
  ].map(([name, tone, label]) => ({ key: name, amount: totals.outcome[name], tone, name: label }));
  const shown = parts.filter((part) => part.amount > 0);
  const underWay = deployments.filter(isUnderWay).length;
  return h(
    'section',
    { class: 'panel on-ink deployments-panel updates-panel', key: 'panel', 'aria-label': 'Every update at a glance' },
    stats([
      ['Updates', `${totals.total}${cut ? '+' : ''}`, cut ? `the newest ${totals.total}` : 'of every board'],
      ['Deployments under way', underWay, `of ${deployments.length} deployments, AWS IoT jobs`],
      ['Over Bluetooth', totals.how.bluetooth, 'from a phone'],
      ['By USB or another tool', totals.how.usb_or_other],
    ]),
    h(
      'div',
      { class: 'outcomes' },
      h('p', { class: 'eyebrow' }, 'How each update ended'),
      totals.total > 1 ? h('div', { key: 'bar' }, segments(parts, updateSummary(updates, cut))) : null,
      h(
        'ul',
        { class: 'legend', key: 'legend' },
        shown.map((part) =>
          h(
            'li',
            { key: part.key, class: 'legend-item' },
            totals.total > 1 ? h('span', { class: `swatch is-${part.tone}` }) : null,
            h('span', null, `${part.amount} ${part.name.toLowerCase()}`)
          )
        )
      )
    )
  );
}

/** Every board of every deployment, by how it went: what the deployments' own records say, under the list's heading. */
function deploymentsPanel(deployments, ctx) {
  const total = {};
  for (const { counts } of deployments) {
    for (const [name, count] of Object.entries(counts)) total[name] = (total[name] ?? 0) + count;
  }
  const devices = ctx.state.devices.value?.devices ?? [];
  const ids = new Set(deployments.map((deployment) => deployment.id));
  const atButton = waitingForButton(devices, ids);
  const parts = countParts(total, atButton);
  const boards = parts.reduce((sum, part) => sum + part.amount, 0);
  const underWay = deployments.filter(isUnderWay).length;
  const percent = onePercent(devices, ids, total.inProgress);
  return h(
    'section',
    { class: 'deployments-panel jobs-panel', key: 'jobs-panel', 'aria-label': 'All deployments at a glance' },
    stats([
      ['Deployments', deployments.length, 'AWS IoT jobs'],
      ['Under way', underWay, 'deployments'],
    ]),
    h(
      'div',
      { class: 'outcomes' },
      h('p', { class: 'eyebrow' }, 'Where each board’s update stands in a deployment'),
      boards > 0
        ? [
            // One update is not a share of anything: the words below it say all there is.
            boards > 1
              ? h(
                  'div',
                  { key: 'bar' },
                  segments(parts, `${plural(boards, 'board update')}: ${countWords(total, atButton)}.`)
                )
              : null,
            h(
              'ul',
              { class: 'legend', key: 'legend' },
              describeCounts(total, atButton).map((entry) =>
                h(
                  'li',
                  { key: entry.name, class: 'legend-item' },
                  boards > 1 ? h('span', { class: `swatch is-${entry.tone}` }) : null,
                  icon(entry.icon, 'is-small'),
                  h(
                    'span',
                    null,
                    boards > 1 ? entry.label : `${entry.count} ${entry.label}`,
                    percent !== null && entry.name === 'inProgress' ? ` · ${percent}%` : null
                  )
                )
              )
            ),
          ]
        : h('p', { class: 'quiet', key: 'none' }, 'AWS IoT has not listed any board for these deployments yet.')
    )
  );
}

/**
 * Every update of every board, however it came, on the Deployments page: deployments board by board,
 * and the updates over Bluetooth and by USB or another tool that no deployment lists. Nothing while
 * the list has not come, or when a console says nothing of it.
 */
function everyUpdateCard(ctx) {
  const resource = ctx.state.updates;
  const updates = resource?.value?.updates ?? null;
  if (updates === null) return resource?.error ? loadProblem(resource, 'the update history', ctx) : null;
  return [
    h('h2', { class: 'section-title', key: 'every-title' }, 'Every update, newest first'),
    card(
      { key: 'every', className: 'every-update' },
      updates.length === 0
        ? h('p', { class: 'quiet' }, 'No board has reported an update yet.')
        : [
            updateRows(updates, ctx, { withBoard: true }),
            resource.value.cursor
              ? h('p', { class: 'card-note history-cut', key: 'cut' }, `The newest ${updates.length} are shown.`)
              : null,
          ],
      h(
        'p',
        { class: 'card-note', key: 'note' },
        'Each says how it came: a deployment (its row opens the deployment), over Bluetooth from someone\u2019s phone, ',
        'or by USB or another tool.'
      )
    ),
  ];
}

/** The top of the page: every update when the history has come, else the deployments' own figures. */
function deploymentsTop(deployments, ctx) {
  const resource = ctx.state.updates;
  const updates = resource?.value?.updates ?? null;
  if (updates === null) return deployments.length > 0 ? deploymentsPanel(deployments, ctx) : null;
  return updatesPanel(updates, Boolean(resource.value.cursor), deployments, ctx);
}

/** The deployments the search and filters keep: by version, id, who made it, its note or a board. */
function deploymentsList(ctx, deployments) {
  const devices = ctx.state.devices.value?.devices ?? [];
  const shown = filtered(ctx, 'deployments', deployments, {
    words: (deployment) => [
      deployment.version,
      deployment.id,
      deployment.status,
      deployment.note,
      deployment.createdBy?.email,
      ...deployment.things,
      ...deployment.things.map((thing) => boardName(boardOf(thing, devices), { full: true })),
    ],
    keep: (deployment, filters) => filters.status === '' || (filters.status === 'underway') === isUnderWay(deployment),
  });
  return [
    filterBar(ctx, 'deployments', {
      label: 'deployments',
      placeholder: 'Search by version, board, note or who made it',
      shown: shown.length,
      total: deployments.length,
      controls: [
        filterSelect(ctx, 'deployments', {
          name: 'status',
          label: 'Status',
          all: 'Under way and ended',
          options: [
            ['underway', 'Under way'],
            ['ended', 'Ended'],
          ],
        }),
      ],
    }),
    shown.length === 0
      ? noneMatch(ctx, 'deployments', 'deployments')
      : card(
          { key: 'list', className: 'is-flush' },
          h(
            'ul',
            { class: 'rows' },
            shown.map((deployment) => deploymentRow(deployment, ctx))
          )
        ),
  ];
}

export function deploymentsView(ctx) {
  const { state } = ctx;
  const deployments = state.deployments.value;
  const { canWrite } = state.me;
  const firmware = state.firmware.value;
  const deployable = firmware === null || firmware.releases.some((release) => release.status === 'active');

  let body;
  if (deployments === null) {
    body = pending(state.deployments, 'deployments');
  } else if (deployments.length === 0) {
    let text = 'Choose New deployment to offer a release to one or more boards.';
    if (!canWrite) {
      text = 'When a release manager offers a release to boards, it appears here.';
    } else if (!deployable) {
      text = [
        'Upload a signed image on the ',
        h('a', { href: '#/firmware' }, 'Firmware page'),
        ' first; then it can be offered to boards here.',
      ];
    }
    body = [
      deploymentsTop(deployments, ctx),
      everyUpdateCard(ctx),
      h('h2', { class: 'section-title', key: 'jobs-title' }, 'Deployments'),
      card({ key: 'none' }, empty({ iconName: 'send', title: 'No deployments yet.', text })),
    ];
  } else {
    const leads = ctx.state.updates?.value?.updates != null;
    body = [
      deploymentsTop(deployments, ctx),
      // Staged rollouts: a canary, then stages (fleet.js).
      ctx.fleet?.rolloutsPanel(ctx) ?? null,
      everyUpdateCard(ctx),
      h('h2', { class: 'section-title', key: 'jobs-title' }, 'Deployments'),
      // With the history at the top, the deployments' own figures lead their list.
      leads ? deploymentsPanel(deployments, ctx) : null,
      deploymentsList(ctx, deployments),
    ];
  }

  // With no release that can be deployed, the way on is the Firmware page: a button
  // that opens a dialog with nothing to choose from would lead nowhere.
  let start = null;
  if (canWrite && deployable) {
    start = button('is-primary', () => ctx.actions.openDeploy(null), icon('plus'), 'New deployment');
  } else if (canWrite) {
    start = h('a', { class: 'btn is-primary', href: '#/firmware' }, icon('upload'), 'Upload firmware first');
  }
  return h(
    'div',
    { class: 'page' },
    pageHead({
      title: 'Deployments',
      lede:
        'Every update of every board, newest first, however it came: a deployment, over Bluetooth from a phone, or by ' +
        'USB or another tool. A deployment sends one release to a set of boards. ' +
        `A board on firmware ${FIRST_WITH_NO_BUTTON} or newer starts as soon as it sees it, and older firmware ` +
        'waits for someone to press Button 1 on the board. ' +
        'A job made directly in AWS IoT is not listed here as a deployment; its updates are in Every update, as the boards reported them.',
      tools: [freshness(state.deployments, ctx), start],
    }),
    loadProblem(state.deployments, 'the deployments', ctx),
    body
  );
}

function executionPresence(execution, known, unread) {
  // Cancelled after it started: a board in the middle of a restart still counts as online
  // for a while, and only the board list tells. Until that has been read, nothing is said.
  if (unread && execution.status === 'CANCELED' && execution.startedAt) return badge('idle', 'clock', 'Not known yet');
  // While the update runs its phase says so. Once it was cancelled the phase no longer
  // does, and what the board itself last said still counts.
  const restarting = execution.phase === 'rebooting' || (known && isRestarting(known));
  if (execution.online && restarting) return badge('idle', 'restart', 'Restarting');
  if (execution.online) return badge('good', 'online', 'Online');
  if (known && !known.lastSeen) return badge('idle', 'minus-circle', 'Never connected');
  return badge('idle', 'offline', 'Offline');
}

// With several boards, only one that is moving, waiting for a person or stopped keeps the
// whole panel; the others take a line, in the same order, so that nothing jumps.
const MOST_FULL_PANELS = 3;
const FULL_TONES = new Set(['act', 'live', 'bad']);

/**
 * What a board's history says about a deployment that it is part of: see describeExecution.
 * A copy read before the board got to what it runs now says nothing about how it got
 * there, so it does not count as an answer: not yet read, as far as this goes.
 */
function historyOf(execution, ctx) {
  const detail = ctx.state.deviceDetails.get(execution.thing)?.value ?? null;
  if (detail === null || detail.device.fw?.version !== execution.reported) return { history: null, historyCut: false };
  return { history: detail.executions, historyCut: detail.olderExecutions > 0 };
}

/** The boards of a deployment whose own list of updates is needed to say how it ended, and cannot be read. */
function unreadHistories(deployment, ctx) {
  return deployment.executions
    .filter(
      (execution) =>
        execution.status === 'CANCELED' &&
        execution.reported === deployment.version &&
        historyOf(execution, ctx).history === null
    )
    .map((execution) => ctx.state.deviceDetails.get(execution.thing))
    .filter((resource) => resource?.error);
}

/** One board's part in a deployment: what it is doing, in words and as steps. */
function executionCard(execution, deployment, ctx, boards = 1) {
  const { now } = ctx.state;
  const known = (ctx.state.devices.value?.devices ?? []).find((device) => device.thing === execution.thing);
  const unread = ctx.state.devices.value === null;
  // What to call the board: as the list of boards has it, or as its own page last read it.
  const board = known ?? ctx.state.deviceDetails.get(execution.thing)?.value?.device ?? boardOf(execution.thing);
  const description = describeExecution(execution, {
    board: known ?? null,
    deployment: deployment.id,
    version: deployment.version,
    ...historyOf(execution, ctx),
    unread,
  });
  const target = deployment.version ?? versionOfDeployment(deployment.id);
  const finished = !isUnfinished(execution.status);
  const compact = boards > 1 && (boards > MOST_FULL_PANELS || !FULL_TONES.has(description.tone));
  // What to do about an update that ended short: to offer it again, the release has to
  // be there still and the reader has to be able to deploy.
  const offerable = !revokedVersions(ctx).has(deployment.version);
  // Every one of these asks for something only a release manager can do.
  const next = description.next && ctx.state.me.canWrite && (offerable || !description.retry) ? description.next : null;
  const moments = [
    execution.queuedAt ? ['Offered ', whenAt(execution.queuedAt, now)] : null,
    execution.startedAt ? ['Started ', whenAt(execution.startedAt, now)] : null,
    // AWS's record of an execution does not move with the download, so while the board
    // is at work this would claim that the board had gone quiet.
    finished && description.tone !== 'live' && execution.lastUpdatedAt
      ? ['Ended ', whenAt(execution.lastUpdatedAt, now)]
      : null,
    execution.status === 'IN_PROGRESS' && execution.secondsLeft !== null
      ? `Times out in ${duration(execution.secondsLeft)}`
      : null,
    // The board's own word on what it runs, when the deployment's record names no version.
    finished && !execution.ranAtEnd && !execution.reported && known?.fw
      ? [known.online ? 'Board now reports ' : 'Board last reported ', mono(known.fw.version)]
      : null,
    !execution.online && known?.lastSeen ? ['Board last seen ', when(known.lastSeen, now)] : null,
  ].filter(Boolean);
  const flash = compact ? null : slotsOfExecution(execution, known, target, description, deployment.id);

  return h(
    'article',
    {
      key: execution.thing,
      class: `card execution is-${description.tone}${compact ? ' is-compact' : ''}`,
    },
    h(
      'header',
      { class: 'execution-head' },
      h('h2', { class: 'execution-name' }, boardLabel(board), boardThing(board)),
      executionPresence(execution, known, unread)
    ),
    h(
      'div',
      { class: 'execution-state' },
      h(
        'div',
        { class: 'execution-words' },
        h(
          'p',
          { class: `execution-title status is-${description.tone}` },
          icon(description.icon),
          // The figure is for the eye, and outside the live region. The progress bar carries
          // it for a screen reader, which would otherwise read out every change of this line.
          h(
            'span',
            null,
            h('span', { role: 'status' }, description.said ?? description.title),
            description.progress !== null
              ? h('span', { class: 'said-big', 'aria-hidden': 'true' }, ` ${description.progress}%`)
              : null
          )
        ),
        h('p', { class: 'execution-text' }, prose(description.text)),
        next ? h('p', { class: 'execution-next' }, next) : null,
        description.installedBy
          ? h(
              'p',
              { class: 'execution-next' },
              linkTo(deploymentHref(description.installedBy), null, 'Open the deployment that installed it')
            )
          : null,
        description.code
          ? h('p', { class: 'execution-code' }, 'The board gave the reason ', mono(description.code))
          : null,
        execution.detail ? h('p', { class: 'execution-code' }, 'Board’s note: ', mono(execution.detail)) : null,
        description.progress !== null ? meter(description.progress, `Download on ${boardName(board)}`) : null
      ),
      description.progress !== null
        ? h(
            'p',
            { class: 'execution-figure', 'aria-hidden': 'true' },
            String(description.progress),
            h('span', { class: 'execution-percent' }, '%')
          )
        : null,
      description.tone === 'act' ? buttonKeys() : null
    ),
    h(
      'div',
      { class: 'pipeline', key: 'pipeline' },
      returnPath(execution, description),
      stepList(description, { compact, viewer: !ctx.state.me.canWrite })
    ),
    h(
      'div',
      { class: 'execution-lower', key: 'lower' },
      flash,
      moments.length > 0
        ? h(
            'section',
            { class: 'moments', key: 'moments', 'aria-label': 'What happened when' },
            compact ? null : h('h3', { class: 'eyebrow' }, 'What happened when'),
            h(
              'p',
              { class: 'execution-foot' },
              moments.map((moment, index) => h('span', { key: String(index), class: 'moment' }, moment))
            )
          )
        : null
    )
  );
}

/** True if the log shows this deployment cancelled before its release was revoked. */
function cancelledFirst(entry, release) {
  return Boolean(entry) && Date.parse(entry.at) < Date.parse(release.revoked.at);
}

/**
 * Who cancelled a deployment and why, as far as the log and the list of releases tell.
 * The record of the job itself says neither. That its release was revoked is said on any
 * deployment of it, over or not.
 */
function cancellation(deployment, ctx) {
  const { now } = ctx.state;
  const cancelled = deployment.status === 'CANCELED';
  // The log is newest first, and what counts is the cancellation that took the deployment off the list.
  const entry = cancelled
    ? (ctx.state.audit.value?.entries ?? []).findLast(
        (candidate) =>
          candidate.action === 'deployment.cancel' && candidate.outcome === 'ok' && candidate.target === deployment.id
      )
    : null;
  const release = (ctx.state.firmware.value?.releases ?? []).find((item) => item.version === deployment.version);
  return {
    by: entry ? h('span', { key: 'cancelled' }, 'Cancelled ', whenAt(entry.at, now), ' by ', who(entry.actor)) : null,
    because: release?.revoked
      ? h(
          'div',
          { key: 'revoked', class: 'page-notice' },
          notice(
            'idle',
            'ban',
            [
              mono(release.version),
              ' was revoked ',
              when(release.revoked.at, now),
              ' by ',
              who(release.revoked.by),
              release.revoked.reason ? [': ', sentence(release.revoked.reason)] : '.',
              // Cancelled by hand before that, the revocation is not why it stopped.
              !cancelled || cancelledFirst(entry, release)
                ? null
                : ' Revoking cancels every open deployment of a release.',
            ],
            { action: h('a', { class: 'btn is-small', href: '#/firmware' }, 'Firmware', icon('arrow-right')) }
          )
        )
      : null,
  };
}

export function deploymentView(ctx) {
  const { state } = ctx;
  const { id } = state.route;
  const resource = state.deploymentDetails.get(id) ?? NOT_LOADED;
  const deployment = resource.value;
  const version = deployment?.version ?? versionOfDeployment(id);
  const summary = deployment ? describeDeployment(deployment) : null;
  const unfinished = deployment ? deployment.executions.some((execution) => isUnfinished(execution.status)) : false;
  // Cancelled without force, and boards are still at it: the badge alone would stand
  // next to a board that goes on downloading, with no word on why.
  const withdrawn = unfinished && deployment.status === 'CANCELED';
  const atWork = withdrawn && deployment.executions.some((execution) => execution.status === 'IN_PROGRESS');
  const { by, because } = deployment ? cancellation(deployment, ctx) : { by: null, because: null };
  // A deployment that ended short can be offered again, if its release is still there and a
  // board would not refuse it, which describeExecution() has weighed.
  const boards = state.devices.value?.devices ?? [];
  const shortOfDone =
    deployment &&
    !unfinished &&
    !isUnderWay(deployment) &&
    deployment.executions.some(
      (execution) =>
        describeExecution(execution, {
          board: boards.find((device) => device.thing === execution.thing) ?? null,
          deployment: id,
          version: deployment.version,
          unread: state.devices.value === null,
        }).retry
    );
  const offerAgain =
    shortOfDone && state.me.canWrite && state.firmware.value !== null && !revokedVersions(ctx).has(deployment.version);

  if (missing(resource)) {
    return h(
      'div',
      { class: 'page' },
      pageHead({
        back: { href: '#/deployments', label: 'Deployments' },
        eyebrow: 'Deployment',
        title: 'Not found',
      }),
      card(
        { key: 'none' },
        empty({
          iconName: 'send',
          title: 'There is no deployment with this address.',
          text: 'Check the address, or find it in the list of deployments.',
          action: { href: '#/deployments', label: 'All deployments' },
        })
      )
    );
  }

  const head = pageHead({
    back: { href: '#/deployments', label: 'Deployments' },
    eyebrow: 'Deployment of',
    title: [mono(version ?? 'unknown version'), summary ? badge(summary.tone, summary.icon, summary.label) : null],
    lede: deployment?.note || null,
    meta: deployment
      ? [
          h(
            'span',
            { key: 'started' },
            startedBy(deployment, state.now, whenAt),
            deployment.completedAt ? [', finished ', whenAt(deployment.completedAt, state.now)] : null
          ),
          by,
          h(
            'span',
            { key: 'id', class: 'digest-row' },
            mono(deployment.id),
            copyButton(deployment.id, 'the deployment ID', ctx)
          ),
        ]
      : null,
    tools: [
      freshness(resource, ctx),
      // Keyed: when a deployment ends, "Offer again" is not the cancel button under another
      // name, and the keyboard goes to the page's title rather than on to it by accident.
      state.me.canWrite && unfinished
        ? h(
            'button',
            {
              key: 'cancel',
              type: 'button',
              class: 'btn is-danger-quiet',
              onClick: () => ctx.actions.openCancel(deployment),
            },
            icon('stop'),
            withdrawn ? 'Stop boards that have started' : 'Cancel deployment'
          )
        : null,
      offerAgain
        ? h(
            'button',
            {
              key: 'offer',
              type: 'button',
              class: 'btn',
              onClick: () => ctx.actions.openDeploy(deployment.version),
            },
            icon('send'),
            'Offer again'
          )
        : null,
    ],
  });
  if (!deployment) {
    return h(
      'div',
      { class: 'page' },
      head,
      loadProblem(resource, 'this deployment', ctx),
      pending(resource, 'the deployment')
    );
  }
  return h(
    'div',
    { class: 'page' },
    head,
    loadProblem(resource, 'this deployment', ctx),
    // What the page cannot say until these have been read, and does not say.
    state.devices.value === null ? loadProblem(state.devices, 'the list of boards', ctx) : null,
    unreadHistories(deployment, ctx)
      .slice(0, 1)
      .map((known) => loadProblem(known, 'the board’s list of updates', ctx)),
    withdrawn
      ? h(
          'div',
          { key: 'withdrawn', class: 'page-notice' },
          notice(
            'idle',
            'stop',
            atWork
              ? 'This deployment was cancelled. A board that had already started carries on unless it is stopped.'
              : 'This deployment was cancelled. AWS takes a few seconds to withdraw the offer from every board.'
          )
        )
      : null,
    because,
    deployment.executions.length === 0
      ? card({ key: 'none' }, h('p', { class: 'quiet' }, 'AWS IoT has not listed any board for this deployment yet.'))
      : [
          deployment.executions.length > 1
            ? h(
                'div',
                { class: 'deployment-summary', key: 'summary' },
                segments(countParts(deployment.counts), `Boards: ${countWords(deployment.counts)}.`, { thin: true }),
                countList(deployment.counts)
              )
            : null,
          h(
            'div',
            { class: 'executions', key: 'boards' },
            deployment.executions.map((execution) =>
              executionCard(execution, deployment, ctx, deployment.executions.length)
            )
          ),
        ]
  );
}

// Activity.

/** What the entries on this page are about. It only counts what has been loaded, and says so. */
function activityPanel(audit) {
  const { entries } = audit;
  const count = (test) => entries.filter(test).length;
  const action = (name) => (entry) => entry.action === name;
  const refused = count((entry) => entry.outcome !== 'ok');
  const said = [
    [count(action('firmware.upload')), 'upload', 'uploads'],
    [count(action('deployment.create')), 'deployment', 'deployments'],
    [count(action('deployment.cancel')), 'cancellation', 'cancellations'],
    [count(action('firmware.revoke')), 'revocation', 'revocations'],
    [count(action('firmware.bluetooth_send')), 'send over Bluetooth', 'sends over Bluetooth'],
    [count(action('serial.command')), 'command over USB', 'commands over USB'],
    [count(action('account.sign_in')), 'sign-in', 'sign-ins'],
  ].filter(([amount]) => amount > 0);
  return h(
    'p',
    { class: 'log-summary dotted', key: 'summary' },
    h(
      'span',
      { key: 'scope', class: 'log-scope' },
      audit.next
        ? `The latest ${plural(entries.length, 'entry', 'entries')}`
        : `${entries.length === 1 ? 'The only entry' : `All ${entries.length} entries`}`
    ),
    said.map(([amount, one, many]) => h('span', { key: one }, plural(amount, one, many))),
    refused > 0
      ? h(
          'span',
          { key: 'refused', class: 'status is-warn' },
          icon('alert', 'is-small'),
          `${refused} refused or failed`
        )
      : null
  );
}

/** The search and filters of the Activity page: what kind of thing was done, how it ended, and when. */
function activityFilters(ctx, audit) {
  const shown = audit?.entries.length ?? 0;
  let count = null;
  if (audit) {
    const more = audit.next ? ', more to look through' : '';
    count =
      audit.filtered && Number.isInteger(audit.read)
        ? `${shown} of ${plural(audit.read, 'entry', 'entries')} read match${more}`
        : `${plural(shown, 'entry', 'entries')} shown${audit.next ? ', more to load' : ''}`;
  }
  return filterBar(ctx, 'activity', {
    label: 'the activity log',
    placeholder: 'Search by person, version, board or request',
    count,
    controls: [
      filterSelect(ctx, 'activity', {
        name: 'kind',
        label: 'Kind',
        all: 'Every kind',
        options: ACTIVITY_KINDS.map((kind) => [kind.id, kind.label]),
      }),
      filterSelect(ctx, 'activity', {
        name: 'outcome',
        label: 'Outcome',
        all: 'Any outcome',
        options: [
          ['ok', 'Went through'],
          ['rejected', 'Refused'],
          ['denied', 'Not allowed'],
          ['error', 'Server error'],
        ].filter(([id]) => ACTIVITY_OUTCOMES.includes(id)),
      }),
      filterDay(ctx, 'activity', { name: 'from', label: 'From' }),
      filterDay(ctx, 'activity', { name: 'to', label: 'To' }),
    ],
  });
}

export function activityView(ctx) {
  const { state } = ctx;
  const audit = state.audit.value;
  const searched = audit?.filtered === true;
  const days = [];
  for (const entry of audit?.entries ?? []) {
    const label = dayLabel(entry.at, state.now);
    if (days.length === 0 || days[days.length - 1].label !== label) days.push({ label, entries: [] });
    days[days.length - 1].entries.push(entry);
  }

  let body;
  if (!audit) {
    body = pending(state.audit, 'activity');
  } else if (audit.entries.length === 0 && searched) {
    body = [
      noneMatch(ctx, 'activity', 'entries'),
      audit.next
        ? h(
            'div',
            { class: 'log-more', key: 'more' },
            h(
              'p',
              { class: 'quiet' },
              `None of the ${plural(audit.read ?? 0, 'entry', 'entries')} read so far match. Older ones are still to look through.`
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'btn',
                disabled: state.audit.loadingMore,
                onClick: ctx.actions.loadMoreActivity,
              },
              state.audit.loadingMore ? 'Looking…' : 'Look further back'
            )
          )
        : null,
    ];
  } else if (audit.entries.length === 0) {
    body = card(
      { key: 'none' },
      empty({
        iconName: 'list',
        title: 'Nothing has been recorded yet.',
        text:
          'Uploads, deployments, cancellations and revocations made through this console’s API will appear here, ' +
          'including attempts that were refused, and so will sign-ins and changes made to a board over USB.',
      })
    );
  } else {
    body = [
      activityPanel(audit),
      scriptedKey(audit.entries, ''),
      days.map((day) =>
        h(
          'section',
          { key: day.label, class: 'log-day' },
          h('h2', { class: 'log-day-title' }, day.label),
          h(
            'ul',
            { class: 'log' },
            day.entries.map((entry) => activityLine(entry, ctx, false))
          )
        )
      ),
      h(
        'div',
        { class: 'log-more', key: 'more' },
        audit.next
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn',
                disabled: state.audit.loadingMore,
                onClick: ctx.actions.loadMoreActivity,
              },
              state.audit.loadingMore ? 'Loading…' : 'Load more'
            )
          : h(
              'p',
              { class: 'quiet' },
              searched ? 'That is every entry that matches.' : 'That is every entry in this log.'
            ),
        state.audit.moreError ? failure('Could not load more.', state.audit.moreError) : null
      ),
    ];
  }
  return h(
    'div',
    { class: 'page' },
    pageHead({
      title: 'Activity',
      lede:
        'Every upload, deployment, cancellation and revocation made through this console’s API, with who asked ' +
        'for it and whether it went through; every sign-in, on the website or the phone app; and every change made to ' +
        'a board at its serial console from this console’s Serial page, by its name only. A job made directly in AWS IoT ' +
        'does not pass through that API, so it is not in this log, though its board’s page lists it. A deployment that ' +
        'is over shows how it ended. This console has no way to change an entry.',
      tools: freshness(state.audit, ctx),
    }),
    activityFilters(ctx, audit),
    loadProblem(state.audit, 'the activity log', ctx),
    body
  );
}

// API tokens: a person's own, for scripts. Any member may make them. A token does what
// its owner may do at the moment it is used, which the server asks Cognito each time, so
// the page is the same for a viewer and a release manager.

const TOKEN_LOOK = {
  active: ['good', 'check-circle', 'Active'],
  expired: ['idle', 'clock', 'Expired'],
  revoked: ['bad', 'ban', 'Revoked'],
};

/** A time still to come: how long until then, with the date and time as its tooltip. */
function until(iso, now) {
  const left = Date.parse(iso) - now;
  if (!(left > 0)) return h('time', { datetime: iso, title: exactTime(iso) }, dateAndTime(iso));
  return h('time', { datetime: iso, title: exactTime(iso) }, `in ${duration(left / 1000)}`);
}

function tokenRow(token, ctx) {
  const { now } = ctx.state;
  const [tone, iconName, label] = TOKEN_LOOK[token.status] ?? TOKEN_LOOK.expired;
  let life;
  if (token.status === 'revoked') life = ['Revoked ', when(token.revokedAt, now)];
  else if (token.status === 'expired') life = ['Expired ', when(token.expiresAt, now)];
  else life = ['Expires ', until(token.expiresAt, now), ` (${dateAndTime(token.expiresAt)})`];
  return h(
    'li',
    { key: token.id, class: `row token ${token.status === 'active' ? '' : 'is-over'}`.trim() },
    h(
      'div',
      { class: 'row-main' },
      h(
        'p',
        { class: 'row-title token-title' },
        h('span', { class: 'token-name' }, token.name),
        badge(tone, iconName, label)
      ),
      h(
        'p',
        { class: 'row-note dotted' },
        h('span', null, 'ID ', mono(token.id)),
        h('span', null, 'Made ', when(token.createdAt, now)),
        h('span', null, life)
      )
    ),
    token.status === 'active'
      ? h(
          'div',
          { class: 'token-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn is-small',
              'aria-label': `Revoke the token ${token.name}`,
              onClick: () => ctx.actions.openRevokeToken(token),
            },
            icon('ban'),
            'Revoke'
          )
        )
      : null
  );
}

/** How to use a token, said once on the page, with this console's own address. */
function tokenUsage(ctx) {
  const origin =
    typeof ctx.state.origin === 'string' && ctx.state.origin !== '' ? ctx.state.origin : 'https://<console>';
  return card(
    { key: 'use', title: 'Using a token' },
    h(
      'ul',
      { class: 'consequences token-usage' },
      h(
        'li',
        { key: 'how' },
        'Send it as ',
        mono('Authorization: Bearer crn_…'),
        ' to the API under ',
        mono('/api/t/'),
        ': ',
        mono('GET /api/t/firmware'),
        ' answers what ',
        mono('GET /api/firmware'),
        ' does for you here.'
      ),
      h(
        'li',
        { key: 'ota' },
        mono('scripts/firmware/ota.sh'),
        ' uses the token in ',
        mono('~/.cranium/console-token'),
        ' (readable by you alone: ',
        mono('chmod 600'),
        '), or in ',
        mono('CRANIUM_TOKEN'),
        '.'
      ),
      h(
        'li',
        { key: 'who' },
        'It acts as you, with what you may do at that moment: a viewer’s token only reads, and if your ' +
          'account loses a role or is disabled, its tokens lose it at once.'
      ),
      h(
        'li',
        { key: 'log' },
        'A change made with a token is in the activity log under your name, with the token’s ID. A token ' +
          'cannot make or revoke tokens, or read a board’s Bluetooth passkey.'
      )
    ),
    h(
      'code',
      { class: 'code token-example', key: 'example' },
      `curl -H "Authorization: Bearer $CRANIUM_TOKEN" ${origin}/api/t/me`
    )
  );
}

export function tokensView(ctx) {
  const { state, actions } = ctx;
  const listing = state.tokens.value;
  const active = listing ? listing.tokens.filter((token) => token.status === 'active').length : 0;
  const full = listing !== null && active >= listing.limit;
  const viewer = state.me?.canWrite === false;

  let body;
  if (!listing) {
    body = pending(state.tokens, 'your API tokens');
  } else if (listing.tokens.length === 0) {
    body = empty({
      iconName: 'key',
      title: 'You have no API tokens.',
      text: 'Make one for a script that should use the console as you, such as scripts/firmware/ota.sh.',
    });
  } else {
    const shown = filtered(ctx, 'tokens', listing.tokens, {
      words: (token) => [token.name, token.id],
      keep: (token, filters) => filters.status === '' || token.status === filters.status,
    });
    body = [
      filterBar(ctx, 'tokens', {
        label: 'your API tokens',
        placeholder: 'Search by name or ID',
        shown: shown.length,
        total: listing.tokens.length,
        controls: [
          filterSelect(ctx, 'tokens', {
            name: 'status',
            label: 'Status',
            all: 'Any status',
            options: [
              ['active', 'Active'],
              ['expired', 'Expired'],
              ['revoked', 'Revoked'],
            ],
          }),
        ],
      }),
      shown.length === 0
        ? h('p', { class: 'quiet filter-none', key: 'none' }, 'No tokens match. Try other words, or Clear.')
        : h(
            'ul',
            { class: 'rows token-list', key: 'list' },
            shown.map((token) => tokenRow(token, ctx))
          ),
    ];
  }

  return h(
    'div',
    { class: 'page', key: 'page' },
    developerTabs('tokens'),
    pageHead({
      title: 'API tokens',
      lede:
        'A token lets a script use this console’s API as you, without signing in, until it expires or ' +
        'you revoke it. Each person makes and sees only their own.',
      tools: freshness(state.tokens, ctx),
    }),
    loadProblem(state.tokens, 'your API tokens', ctx),
    card(
      { key: 'tokens', title: 'Your tokens' },
      h(
        'div',
        { class: 'token-head', key: 'head' },
        h(
          'p',
          { class: 'token-count' },
          listing ? `${plural(active, 'token', 'tokens')} in use, of the ${listing.limit} you may have.` : null,
          viewer ? ' You are a viewer, so your tokens can only read.' : null
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn is-primary',
            disabled: !listing || full,
            title: full ? 'Revoke a token you no longer use first.' : null,
            onClick: actions.openCreateToken,
          },
          icon('plus'),
          'New token'
        )
      ),
      body
    ),
    tokenUsage(ctx)
  );
}

// Dialogs. Each is a form inside a <dialog>. It acts when one of its buttons is used,
// never because Enter was pressed in a field, and every button says what it does.

function dialogFrame({ title, body, error, foot, onSubmit, onClose, busy }) {
  return h(
    'form',
    {
      class: 'dialog-form',
      method: 'dialog',
      // Where the keyboard goes if the control that had it is gone.
      tabindex: '-1',
      'data-focus-home': '',
      onKeydown: ignoreEnter,
      onSubmit(event) {
        event.preventDefault();
        if (onSubmit && !busy) onSubmit();
      },
    },
    h(
      'header',
      { class: 'dialog-head' },
      h('h2', { class: 'dialog-title', id: 'dialog-title' }, title),
      h(
        'button',
        {
          type: 'button',
          class: 'btn is-quiet is-icon',
          'aria-label': 'Close',
          disabled: busy,
          onClick: onClose,
        },
        icon('x')
      )
    ),
    h('div', { class: 'dialog-body' }, body),
    // What the server said to a request that failed stands outside the part that
    // scrolls, above the button that was used: in a small window it would otherwise
    // lie below what can be seen, and the dialog would seem to have done nothing.
    error ? h('div', { class: 'dialog-error', key: 'error' }, error) : null,
    h('footer', { class: 'dialog-foot' }, foot)
  );
}

/**
 * A button in the foot of a dialog. `submit` makes it the one the form acts on.
 * `sending` holds it back while its request is on its way, in a way that leaves it the
 * keyboard's focus: a button that is disabled loses it, and a failure would then be
 * reported to a keyboard that is nowhere.
 */
function dialogButton(options, ...label) {
  const {
    key,
    className = '',
    submit = false,
    disabled = false,
    sending = false,
    autofocus = false,
    describedBy = null,
    onClick,
  } = options;
  return h(
    'button',
    {
      key,
      type: submit ? 'submit' : 'button',
      class: `btn ${className}`.trim(),
      disabled,
      autofocus,
      'aria-disabled': sending ? 'true' : null,
      'aria-describedby': describedBy,
      onClick,
    },
    label
  );
}

const SPACER = () => h('span', { class: 'dialog-spacer', key: 'spacer' });

function consequences(items) {
  return h(
    'ul',
    { class: 'consequences' },
    items.filter(Boolean).map((item, index) => h('li', { key: String(index) }, item))
  );
}

function choice({ key, type, name, checked, disabled = false, onChange }, title, ...notes) {
  return h(
    'label',
    { key, class: `choice ${disabled ? 'is-disabled' : ''}`.trim() },
    h('input', { type, name, checked, disabled, onChange }),
    h('span', { class: 'choice-body' }, h('span', { class: 'choice-title' }, title), notes)
  );
}

const WIZARD_STEPS = ['Release', 'Boards', 'Review'];

function wizardRelease(release, model, now) {
  return choice(
    {
      key: release.version,
      type: 'radio',
      name: 'release',
      checked: release.version === model.version,
      onChange: () => model.choose(release.version),
    },
    mono(release.version),
    h(
      'span',
      { class: 'choice-note' },
      fileSize(release.size),
      ' · uploaded ',
      when(release.uploadedAt, now),
      ' by ',
      who(release.uploadedBy)
    ),
    release.notes ? h('span', { class: 'choice-note' }, release.notes) : null
  );
}

function willRefuse() {
  return h(
    'span',
    { class: 'choice-warning' },
    icon('alert', 'is-small'),
    h('span', null, 'Reports that it already runs this version or a newer one, so it will refuse the offer.')
  );
}

function wizardBoard(device, model, now) {
  const busy = model.busy.get(device.thing) ?? null;
  const chosen = model.things.has(device.thing);

  // Said for every board, ticked or not: it is what the choice is made by.
  let remark = null;
  if (busy) {
    remark = h(
      'span',
      { class: 'choice-warning' },
      icon('lock', 'is-small'),
      h(
        'span',
        null,
        'Has an unfinished update',
        busy.version ? [' to ', mono(busy.version)] : null,
        '. Finish or cancel ',
        linkTo(deploymentHref(busy.deployment), null, 'that deployment'),
        ' first.'
      )
    );
  } else if (alreadyRuns(device, model.version)) {
    remark = willRefuse();
  } else if (!device.online && !device.lastSeen) {
    remark = h(
      'span',
      { class: 'choice-hint' },
      `It will see the offer when it first connects. ${NEVER_REPORTED_HELP}`
    );
  } else if (!device.online) {
    remark = h('span', { class: 'choice-hint' }, 'Offline: it will see the offer when it reconnects.');
  }
  return choice(
    {
      key: device.thing,
      type: 'checkbox',
      checked: chosen,
      disabled: Boolean(busy),
      onChange: () => model.toggle(device.thing),
    },
    [mono(boardName(device)), boardThing(device), presence(device, now)],
    h(
      'span',
      { class: 'choice-note' },
      device.fw ? [device.online ? 'Runs ' : 'Last reported ', mono(device.fw.version)] : 'Has not reported a version',
      device.online || !device.lastSeen ? null : [' · last seen ', when(device.lastSeen, now)]
    ),
    remark
  );
}

/** For more than one board: how the staged rollout goes, and the numbers that steer it. */
function stagedChoices(model, chosen) {
  const most = Math.min(5, chosen.length - 1);
  const number = (key, label, value, min, max, set, unit) =>
    h(
      'label',
      { class: 'field is-inline', key },
      h('span', { class: 'field-label' }, label),
      h('input', {
        class: 'input is-number',
        type: 'number',
        min: String(min),
        max: String(max),
        step: '1',
        value: String(value),
        onInput: (event) => {
          const read = Number(event.target.value);
          if (Number.isInteger(read) && read >= min && read <= max) set(read);
        },
      }),
      unit ? h('span', { class: 'quiet' }, unit) : null
    );
  return h(
    'div',
    { class: 'staged-choices', key: 'staged' },
    number('canary', 'Canary boards', Math.min(model.canary, most), 1, most, model.setCanary, null),
    number('stages', 'Stages after it', model.stages ?? 1, 1, 10, model.setStages, null),
    number('soak', 'Wait between stages', model.soakMinutes ?? 0, 0, 60, model.setSoakMinutes, 'min'),
    number('abort', 'Stop when failures reach', model.abortPercent, 1, 100, model.setAbortPercent, '%'),
    // The health gate (docs/fleet.md): on by default; 0 to 120 minutes.
    choice(
      {
        key: 'gate',
        type: 'checkbox',
        name: 'health-gate',
        checked: model.healthGate !== false,
        onChange: (event) => model.setHealthGate?.(event.target.checked),
      },
      'Health gate',
      h('span', { class: 'choice-note' }, 'No new Memfault issue and no unexpected reboot before the next stage')
    ),
    model.healthGate !== false
      ? number('gate-minutes', 'Watch for', model.gateMinutes ?? 10, 0, 120, model.setGateMinutes ?? (() => {}), 'min')
      : null
  );
}

function wizardReview(model, release, chosen, now) {
  const staged = chosen.length > 1 && model.staged;
  const offline = chosen.filter((device) => !device.online && device.lastSeen).length;
  const never = chosen.filter((device) => !device.online && !device.lastSeen).length;
  const asking = chosen.filter(asksForButton).length;
  return [
    facts([
      [
        'Release',
        mono(model.version, 'fact-strong'),
        release ? factNote(`${fileSize(release.size)} · SHA-256 ${release.sha256.slice(0, 12)}…`) : null,
      ],
      [
        'Boards',
        h(
          'ul',
          { class: 'plain-list' },
          chosen.map((device) =>
            h(
              'li',
              { key: device.thing, class: 'board-pick' },
              mono(boardName(device)),
              boardThing(device),
              presence(device, now),
              alreadyRuns(device, model.version) ? willRefuse() : null
            )
          )
        ),
      ],
    ]),
    h(
      'label',
      { class: 'field', key: 'note' },
      h(
        'span',
        { class: 'field-label' },
        'Note ',
        h('span', { class: 'quiet' }, '(optional, shown with the deployment)')
      ),
      h('input', {
        class: 'input',
        type: 'text',
        maxlength: '200',
        value: model.note,
        onInput: (event) => model.setNote(event.target.value),
      })
    ),
    staged ? stagedChoices(model, chosen) : null,
    h(
      'div',
      { class: 'callout', key: 'what' },
      h('p', { class: 'callout-title' }, 'What happens when you deploy'),
      consequences([
        staged
          ? [
              `A staged rollout: ${plural(Math.min(model.canary, chosen.length - 1), 'board gets', 'boards get')} `,
              mono(model.version),
              ' first. The rest follow only once that canary has confirmed it, ' +
                ((model.stages ?? 1) > 1
                  ? `in ${model.stages} stages, each to all its boards at once and each only once the one before has ended` +
                    `${(model.soakMinutes ?? 0) > 0 ? ` and ${plural(model.soakMinutes, 'minute')} have passed` : ''}. `
                  : 'all at once. ') +
                (model.healthGate !== false
                  ? `Before each next stage the boards so far run it for ${plural(model.gateMinutes ?? 10, 'minute')} ` +
                    'with no new Memfault issue and no unexpected reboot, or it stops. '
                  : '') +
                `It stops by itself, before what has not started, once ${model.abortPercent}% ` +
                'of the boards that finished have failed.',
            ]
          : null,
        [
          'Each board gets ',
          mono(model.version),
          `. Firmware ${FIRST_WITH_NO_BUTTON} or newer installs it as soon as the board sees it, with nobody at the board.`,
        ],
        asking > 0
          ? `${plural(asking, 'board runs', 'boards run')} older firmware, which installs nothing until ` +
            'someone presses Button 1 on the board; Button 2 declines.'
          : null,
        offline > 0
          ? `${plural(offline, 'board is', 'boards are')} offline and will see the update after ` +
            'reconnecting. It stays open until it is cancelled.'
          : 'It stays open until a board acts on it or the deployment is cancelled.',
        never > 0
          ? `${plural(never, 'board has', 'boards have')} never connected and will see the update ` +
            `when first connected. ${NEVER_REPORTED_HELP}`
          : null,
        'A board checks the download and its bootloader checks the signature. If the new firmware ' +
          'cannot reconnect, the bootloader puts the previous one back.',
        'These boards cannot be given another deployment until this one has finished or been cancelled.',
      ])
    ),
  ];
}

/**
 * Where the boards are held up that the server named when it refused a deployment. Its
 * own sentence names a single board, by its thing name; with several it only gives their number.
 */
function heldBy(entries, devices) {
  const where = (entry) => {
    const version = versionOfDeployment(entry.deployment);
    return linkTo(
      deploymentHref(entry.deployment),
      null,
      version ? ['the deployment of ', mono(version)] : 'another deployment'
    );
  };
  if (entries.length === 1) {
    const board = boardOf(entries[0].thing, devices);
    const named = boardName(board) !== board.thing;
    return h(
      'p',
      { class: 'notice-more' },
      'That update',
      named ? [' on ', mono(boardName(board))] : null,
      ' is ',
      where(entries[0]),
      '.'
    );
  }
  return h(
    'ul',
    { class: 'plain-list notice-more' },
    entries.map((entry) => {
      const board = boardOf(entry.thing, devices);
      return h(
        'li',
        { key: `${entry.thing} ${entry.deployment}` },
        mono(boardName(board)),
        boardThing(board),
        ': ',
        where(entry)
      );
    })
  );
}

export function deployDialog(model, ctx) {
  const { now } = ctx.state;
  const releases = model.releases ?? [];
  const release = releases.find((candidate) => candidate.version === model.version) ?? null;
  // Only the boards of the release's type that can take a job (docs/fleet.md); the others are counted.
  const devices = offeredBoards(model.devices ?? [], model.types, release);
  const notOffered = (model.devices ?? []).length - devices.length;
  model.staged = Boolean(ctx.fleet);
  const chosen = devices.filter((device) => model.things.has(device.thing));
  const free = devices.filter((device) => !model.busy.has(device.thing));
  // "All" leaves out what would only refuse: that takes a tick of its own.
  const selectable = free.filter((device) => !alreadyRuns(device, model.version));
  const ready = !model.loading && !model.loadError;
  // The release this dialog was opened for has been revoked in the meantime. It says so
  // and leaves the choice to the reader: another release is not what was asked for.
  const gone =
    ready && model.gone
      ? notice('warn', 'alert', [
          h('strong', null, mono(model.gone), ' has been revoked'),
          ', so it cannot be deployed any more.',
          releases.length > 0 ? ' Choose another release if you want to deploy one.' : null,
        ])
      : null;

  let body;
  if (model.loading) {
    body = loading('releases and boards');
  } else if (model.loadError) {
    body = notice(
      'bad',
      'alert',
      [h('strong', null, 'Could not load what a deployment needs. '), sentence(model.loadError.message)],
      { more: problemRef(model.loadError), action: button('is-small', model.reload, 'Try again') }
    );
  } else if (model.step === 0 && releases.length === 0) {
    body = [
      gone,
      empty({
        iconName: 'package',
        title: 'There is no release to deploy.',
        text: 'Upload a signed image on the Firmware page first. Revoked releases cannot be deployed.',
        // The dialog closes by itself when the page changes, but not if this is the Firmware page.
        action: { href: '#/firmware', label: 'Go to Firmware', onClick: model.close },
      }),
    ];
  } else if (model.step === 0) {
    body = [
      gone,
      h(
        'fieldset',
        { class: 'choices', key: 'releases' },
        h('legend', null, 'Which release?'),
        releases.map((candidate) => wizardRelease(candidate, model, now))
      ),
    ];
  } else if (model.step === 1 && devices.length === 0 && notOffered > 0) {
    body = empty({
      iconName: 'chip',
      title: `No board can take ${model.version}.`,
      text:
        `It is for the ${boardTypeLabel(release?.board)} with flash layout ${release?.layout ?? 1}, and none is registered ` +
        'that can take it over the internet. ' +
        'A board without Wi-Fi updates over Bluetooth from the phone app.',
    });
  } else if (model.step === 1 && devices.length === 0) {
    body = empty(NO_BOARDS);
  } else if (model.step === 1) {
    body = h(
      'fieldset',
      { class: 'choices' },
      h('legend', null, 'Which boards get ', mono(model.version), '?'),
      notOffered > 0
        ? h(
            'p',
            { class: 'choice-hint', key: 'types' },
            `For the ${boardTypeLabel(release?.board)}, layout ${release?.layout ?? 1}, only: `,
            `${plural(notOffered, 'board', 'boards')} of another type or flash layout, or without Wi-Fi, ` +
              `${notOffered === 1 ? 'is' : 'are'} not offered it.`
          )
        : null,
      devices.map((device) => wizardBoard(device, model, now)),
      selectable.length > 1
        ? button(
            'is-small is-quiet',
            model.toggleAll,
            selectable.every((device) => model.things.has(device.thing))
              ? 'Clear the selection'
              : `Select all ${selectable.length} available boards`
          )
        : null
    );
  } else {
    body = wizardReview(model, release, chosen, now);
  }

  const refusedBoards = model.error ? busyBoards(model.error) : [];
  const last = model.step === WIZARD_STEPS.length - 1;
  const canGoOn = model.step === 0 ? release !== null : chosen.length > 0;
  // Why "Next" cannot be used yet, said next to it.
  let hint = null;
  if (ready && model.step === 0 && releases.length > 0 && !release) {
    hint = 'Choose a release.';
  } else if (ready && model.step === 1 && devices.length > 0 && chosen.length === 0) {
    hint = free.length === 0 ? 'Every board has an unfinished update.' : 'Choose at least one board.';
  }
  return dialogFrame({
    title: 'New deployment',
    busy: model.sending,
    onClose: model.close,
    onSubmit: last ? model.submit : canGoOn ? model.next : null,
    body: [
      h(
        'ol',
        { class: 'wizard-steps', key: 'steps' },
        WIZARD_STEPS.map((label, index) =>
          h(
            'li',
            {
              key: label,
              class: index === model.step ? 'is-current' : index < model.step ? 'is-done' : null,
              'aria-current': index === model.step ? 'step' : null,
            },
            h('span', { class: 'wizard-number' }, index < model.step ? icon('check') : String(index + 1)),
            label,
            index < model.step ? h('span', { class: 'sr-only' }, ' (done)') : null
          )
        )
      ),
      // Each step takes the focus when it appears, so the keyboard starts at its top.
      // Its name is what a screen reader says on arriving there.
      h(
        'div',
        {
          class: 'wizard-body',
          key: `step-${model.step}`,
          role: 'group',
          'aria-label': `Step ${model.step + 1} of ${WIZARD_STEPS.length}: ${WIZARD_STEPS[model.step]}`,
          tabindex: '-1',
          autofocus: true,
          ref(el) {
            el.focus({ preventScroll: true });
            el.parentElement.scrollTop = 0;
          },
        },
        body
      ),
    ],
    error: model.error
      ? failure(
          'The deployment was not started.',
          model.error,
          refusedBoards.length > 0 ? heldBy(refusedBoards, devices) : null,
          model.signIn
        )
      : null,
    foot: [
      dialogButton({ key: 'cancel', disabled: model.sending, onClick: model.close }, 'Cancel'),
      SPACER(),
      hint ? h('span', { class: 'dialog-hint', id: 'dialog-hint', key: 'hint' }, hint) : null,
      model.step > 0 ? dialogButton({ key: 'back', disabled: model.sending, onClick: model.back }, 'Back') : null,
      last
        ? dialogButton(
            {
              key: 'go',
              className: 'is-primary',
              submit: true,
              disabled: chosen.length === 0,
              sending: model.sending,
            },
            icon('send'),
            model.sending
              ? 'Starting…'
              : chosen.length > 1 && model.staged
                ? `Start staged rollout to ${plural(chosen.length, 'board')}`
                : `Deploy to ${plural(chosen.length, 'board')}`
          )
        : dialogButton(
            {
              key: 'next',
              className: 'is-primary',
              submit: true,
              disabled: model.loading || !canGoOn,
              describedBy: hint ? 'dialog-hint' : null,
            },
            'Next'
          ),
    ],
  });
}

function cancelLabel({ sending, withdrawn, force }) {
  if (withdrawn) return sending ? 'Stopping…' : 'Stop boards';
  if (sending) return 'Cancelling…';
  return force ? 'Cancel and stop boards' : 'Cancel the deployment';
}

/**
 * The dialog counts from the newest record of the deployment there is, so that it says
 * what is true after somebody else has cancelled, or after the last board has finished.
 */
export function cancelDialog(model) {
  const { deployment } = model;
  const count = (status) => deployment.executions.filter((execution) => execution.status === status).length;
  const waiting = count('QUEUED');
  const started = count('IN_PROGRESS');
  const over = waiting + started === 0;
  // Cancelled before, without force: the offer is withdrawn already, and the one thing
  // left to do is to stop the boards that had started.
  const withdrawn = !over && deployment.status === 'CANCELED';
  const force = model.force || withdrawn;
  const option = (value, title, text, done = false) =>
    choice(
      {
        key: String(value),
        type: 'radio',
        name: 'force',
        checked: force === value,
        disabled: model.sending || done,
        onChange: () => model.setForce(value),
      },
      title,
      h('span', { class: 'choice-note' }, text)
    );

  const version = mono(deployment.version ?? 'this release');
  return dialogFrame({
    title: withdrawn
      ? ['Stop the boards that are installing ', version, '?']
      : ['Cancel the deployment of ', version, '?'],
    busy: model.sending,
    onClose: model.close,
    onSubmit: over ? null : () => model.submit(force),
    body: [
      over
        ? h(
            'p',
            { key: 'now' },
            h('strong', null, 'Nothing is left to cancel.'),
            ' No board is waiting for this update any more, and none is installing it.'
          )
        : h(
            'p',
            { key: 'now' },
            'Right now ',
            h('strong', null, plural(waiting, 'board is', 'boards are'), ' waiting'),
            ' and ',
            h('strong', null, plural(started, 'board has', 'boards have'), ' started'),
            '. Boards that already finished are not affected.'
          ),
      over
        ? null
        : h(
            'fieldset',
            { class: 'choices', key: 'choices' },
            h('legend', null, 'How far should the cancellation go?'),
            withdrawn
              ? option(
                  false,
                  'Withdraw the offer',
                  'Done already: this deployment was cancelled before, so boards that had not started ' +
                    'are no longer offered it.',
                  true
                )
              : option(
                  false,
                  'Withdraw the offer',
                  'Boards that have not started are no longer offered this update. A board that is ' +
                    'already downloading or installing carries on and finishes.'
                ),
            option(
              true,
              'Withdraw the offer and stop boards that have started',
              'Forced. A board that is downloading or checking the image stops before installing, because ' +
                'it asks AWS first and finds the update cancelled. A board that is already restarting into ' +
                'the new firmware cannot be stopped; it may still finish, but it can no longer report the ' +
                'result here.'
            )
          ),
      over
        ? null
        : h(
            'p',
            { class: 'quiet', key: 'eventually' },
            'A cancellation takes a few seconds to reach every board’s record. It cannot be undone; ',
            'to try again, start a new deployment.'
          ),
    ],
    // With nothing left to cancel, an earlier refusal to do so has nothing more to say.
    error:
      model.error && !over
        ? failure(withdrawn ? 'The boards were not stopped.' : 'Not cancelled.', model.error, null, model.signIn)
        : null,
    foot: [
      dialogButton(
        { key: 'keep', autofocus: true, disabled: model.sending, onClick: model.close },
        over || withdrawn ? 'Close' : 'Keep the deployment'
      ),
      SPACER(),
      dialogButton(
        {
          key: 'go',
          className: 'is-danger',
          submit: true,
          disabled: over,
          sending: model.sending,
        },
        cancelLabel({ sending: model.sending, withdrawn, force })
      ),
    ],
  });
}

const REASON_LIMIT = 200;
// From here on the field says how much room is left, so that a sentence is not cut short unseen.
const REASON_COUNT_FROM = 160;

/** What the two steps after the mark do: the same for a first revocation and for a repeated one. */
function revocationSteps(release) {
  return [
    'The image stops downloading at once, also for a board that is in the middle of downloading it.',
    [
      'Every unfinished deployment of ',
      mono(release.version),
      ' is cancelled, including on boards that have already started. They stop before installing.',
    ],
  ];
}

/**
 * Revoking a release that is revoked already: the mark is on record, and the steps
 * after it are repeated. This finishes a revocation that stopped half way.
 */
function revokeAgainDialog(model, ctx) {
  const { release } = model;
  const open = revocationState(release) === 'incomplete';
  const mark = release.revoked;
  let label = open ? 'Finish revoking' : 'Apply again';
  if (model.sending) label = open ? 'Finishing…' : 'Applying…';
  return dialogFrame({
    title: open
      ? ['Finish revoking ', mono(release.version), '?']
      : ['Apply the revocation of ', mono(release.version), ' again?'],
    busy: model.sending,
    onClose: model.close,
    onSubmit: model.submit,
    body: [
      h(
        'p',
        { key: 'lead' },
        open
          ? 'This release is marked revoked, but the server has not recorded that the two steps after ' +
              'the mark were completed. Finishing repeats them:'
          : 'This release is revoked. Applying the revocation again repeats the two steps after the ' +
              'mark, in case one of them did not go through:'
      ),
      consequences(revocationSteps(release)),
      mark
        ? h(
            'p',
            { class: 'release-revoked', key: 'record' },
            icon('ban', 'is-small'),
            h(
              'span',
              null,
              'Revoked ',
              when(mark.at, ctx.state.now),
              ' by ',
              who(mark.by),
              mark.reason ? ': ' : null,
              mark.reason
            )
          )
        : null,
      h('p', { class: 'quiet', key: 'same' }, 'That record stays as it is: who revoked the release, when and why.'),
    ],
    error: model.error ? failure(open ? 'Not finished.' : 'Not applied.', model.error, null, model.signIn) : null,
    foot: [
      dialogButton({ key: 'keep', disabled: model.sending, onClick: model.close }, 'Close'),
      SPACER(),
      dialogButton(
        {
          key: 'go',
          className: 'is-primary',
          submit: true,
          autofocus: true,
          sending: model.sending,
        },
        icon('ban'),
        label
      ),
    ],
  });
}

export function revokeDialog(model, ctx) {
  if (model.again) return revokeAgainDialog(model, ctx);
  const { release } = model;
  const reason = singleLine(model.reason);
  const { length } = model.reason;
  return dialogFrame({
    title: ['Revoke ', mono(release.version), '?'],
    busy: model.sending,
    onClose: model.close,
    onSubmit: reason ? model.submit : null,
    body: [
      h(
        'p',
        { key: 'lead' },
        'Revoking withdraws a release for good. Use it when an image must not be installed any more.'
      ),
      consequences([
        ...revocationSteps(release),
        'It can never be deployed again, and its version number stays used: the next upload must ' + 'still be newer.',
        [
          'Boards that already run ',
          mono(release.version),
          ' keep running it. To replace it there, upload a newer version and deploy that.',
        ],
        'This cannot be undone.',
      ]),
      h(
        'label',
        { class: 'field', key: 'reason' },
        h('span', { class: 'field-label' }, 'Reason ', h('span', { class: 'quiet' }, '(required)')),
        h('textarea', {
          class: 'input',
          rows: '2',
          maxlength: String(REASON_LIMIT),
          required: true,
          // Not on a touch screen, where the keyboard would cover the consequences
          // before they have been read; there the dialog opens on "Keep the release".
          autofocus: model.focusReason,
          disabled: model.sending,
          value: model.reason,
          onInput: (event) => model.setReason(event.target.value),
        }),
        h(
          'span',
          { class: 'field-hint' },
          `Recorded in the activity log and shown next to the release. Up to ${REASON_LIMIT} characters.`,
          length >= REASON_COUNT_FROM
            ? [
                ' ',
                h(
                  'span',
                  { class: `field-count ${length >= REASON_LIMIT ? 'is-full' : ''}`.trim() },
                  `${length} / ${REASON_LIMIT}`
                ),
              ]
            : null
        )
      ),
    ],
    error: model.error ? failure('Not revoked.', model.error, null, model.signIn) : null,
    foot: [
      dialogButton(
        {
          key: 'keep',
          autofocus: !model.focusReason,
          disabled: model.sending,
          onClick: model.close,
        },
        'Keep the release'
      ),
      SPACER(),
      // The field can lie below what can be seen, and the button stands in view.
      reason ? null : h('span', { class: 'dialog-hint', id: 'dialog-hint', key: 'hint' }, 'Give a reason first.'),
      dialogButton(
        {
          key: 'go',
          className: 'is-danger',
          submit: true,
          disabled: !reason,
          sending: model.sending,
          describedBy: reason ? null : 'dialog-hint',
        },
        icon('ban'),
        model.sending ? 'Revoking…' : ['Revoke ', release.version]
      ),
    ],
  });
}

/**
 * Making an API token: a name and a lifetime, then the token itself, once. Once it is
 * shown, only the dialog's own buttons close it: Escape or a click beside it would lose
 * a token that cannot be shown again.
 */
// A release's note: what it changed, one line of up to 500 characters, for every release.
const NOTES_LIMIT = 500;

export function notesDialog(model) {
  const { release } = model;
  const left = NOTES_LIMIT - model.notes.length;
  return dialogFrame({
    title: ['The note of ', mono(release.version)],
    busy: model.sending,
    onClose: model.close,
    onSubmit: model.submit,
    body: [
      h(
        'p',
        { class: 'dialog-lede', key: 'lede' },
        'What this release changed, in a sentence or two. It is shown with the release on the Firmware page and in the ' +
          'phone apps. Leave it empty for no note.'
      ),
      h(
        'label',
        { class: 'field', key: 'notes' },
        h('span', { class: 'field-label' }, 'Note'),
        h('textarea', {
          class: 'input is-notes',
          rows: '4',
          maxlength: String(NOTES_LIMIT),
          value: model.notes,
          autofocus: true,
          onInput: (event) => model.setNotes(event.target.value),
        }),
        h(
          'span',
          { class: `field-count ${left < 40 ? 'is-low' : ''}`.trim(), 'aria-live': 'polite' },
          `${left} characters left`
        )
      ),
    ],
    error: model.error ? failure('The note was not saved.', model.error, null, model.signIn) : null,
    foot: [
      dialogButton({ key: 'cancel', disabled: model.sending, onClick: model.close }, 'Cancel'),
      SPACER(),
      dialogButton(
        { key: 'save', className: 'is-primary', submit: true, sending: model.sending },
        icon('check'),
        model.sending ? 'Saving…' : 'Save note'
      ),
    ],
  });
}

export function createTokenDialog(model, ctx) {
  if (model.made) return madeTokenDialog(model, ctx);
  const name = model.name.trim();
  const days = tokenDays(model.days);
  let hint = null;
  if (name === '') hint = 'Give it a name first.';
  else if (days === null) hint = `Choose ${TOKEN_DAYS.least} to ${TOKEN_DAYS.most} days.`;
  return dialogFrame({
    title: 'New API token',
    busy: model.sending,
    onClose: model.close,
    onSubmit: hint ? null : model.submit,
    body: [
      h(
        'p',
        { key: 'lead' },
        'A script that has this token can use the console’s API as you, with what you may do at that moment.'
      ),
      h(
        'label',
        { class: 'field', key: 'name' },
        h('span', { class: 'field-label' }, 'Name ', h('span', { class: 'quiet' }, '(required)')),
        h('input', {
          class: 'input',
          type: 'text',
          maxlength: String(TOKEN_NAME_LIMIT),
          autofocus: true,
          disabled: model.sending,
          value: model.name,
          onInput: (event) => model.setName(event.target.value),
        }),
        h(
          'span',
          { class: 'field-hint' },
          `What it is for: the computer or the script that uses it. Up to ${TOKEN_NAME_LIMIT} characters.`
        )
      ),
      h(
        'label',
        { class: 'field', key: 'days' },
        h('span', { class: 'field-label' }, 'Valid for, in days'),
        h('input', {
          class: 'input token-days',
          type: 'number',
          inputmode: 'numeric',
          min: String(TOKEN_DAYS.least),
          max: String(TOKEN_DAYS.most),
          step: '1',
          disabled: model.sending,
          value: model.days,
          onInput: (event) => model.setDays(event.target.value),
        }),
        h(
          'span',
          { class: 'field-hint' },
          `From ${TOKEN_DAYS.least} to ${TOKEN_DAYS.most}. A token cannot be extended: make a new one when it runs out.`
        )
      ),
    ],
    error: model.error ? failure('No token was made.', model.error, null, model.signIn) : null,
    foot: [
      dialogButton({ key: 'keep', disabled: model.sending, onClick: model.close }, 'Cancel'),
      SPACER(),
      hint ? h('span', { class: 'dialog-hint', id: 'dialog-hint', key: 'hint' }, hint) : null,
      dialogButton(
        {
          key: 'go',
          className: 'is-primary',
          submit: true,
          disabled: Boolean(hint),
          sending: model.sending,
          describedBy: hint ? 'dialog-hint' : null,
        },
        icon('key'),
        model.sending ? 'Making…' : 'Make token'
      ),
    ],
  });
}

function madeTokenDialog(model, ctx) {
  const { made } = model;
  return dialogFrame({
    title: 'Your new API token',
    busy: false,
    onClose: model.close,
    onSubmit: model.close,
    body: [
      notice('warn', 'alert', [
        h('strong', null, 'Copy it now: you won’t see this token again. '),
        'The console keeps only a digest of it, from which it cannot be read back.',
      ]),
      h(
        'div',
        { class: 'token-secret', key: 'secret' },
        h('code', { class: 'code token-value' }, made.token),
        copyButton(made.token, 'the token', ctx)
      ),
      facts([
        ['Name', made.name],
        ['ID', mono(made.id), factNote('How the list and the activity log name it.')],
        ['Expires', made.expiresAt ? dateAndTime(made.expiresAt) : '—'],
      ]),
      h(
        'p',
        { key: 'keep' },
        'Keep it like a password. For ',
        mono('scripts/firmware/ota.sh'),
        ', put it in ',
        mono('~/.cranium/console-token'),
        ' and make that file readable by you alone, for example on a Mac after copying:'
      ),
      h(
        'code',
        { class: 'code', key: 'save' },
        'mkdir -p ~/.cranium && (umask 077 && pbpaste > ~/.cranium/console-token)'
      ),
    ],
    foot: [SPACER(), dialogButton({ key: 'done', className: 'is-primary', submit: true, autofocus: true }, 'Done')],
  });
}

export function revokeTokenDialog(model, ctx) {
  const { token } = model;
  const { now } = ctx.state;
  return dialogFrame({
    title: ['Revoke the token ', h('span', { class: 'token-name' }, `“${token.name}”`), '?'],
    busy: model.sending,
    onClose: model.close,
    onSubmit: model.submit,
    body: [
      facts([
        ['ID', mono(token.id)],
        ['Made', when(token.createdAt, now)],
        ['Expires', until(token.expiresAt, now)],
      ]),
      consequences([
        'A script that uses it is refused from its next request on.',
        'What it has done stays done, and stays in the activity log.',
        'This cannot be undone. A script that still needs access needs a new token.',
      ]),
    ],
    error: model.error ? failure('Not revoked.', model.error, null, model.signIn) : null,
    foot: [
      dialogButton({ key: 'keep', autofocus: true, disabled: model.sending, onClick: model.close }, 'Keep the token'),
      SPACER(),
      dialogButton(
        { key: 'go', className: 'is-danger', submit: true, sending: model.sending },
        icon('ban'),
        model.sending ? 'Revoking…' : 'Revoke token'
      ),
    ],
  });
}

// The map, commands and alerts (docs/fleet.md): a command to a board from its row and its page, the
// board's answer as its log brings it, and where the board is. The Map and Account pages draw with
// these same pieces (map.js, account.js); the maps themselves are drawn by map.js once it is loaded.

/** What this page knows of the last command sent to a board (app.js), or null. */
function commandOf(ctx, thing) {
  return ctx.state.commands?.get(thing) ?? null;
}

/**
 * Identify: the board blinks its two LEDs for 15 s, so that a person at a bench of boards can tell
 * which one it is. For release managers, and for a board that connects to AWS IoT; an offline one
 * would miss it, so the button says so instead.
 */
function identifyButton(device, ctx, { compact = false } = {}) {
  if (ctx.state.me?.canWrite !== true || !canCommand(device)) return null;
  const name = boardName(device, { short: true });
  const busy = commandOf(ctx, device.thing)?.status === 'sending';
  return h(
    'button',
    {
      type: 'button',
      key: 'identify',
      class: compact ? 'btn is-quiet is-icon identify-button' : 'btn is-small identify-button',
      disabled: busy || !device.online,
      title: device.online
        ? `Blink the lights of ${name} for 15 s`
        : `${name} is offline, so it would miss the command`,
      'aria-label': compact ? `Identify ${name}` : null,
      onClick: () => ctx.actions.identify(device.thing),
    },
    icon('locate'),
    compact ? null : 'Identify'
  );
}

/** The tools of a board's page: Identify, and a menu with Report now. */
/** Show QR / Print label on a board's page: its code and sticker (labels.js, docs/new-board-setup.md). */
function labelButton(thing, ctx) {
  const shown = ctx.state.labelShown === thing;
  return h(
    'button',
    {
      type: 'button',
      class: 'btn is-small',
      key: 'label',
      'aria-expanded': shown ? 'true' : 'false',
      onClick: () => ctx.actions.toggleLabel(thing),
    },
    shown ? 'Hide QR' : 'Show QR / Print label'
  );
}

function commandTools(device, ctx) {
  const identify = identifyButton(device, ctx);
  if (identify === null) return null;
  const busy = commandOf(ctx, device.thing)?.status === 'sending';
  return h(
    'div',
    { class: 'board-commands', key: 'commands' },
    identify,
    h(
      'details',
      { class: 'menu', key: 'menu' },
      h(
        'summary',
        {
          class: 'btn is-small is-icon',
          title: 'More',
          'aria-label': `More for ${boardName(device, { short: true })}`,
        },
        icon('more')
      ),
      h(
        'div',
        { class: 'menu-list', role: 'group' },
        h(
          'button',
          {
            type: 'button',
            class: 'menu-item',
            key: 'report',
            disabled: busy || !device.online,
            onClick: (event) => {
              event.currentTarget?.closest?.('details')?.removeAttribute?.('open');
              ctx.actions.reportNow(device.thing);
            },
          },
          icon('send'),
          h(
            'span',
            null,
            'Report now',
            h('span', { class: 'menu-note' }, 'Heartbeat, diagnostics and a Wi-Fi scan, at once')
          )
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'menu-item',
            key: 'memfault',
            disabled: busy || !device.online,
            onClick: (event) => {
              event.currentTarget?.closest?.('details')?.removeAttribute?.('open');
              ctx.actions.memfaultNow(device.thing);
            },
          },
          icon('send'),
          h(
            'span',
            null,
            'Send Memfault data now',
            h(
              'span',
              { class: 'menu-note' },
              'A Memfault heartbeat, and all it holds for Memfault, from firmware 1.14.0'
            )
          )
        )
      )
    )
  );
}

const COMMAND_TITLES = { identify: 'Identify', report: 'Report now', memfault: 'Send Memfault data now' };

/**
 * Whether the board's Memfault data reaches Memfault (docs/memfault.md): a project key stored in AWS, and
 * firmware 1.14.0 or later, which sends it over AWS IoT. With the link to the board in Memfault when the
 * console knows the organization's and the project's slugs. Nothing for a board that never reaches AWS IoT,
 * or from a server that says nothing of Memfault.
 */
function memfaultCard(device, memfault) {
  if (memfault === null || device.location?.bluetoothOnly) return null;
  let line;
  if (!memfault.keyStored) {
    line = [
      h('strong', null, 'Memfault: off.'),
      ' No project key is stored in AWS, so the board keeps its data. ',
      'cloud/deploy.sh stores one from ~/.cranium/memfault_project_key.',
    ];
  } else if (!memfault.firmware) {
    line = [h('strong', null, 'Memfault: needs firmware 1.14.0.'), ' Older firmware sends nothing to Memfault.'];
  } else {
    line = [
      h('strong', null, 'Memfault: forwarding on.'),
      ' Coredumps, reboot reasons, metrics and update events go to Memfault through AWS IoT.',
    ];
  }
  return card(
    { key: 'memfault', title: 'Memfault' },
    h('p', { class: 'memfault-line', key: 'line' }, ...line),
    memfault.url
      ? h(
          'p',
          { key: 'link', class: 'memfault-open' },
          h('a', { href: memfault.url, rel: 'noreferrer', target: '_blank' }, 'Open in Memfault', icon('arrow-right'))
        )
      : null
  );
}

/** What became of the last command sent to the board from this page. */
function commandNotice(device, ctx) {
  const sent = commandOf(ctx, device.thing);
  if (sent === null) return null;
  const what = COMMAND_TITLES[sent.cmd] ?? 'Command';
  const id = sent.id ? [' ', mono(sent.id)] : null;
  switch (sent.status) {
    case 'sending':
      return notice('wait', 'clock', [`${what}: sending`]);
    case 'failed':
      return notice('bad', 'alert', [`${what} was not sent: `, sent.error ?? 'the server refused it.']);
    case 'answered':
      return notice(sent.answer.ignored ? 'warn' : 'good', sent.answer.ignored ? 'alert' : 'check-circle', [
        `${what}: the board answered “`,
        h('span', { class: 'mono' }, sent.answer.text),
        '” ',
        when(sent.answer.at, ctx.state.now),
      ]);
    case 'unanswered':
      return notice('warn', 'alert', [
        `${what} sent`,
        id,
        ', and the board has not answered. ',
        device.online
          ? 'Boards from firmware 1.13.0 answer in their log; older ones ignore it.'
          : 'It is offline, and missed it.',
      ]);
    default:
      return notice('wait', 'clock', [`${what} sent`, id, '. Waiting for the board to answer in its log…']);
  }
}

/**
 * The credit the map's tiles need, on the map itself (OpenStreetMap's tile usage policy), and Leaflet's,
 * whose licence is one of the assets of this build, beside this script.
 */
function mapCredit() {
  return h(
    'p',
    { class: 'map-credit', key: 'credit' },
    h(
      'a',
      { href: 'https://www.openstreetmap.org/copyright', rel: 'noreferrer', target: '_blank' },
      '© OpenStreetMap contributors'
    ),
    ' · ',
    h('a', { href: new URL('leaflet-license.txt', import.meta.url).href, target: '_blank' }, 'Leaflet')
  );
}

/** Where a board is: a small map of its last positions, and the list of them. Drawn by map.js. */
function locationCard(device, ctx) {
  const reason = unplacedReason(device);
  const known = ctx.state.positions?.get(device.thing)?.value ?? null;
  const steps = positionSteps(known?.positions ?? (device.position ? [device.position] : []));
  const more = { href: '#/map', label: 'Map' };
  if (reason !== null) {
    return card(
      { key: 'location', title: 'Location', more },
      h('p', { class: 'location-reason' }, icon('pin', 'is-small'), h('strong', null, reason.title), ' ', reason.text)
    );
  }
  const { position } = device;
  return card(
    { key: 'location', title: 'Location', more, className: 'location-card' },
    h(
      'div',
      { class: 'map-frame is-board', key: 'frame' },
      h('div', {
        class: 'map-canvas',
        id: 'board-map',
        key: 'map',
        role: 'img',
        'aria-label': `Map of where ${boardName(device, { short: true })} was: its last ${steps.length === 1 ? 'position' : `${steps.length} positions`}`,
      }),
      mapCredit()
    ),
    facts([
      ['Within', distanceWords(position.accuracy)],
      ['Placed', whenAt(position.at, ctx.state.now)],
      device.location?.checkedAt && device.location.checkedAt !== position.at
        ? ['Still there', when(device.location.checkedAt, ctx.state.now)]
        : null,
    ]),
    steps.length > 1
      ? h(
          'ol',
          { class: 'position-list', key: 'positions', 'aria-label': 'Positions, newest first' },
          steps.map((step) =>
            h(
              'li',
              { key: step.at },
              whenAt(step.at, ctx.state.now),
              h(
                'span',
                { class: 'position-note' },
                ` within ${distanceWords(step.accuracy)}`,
                step.moved !== null && step.moved >= 50 ? `, ${distanceWords(step.moved)} from the one before` : ''
              )
            )
          )
        )
      : null,
    h(
      'p',
      { class: 'card-note', key: 'note' },
      'Worked out by AWS IoT Core Device Location from the Wi-Fi access points the board hears. ',
      'Only the position is kept, never the access points.'
    )
  );
}

export { commandNotice, commandTools, identifyButton, locationCard, mapCredit };
