/**
 * The Map page, and the map on a board's page (docs/fleet.md, "The map"): every board where the
 * Wi-Fi it hears puts it, as AWS IoT Core Device Location worked it out (cloud/api/src/locator.mjs).
 * The script is fetched when a map is first shown (app.js), so the console loads no slower for it.
 *
 * The maps are Leaflet 1.9.4 (assets/leaflet.js and leaflet.css, the files of its npm package as
 * they are, with its licence beside them), fetched the first time a map is drawn: from this site,
 * as the page's content security policy demands, never from a CDN. The tiles are OpenStreetMap's,
 * from tile.openstreetmap.org, the one other place the page may show images from. Their use follows
 * the tile usage policy: the attribution is on the map itself, the browser caches each tile as the
 * tile server says, nothing is fetched ahead of what is in view, and the tiles are asked for with
 * the console's origin as their Referer, which the policy asks of a web page (the page itself sends
 * no Referer anywhere else). In the dark scheme the tiles are darkened by a filter in app.css.
 *
 * What is drawn is drawn by Leaflet into an element that the console's renderer makes and then
 * leaves alone (views.js render() keeps an element whose key does not change, and never touches
 * children it did not make). Whatever is written into a popup is built with the same renderer, as
 * elements and text: no markup is ever handed to Leaflet, and nothing that a board said becomes
 * anything but text. Each board's marker takes the colour of its state; around it, a shaded circle
 * as wide as the position's uncertainty (68%: the board is inside it two times out of three). Beside
 * the map, the same boards as a list, for a keyboard and a screen reader, and the boards that are
 * not on it, each with why.
 */

import {
  boardName,
  deviceHref,
  distanceWords,
  exactTime,
  markerTone,
  positionSteps,
  timeAgo,
  unplacedReason,
} from './core.js';
import {
  NO_BOARDS,
  boardLabel,
  boardThing,
  card,
  empty,
  freshness,
  h,
  icon,
  identifyButton,
  loadProblem,
  mapCredit,
  mono,
  notice,
  pageHead,
  pending,
  presence,
  render,
  when,
} from './views.js';

// The tile URL the tile usage policy names, exactly. The page's content security policy allows this
// host for images and no other (cloud/web/src/server.mjs TILE_ORIGIN).
export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const MAX_ZOOM = 19;
const ONE_BOARD_ZOOM = 16;

export const TONES = Object.freeze([
  ['good', 'Online'],
  ['act', 'Updating'],
  ['warn', 'Last update failed'],
  ['idle', 'Offline'],
]);

let tools = null;
let leaflet = null;
let loading = null;
let unavailable = false;
// The maps on the page now, by the id of their element: { el, map, layer, drawn, markers }.
const maps = new Map();

/** `given` is { draw } from app.js; a test may add `leaflet`, a stand-in for Leaflet's L. */
export function connect(given) {
  tools = given;
  if (given?.leaflet) leaflet = given.leaflet;
}

/** Leaflet and its stylesheet, from this site, fetched once; null while that is under way. */
function leafletNow() {
  if (leaflet !== null || unavailable) return leaflet;
  if (typeof document === 'undefined' || typeof document.head?.append !== 'function') {
    unavailable = true;
    return null;
  }
  if (loading !== null) return null;
  // Both, before the first map is drawn: Leaflet measures its element when it starts, and without
  // its stylesheet that element is not yet laid out as a map.
  const fetched = (element, check) =>
    new Promise((resolve, reject) => {
      element.addEventListener('load', () =>
        check() ? resolve() : reject(new Error('Leaflet is not what was fetched'))
      );
      element.addEventListener('error', () => reject(new Error('Leaflet could not be fetched')));
    });
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = new URL('leaflet.css', import.meta.url).href;
  const script = document.createElement('script');
  script.src = new URL('leaflet.js', import.meta.url).href;
  loading = Promise.all([
    fetched(style, () => true),
    fetched(script, () => typeof globalThis.L?.map === 'function'),
  ]).then(
    () => {
      leaflet = globalThis.L;
      tools?.draw?.();
    },
    (error) => {
      console.error(error);
      unavailable = true;
      tools?.draw?.();
    }
  );
  document.head.append(style, script);
  return null;
}

