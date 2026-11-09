/*
 * labels.js: a board's QR code and its printed label (docs/new-board-setup.md, "The board's label").
 *
 * The code is a link to the board's page on this console, `<origin>/#/devices/<thing>`, with the console's
 * own origin: the page's, or in the phone apps the console's address from the app's configuration, never
 * an address written here. It is encoded by qrcode.js (Project Nayuki's encoder, vendored and pinned) in
 * byte mode at error correction M, version 10 at most, so that a scratched sticker still reads.
 *
 * The label is a sticker of 62 x 29 mm: the code, the board's name and its thing name. Printing it hides
 * the rest of the console (app.css, `body.is-printing-labels`) and prints each label on a page of the
 * sticker's own size; "Print on paper" puts them on a sheet instead, several to a page.
 *
 * Fetched by app.js when a board's page first shows its label, and imported by Board setup (setup.js),
 * which shows the label once the board is online.
 */

import { QrCode, QrSegment } from './qrcode.js';
import { boardName } from './core.js';
import { button, h, mono } from './views.js';

// A thing name as AWS IoT takes it: letters, digits, colon, underscore and hyphen.
export const THING = /^[A-Za-z0-9_:-]{1,128}$/;
// The sticker, in millimetres (app.css has the same in its print rules).
export const LABEL_MM = Object.freeze({ width: 62, height: 29 });
// The largest symbol the label takes: 57 modules, still a millimetre's module or so on the sticker.
export const MAX_VERSION = 10;
const QUIET_ZONE = 4;
const LOCAL = /^(?:127\.0\.0\.1|localhost)$/;

/**
 * The origin of a console's address, or null: https, or plain http for the preview on this computer, with
 * no user, no password and nothing but the origin itself (a path of `/` at most).
 */
export function consoleOrigin(address) {
  if (typeof address !== 'string' || address.length > 2048) return null;
  let url;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL.test(url.hostname))) return null;
  if (!['', '/'].includes(url.pathname) || url.search !== '' || url.hash !== '') return null;
  return url.origin;
}

/** The link a board's code holds: its page on the console at `origin`, or null for a bad origin or thing name. */
export function boardLink(origin, thing) {
  const own = consoleOrigin(origin);
  if (own === null || typeof thing !== 'string' || !THING.test(thing)) return null;
  return `${own}/#/devices/${thing}`;
}

/**
 * The thing name of a scanned link, or null when it is not a board's page on the console at `origin`: the
 * same origin (scheme, host and port), no user, no query, the root path, and `#/devices/<thing>` exactly.
 * The phone apps check a scanned link by the same rules (BoardLink.swift, BoardLink.kt).
 */
export function readBoardLink(text, origin) {
  const own = consoleOrigin(origin);
  if (own === null || typeof text !== 'string' || text.length > 2048) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.origin !== own || url.username !== '' || url.password !== '') return null;
  if (!['', '/'].includes(url.pathname) || url.search !== '') return null;
  const match = /^#\/devices\/([^/?#]+)$/.exec(url.hash);
  return match && THING.test(match[1]) ? match[1] : null;
}

/** A text as a QR code: byte mode, error correction M, kept at M, version 1 to MAX_VERSION. */
export function encode(text) {
  const bytes = [...new TextEncoder().encode(text)];
  return QrCode.encodeSegments([QrSegment.makeBytes(bytes)], QrCode.Ecc.MEDIUM, 1, MAX_VERSION, -1, false);
}

/** The dark modules as one SVG path, a rectangle for each run along a row, inside the quiet zone. */
export function qrPath(qr) {
  const parts = [];
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (!qr.getModule(x, y)) continue;
      let run = 1;
      while (x + run < qr.size && qr.getModule(x + run, y)) run += 1;
      parts.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h${run}v1h-${run}z`);
      x += run - 1;
    }
  }
  return parts.join('');
}

/** A board's label: its thing name, its name if it has one, the link and the code. Null without a link. */
export function labelOf(board, origin) {
  const thing = board?.thing;
  const link = boardLink(origin, thing);
  if (link === null) return null;
  const qr = encode(link);
  const name = boardName(board);
  return {
    thing,
    name: name === thing ? null : name,
    link,
    code: { size: qr.size + 2 * QUIET_ZONE, modules: qr.size, version: qr.version, path: qrPath(qr) },
  };
}

function qrPicture(label) {
  const { size, path } = label.code;
  return h(
    'svg',
    {
      class: 'qr-code board-label-code',
      viewBox: `0 0 ${size} ${size}`,
      role: 'img',
      'aria-label': `QR code of the link to ${label.name ?? label.thing}'s page`,
      focusable: 'false',
      'shape-rendering': 'crispEdges',
    },
    h('rect', { class: 'qr-paper', width: String(size), height: String(size) }),
    h('path', { class: 'qr-ink', d: path })
  );
}

/** One sticker: the code on the left, the name and the thing name on the right. */
export function labelView(label) {
  return h(
    'figure',
    { class: 'board-label', key: label.thing, 'data-thing': label.thing },
    qrPicture(label),
    h(
      'figcaption',
      { class: 'board-label-text' },
      label.name ? h('strong', { class: 'board-label-name' }, label.name) : null,
      h('span', { class: 'board-label-thing' }, label.thing)
    )
  );
}

/**
 * Labels with their buttons: Print label (a page of the sticker's size each), Print on paper (a sheet of
 * several), Hide. `labels` are those of labelOf; `close` hides them, or is null where they stay.
 */
export function labelPanel(labels, { title = 'QR code and label', close = null, key = 'labels' } = {}) {
  const shown = labels.filter(Boolean);
  if (shown.length === 0) return null;
  const many = shown.length > 1;
  return h(
    'section',
    { class: 'label-panel', key, 'aria-label': title },
    h('h2', { class: 'label-panel-title' }, title),
    h(
      'p',
      { class: 'label-panel-text' },
      many
        ? `${shown.length} boards. Each code opens its board’s page on this console.`
        : ['The code opens ', mono(shown[0].link), ' on this console.']
    ),
    h('div', { class: 'label-sheet' }, shown.map(labelView)),
    h(
      'div',
      { class: 'label-panel-tools' },
      button('is-primary', () => printLabels('sticker'), many ? 'Print labels' : 'Print label'),
      button('is-quiet', () => printLabels('paper'), 'Print on paper'),
      close ? button('is-quiet', close, 'Hide') : null
    )
  );
}

/**
 * Prints what the label panel holds and nothing else: `sticker` puts each label on a page of 62 x 29 mm,
 * `paper` puts them on the printer's paper, several to a page. The class goes once the dialog closes.
 */
export function printLabels(kind = 'sticker', win = globalThis) {
  const body = win.document?.body;
  if (!body || typeof win.print !== 'function') return false;
  const classes = ['is-printing-labels', kind === 'paper' ? 'is-label-paper' : 'is-label-sticker'];
  const done = () => {
    for (const name of classes) body.classList.remove(name);
    win.removeEventListener?.('afterprint', done);
  };
  for (const name of classes) body.classList.add(name);
  win.addEventListener?.('afterprint', done);
  win.print();
  return true;
}

/** The label on a board's page, under its head, while the person has it shown. */
export function boardLabel(device, ctx) {
  const label = labelOf(device, ctx.state.origin);
  if (label === null) return null;
  return labelPanel([label], { close: () => ctx.actions.toggleLabel(device.thing), key: 'board-label' });
}