/** Text that goes into a popup: built by the console's renderer, as elements and text only. */
function element(node) {
  const holder = document.createElement('div');
  render(holder, node);
  return holder;
}

/** What a board's popup says: its name, its thing, what it runs, whether it is online, how sure its place is. */
export function popupOf(device, now) {
  const { position } = device;
  return h(
    'div',
    { class: 'map-popup' },
    h('p', { class: 'map-popup-name' }, boardLabel(device), boardThing(device)),
    h('p', { class: 'map-popup-state' }, presence(device, now)),
    h(
      'dl',
      { class: 'map-popup-facts' },
      h('div', null, h('dt', null, 'Firmware'), h('dd', null, device.fw ? mono(device.fw.version) : 'Not reported')),
      h(
        'div',
        null,
        h('dt', null, 'Placed'),
        h('dd', null, h('time', { datetime: position.at, title: exactTime(position.at) }, timeAgo(position.at, now)))
      ),
      h('div', null, h('dt', null, 'Within'), h('dd', null, distanceWords(position.accuracy)))
    ),
    h(
      'a',
      { class: 'map-popup-link', href: deviceHref(device.thing) },
      'Open the board',
      icon('arrow-right', 'is-small')
    )
  );
}

/** The places a map shows: for the Map page every board with a position, for a board's page its last positions. */
export function placesOf(id, state) {
  if (id === 'fleet-map') {
    return (state.devices.value?.devices ?? [])
      .filter((device) => device.position)
      .map((device) => ({ device, position: device.position, tone: markerTone(device) }));
  }
  const thing = state.route.thing;
  const device = state.deviceDetails.get(thing)?.value?.device ?? null;
  if (!device?.position) return [];
  const known = state.positions.get(thing)?.value?.positions ?? [device.position];
  return positionSteps(known).map((position, index) => ({
    device,
    position,
    tone: index === 0 ? markerTone(device) : 'past',
  }));
}

/** What a map shows, as text: drawn again only when this changes. */
function signature(places, now) {
  return (
    places
      .map(
        ({ device, position, tone }) =>
          `${device.thing} ${position.lat} ${position.lon} ${position.accuracy} ${position.at} ${tone} ${device.online} ${device.fw?.version}`
      )
      .join('|') + (places.length > 0 ? ` ${Math.floor(now / 60_000)}` : '')
  );
}

function mount(L, id, el) {
  const board = id === 'board-map';
  const map = L.map(el, {
    attributionControl: false,
    maxZoom: MAX_ZOOM,
    // On a board's page the map is small and in the flow of the page: scrolling goes past it.
    scrollWheelZoom: !board,
    worldCopyJump: true,
  });
  L.tileLayer(TILE_URL, {
    maxZoom: MAX_ZOOM,
    // The console's origin, never its address: the policy asks a web page for a valid Referer.
    referrerPolicy: 'strict-origin-when-cross-origin',
    className: 'map-tiles',
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  // Leaflet measures its element when it draws; the page around it may still settle, or change with
  // the width of the window. Each change of the element's size is measured again, the centre kept.
  let watcher = null;
  if (typeof globalThis.ResizeObserver === 'function') {
    watcher = new globalThis.ResizeObserver(() => map.invalidateSize());
    watcher.observe(el);
  }
  return { el, map, layer, watcher, drawn: null, things: null, markers: new Map() };
}

function draw(L, id, entry, places, now) {
  const drawn = signature(places, now);
  if (drawn === entry.drawn) return;
  entry.layer.clearLayers();
  entry.markers.clear();
  const points = [];
  if (id === 'board-map' && places.length > 1) {
    L.polyline(
      places.map(({ position }) => [position.lat, position.lon]),
      { className: 'map-trail', interactive: false }
    ).addTo(entry.layer);
  }
  // The oldest first, so that the newest is drawn on top.
  for (const { device, position, tone } of [...places].reverse()) {
    const at = [position.lat, position.lon];
    points.push(at);
    const newest = tone !== 'past';
    if (newest) {
      L.circle(at, { radius: position.accuracy, className: `map-accuracy is-${tone}`, interactive: false }).addTo(
        entry.layer
      );
    }
    const marker = L.circleMarker(at, { radius: newest ? 9 : 5, className: `map-marker is-${tone}` }).addTo(
      entry.layer
    );
    if (newest) {
      marker.bindPopup(element(popupOf(device, now)), { className: 'map-popup-frame', maxWidth: 280 });
      entry.markers.set(device.thing, marker);
    }
  }
  // Frame what is there the first time, and again when other boards come or go; otherwise the
  // view stays where the person put it.
  const things = places
    .map(({ device }) => device.thing)
    .sort()
    .join(' ');
  if (things !== entry.things && points.length > 0) {
    if (
      points.length === 1 ||
      places.every(({ position }) => position.lat === points[0][0] && position.lon === points[0][1])
    ) {
      entry.map.setView(points[0], ONE_BOARD_ZOOM);
    } else {
      entry.map.fitBounds(points, { padding: [36, 36], maxZoom: ONE_BOARD_ZOOM + 1 });
    }
  }
  entry.things = things;
  entry.drawn = drawn;
}

/**
 * Bring the maps on the page up to date with the state: called after each time the page is drawn.
 * A map whose element has gone with the page it was on is taken down.
 */
export function sync(state) {
  for (const id of ['fleet-map', 'board-map']) {
    const el = typeof document === 'undefined' ? null : document.getElementById(id);
    const known = maps.get(id);
    if (known && known.el !== el) {
      known.watcher?.disconnect();
      known.map.remove();
      maps.delete(id);
    }
    if (el === null) continue;
    const L = leafletNow();
    if (L === null) continue;
    const entry = maps.get(id) ?? mount(L, id, el);
    maps.set(id, entry);
    draw(L, id, entry, placesOf(id, state), state.now);
    // Without a ResizeObserver, measured again after each time the page is drawn.
    if (entry.watcher === null) entry.map.invalidateSize?.();
  }
}

/** Open a board's popup on the Map page, from the list beside it. */
export function showOnMap(thing) {
  const entry = maps.get('fleet-map');
  const marker = entry?.markers.get(thing);
  if (!marker) return;
  entry.map.setView(marker.getLatLng(), Math.max(entry.map.getZoom(), ONE_BOARD_ZOOM));
  marker.openPopup();
}

/** True once Leaflet could not be fetched: the lists still say where the boards are. */
export function mapUnavailable() {
  return unavailable;
}

function legend() {
  return h(
    'ul',
    { class: 'map-legend', key: 'legend', 'aria-label': 'What the colours mean' },
    TONES.map(([tone, label]) =>
      h('li', { key: tone }, h('span', { class: `map-swatch is-${tone}`, 'aria-hidden': 'true' }), label)
    ),
    h(
      'li',
      { key: 'accuracy' },
      h('span', { class: 'map-swatch is-ring', 'aria-hidden': 'true' }),
      'How sure: the board is inside the circle two times out of three'
    )
  );
}

function placedRow(device, ctx) {
  const { position } = device;
  return h(
    'li',
    { class: 'map-row', key: device.thing },
    h('span', { class: `map-swatch is-${markerTone(device)}`, 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'map-row-main' },
      h('p', { class: 'map-row-name' }, boardLabel(device), boardThing(device)),
      h(
        'p',
        { class: 'map-row-note' },
        `Within ${distanceWords(position.accuracy)} · placed `,
        when(position.at, ctx.state.now),
        device.online ? null : ' · offline'
      )
    ),
    h(
      'div',
      { class: 'map-row-tools' },
      identifyButton(device, ctx, { compact: true }),
      maps.has('fleet-map')
        ? h(
            'button',
            {
              type: 'button',
              class: 'ui-btn btn is-quiet is-icon',
              key: 'show',
              title: 'Show it on the map',
              'aria-label': `Show ${boardName(device, { short: true })} on the map`,
              onClick: () => showOnMap(device.thing),
            },
            icon('pin')
          )
        : null
    )
  );
}

function unplacedRow(device) {
  const reason = unplacedReason(device);
  return h(
    'li',
    { class: 'map-row', key: device.thing },
    h('span', { class: 'map-swatch is-none', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'map-row-main' },
      h('p', { class: 'map-row-name' }, boardLabel(device), boardThing(device)),
      h('p', { class: 'map-row-note' }, h('strong', null, reason.title), '. ', reason.text)
    )
  );
}

export function mapView(ctx) {
  const { state } = ctx;
  const devices = state.devices.value?.devices ?? null;
  const head = pageHead({
    title: 'Map',
    lede: 'Every board on a map, placed by the Wi-Fi networks it hears.',
    how: {
      title: 'How the map works',
      text: ['Each place is worked out by AWS IoT Core Device Location from the Wi-Fi access points the board hears.'],
    },
    tools: freshness(state.devices, ctx),
  });
  if (devices === null) {
    return h(
      'div',
      { class: 'page is-map' },
      head,
      loadProblem(state.devices, 'the boards', ctx),
      pending(state.devices, 'boards')
    );
  }
  if (devices.length === 0) return h('div', { class: 'page is-map' }, head, card({ key: 'none' }, empty(NO_BOARDS)));

  const placed = devices.filter((device) => device.position);
  const unplaced = devices.filter((device) => !device.position);
  const named = (a, b) => boardName(a).localeCompare(boardName(b));
  return h(
    'div',
    { class: 'page is-map' },
    head,
    loadProblem(state.devices, 'the boards', ctx),
    unavailable
      ? notice('warn', 'alert', 'The map itself could not be loaded. The lists below still say where each board is.')
      : null,
    h(
      'div',
      { class: 'map-layout', key: 'layout' },
      h(
        'section',
        { class: 'ui-card card map-card', key: 'map', 'aria-label': 'Map of the boards' },
        placed.length > 0
          ? [
              h(
                'div',
                { class: 'map-frame is-fleet', key: 'frame' },
                h('div', {
                  class: 'map-canvas',
                  id: 'fleet-map',
                  key: 'canvas',
                  role: 'region',
                  'aria-label': `Map of ${placed.length === 1 ? 'one board' : `${placed.length} boards`}. The list beside it has the same.`,
                }),
                mapCredit()
              ),
            ]
          : empty({
              iconName: 'pin',
              title: 'No board has a position yet',
              text:
                'A board on firmware 1.13.0 or later sends what it hears of the Wi-Fi a minute after it connects, and ' +
                'every 6 hours after that. Report now on its page asks for one at once.',
            })
      ),
      h(
        'div',
        { class: 'map-side stack', key: 'side' },
        card(
          { key: 'placed', title: `On the map · ${placed.length}` },
          placed.length > 0
            ? h(
                'ul',
                { class: 'map-rows', key: 'rows' },
                [...placed].sort(named).map((device) => placedRow(device, ctx))
              )
            : h('p', { class: 'quiet' }, 'None yet.')
        ),
        unplaced.length > 0
          ? card(
              { key: 'unplaced', title: `Not on the map · ${unplaced.length}` },
              h('ul', { class: 'map-rows', key: 'rows' }, [...unplaced].sort(named).map(unplacedRow))
            )
          : null,
        // What the marks mean, under the boards: on a phone that is the sheet over the map.
        placed.length > 0 ? legend() : null,
        h(
          'p',
          { class: 'ui-card-note card-note map-note', key: 'note' },
          'Only the position is kept, and the last 20 of each board, never the access points it heard. ',
          'The map is drawn from OpenStreetMap: this page fetches its tiles from tile.openstreetmap.org.'
        )
      )
    )
  );
}
