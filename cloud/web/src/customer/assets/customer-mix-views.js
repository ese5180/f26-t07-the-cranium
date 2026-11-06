/**
 * The mixes' pages of the customer site (docs/customer-site.md, "Mixes"): what the Overview shows of
 * them, Sessions and one session, Transitions, the Track library and Saved moments, and their
 * dialogs: connecting a board, importing a session file, exporting, and keeping a transition.
 *
 * What they show comes from customer-mixes.js: the demo, which says it is made up wherever it shows,
 * or the customer's own journal of the session files they imported. Every name in a session is set
 * as text by the console's renderer (views.js), never as markup.
 */

import { badge, button, empty, h, icon } from './views.js';
import {
  MIXES_NOTE,
  NOT_BUILT,
  TEASER_EYEBROW,
  TEASER_MORE,
  TEASER_TEXT,
  TEASER_TITLE,
  WHY_EMPTY,
} from './customer-core.js';
import {
  LIMITS,
  RANGES,
  clock,
  elapsedSeconds,
  figures,
  latest,
  libraryOf,
  matches,
  momentToRevisit,
  onDecks,
  sessionDay,
  trackInitials,
  trackShade,
  transitionsOf,
} from './customer-mixes.js';

// Icons of the mixes, drawn as the console's are: 24 by 24, stroked in the text colour.
export const MIX_ICONS = {
  layers: [
    ['path', { d: 'M12 4l8.5 4.5L12 13 3.5 8.5z' }],
    ['path', { d: 'M3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5' }],
  ],
  note: [
    ['path', { d: 'M9 18V6l10-2v12' }],
    ['circle', { cx: 6.5, cy: 18, r: 2.5 }],
    ['circle', { cx: 16.5, cy: 16, r: 2.5 }],
  ],
  bookmark: [['path', { d: 'M7 4h10v16l-5-3.6L7 20z' }]],
  'bookmark-on': [['path', { d: 'M7 4h10v16l-5-3.6L7 20z', fill: 'currentColor' }]],
  bluetooth: [['path', { d: 'M7 7.5l10 9-5 4.5v-18l5 4.5-10 9' }]],
  sparkle: [['path', { d: 'M12 3.5l2 6.5 6.5 2-6.5 2-2 6.5-2-6.5-6.5-2 6.5-2z' }]],
  search: [
    ['circle', { cx: 11, cy: 11, r: 6.5 }],
    ['path', { d: 'M16 16l4.5 4.5' }],
  ],
  bars: [['path', { d: 'M4 9v6M8 6v12M12 9v6M16 4v16M20 8v8' }]],
  trash: [['path', { d: 'M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13' }]],
  info: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M12 11v5.5M12 7.5v.1' }],
  ],
};

export function mixIcon(name, className = '') {
  const shapes = MIX_ICONS[name];
  if (!shapes) return icon(name, className);
  return h(
    'svg',
    { class: `icon ${className}`.trim(), viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    shapes.map(([tag, attributes]) => h(tag, attributes))
  );
}

/** What the mixes' pages show now: the demo or the journal, in the range chosen. */
export function shown(ctx) {
  return ctx.mixes.sessions;
}

// The tools above a page of mixes: the range, importing, and which sessions it shows.

export function mixTools(ctx) {
  const { mixes } = ctx;
  return [
    h(
      'label',
      { class: 'cs-range', key: 'range' },
      h('span', { class: 'sr-only' }, 'Which sessions'),
      h(
        'select',
        {
          class: 'input cs-range-select',
          value: mixes.range,
          onChange: (event) => ctx.actions.mix.setRange(event.currentTarget.value),
        },
        RANGES.map(([value, label]) => h('option', { key: value, value }, label))
      )
    ),
    button(
      'cs-import',
      () => ctx.actions.mix.open({ kind: 'import' }),
      icon('upload'),
      h('span', null, 'Import session')
    ),
  ];
}

export function sourceBar(ctx) {
  const { mixes } = ctx;
  const demo = mixes.source === 'demo';
  const count = mixes.journal.sessions.length;
  return h(
    'div',
    { class: 'cs-source', key: 'source' },
    h(
      'div',
      { class: 'cs-switch', role: 'group', 'aria-label': 'Which sessions to show' },
      ['demo', 'journal'].map((source) =>
        h(
          'button',
          {
            key: source,
            type: 'button',
            class: 'cs-switch-option',
            'aria-pressed': mixes.source === source ? 'true' : 'false',
            onClick: () => ctx.actions.mix.setSource(source),
          },
          source === 'demo' ? 'Explore demo' : 'My journal'
        )
      )
    ),
    h(
      'p',
      { class: 'cs-source-note' },
      mixIcon('info', 'is-small'),
      demo
        ? 'Made-up sessions, to show what this will be: no board sends what you play yet'
        : count === 0
          ? 'Your journal is empty: import a session file to start it'
          : `Your journal: ${count === 1 ? '1 session' : `${count} sessions`}, kept in this browser`
    )
  );
}

// A track: its square of initials, its name and its artist.

function cover(track, className = '') {
  return h(
    'span',
    { class: `cs-cover is-shade-${trackShade(track)} ${className}`.trim(), 'aria-hidden': 'true' },
    h('span', { class: 'cs-cover-ring' }, trackInitials(track.title))
  );
}

function trackName(track) {
  return h(
    'span',
    { class: 'cs-track' },
    cover(track),
    h(
      'span',
      { class: 'cs-track-text' },
      h('span', { class: 'cs-track-title' }, track.title),
      track.artist ? h('span', { class: 'cs-track-artist' }, track.artist) : null
    )
  );
}

function demoTag(session) {
  return session.source === 'demo' ? h('span', { class: 'tag cs-demo-tag' }, 'Demo') : null;
}

// The shape of a set: the two decks as lanes, each track where and as long as it played.

export function setShape(session) {
  const known = session.tracks.filter((track) => track.start !== null);
  const total = Math.max(1, elapsedSeconds(session));
  const first = known.length ? Math.min(...known.map((track) => track.start)) : 0;
  const lane = (deck) =>
    h(
      'div',
      { class: 'cs-lane', key: deck },
      h('span', { class: 'cs-lane-name', 'aria-hidden': 'true' }, deck),
      h(
        'span',
        { class: 'cs-lane-track' },
        known
          .filter((track) => (track.deck ?? 'A') === deck)
          .map((track, index) => {
            const end = track.end ?? track.start + total * 0.08;
            return h(
              'span',
              {
                key: `${deck}${index}`,
                class: 'cs-block',
                title: `${track.title}: ${clock(track.start - first)} to ${clock(end - first)}`,
                vars: {
                  '--from': `${(((track.start - first) / total) * 100).toFixed(2)}%`,
                  '--width': `${Math.max(1.5, ((end - track.start) / total) * 100).toFixed(2)}%`,
                },
              },
              track.title
            );
          })
      )
    );
  return h(
    'figure',
    { class: 'cs-shape', key: 'shape' },
    h(
      'figcaption',
      { class: 'cs-shape-head' },
      h('span', { class: 'eyebrow' }, 'The shape of your set'),
      h('span', { class: 'cs-shape-time' }, `${clock(elapsedSeconds(session))} elapsed`)
    ),
    h(
      'div',
      { class: 'cs-lanes', role: 'img', 'aria-label': `Decks A and B over ${clock(elapsedSeconds(session))}` },
      lane('A'),
      lane('B')
    ),
    h(
      'p',
      { class: 'cs-shape-note' },
      'When each deck played. Two tracks overlap where both played at once, which says nothing of how good the blend was.'
    )
  );
}

function sessionHead(session, { level = 'h3', link = false } = {}) {
  const [opener] = session.tracks;
  const title = link ? h('a', { href: `#/sessions/${session.id}` }, session.title) : session.title;
  return h(
    'div',
    { class: 'cs-set-head', key: 'head' },
    cover(opener, 'is-large'),
    h(
      'div',
      { class: 'cs-set-text' },
      h(level, { class: 'cs-set-title' }, title),
      h(
        'p',
        { class: 'cs-set-meta' },
        sessionDay(session.startedAt),
        ' · ',
        session.tracks.length === 1 ? '1 track' : `${session.tracks.length} tracks`,
        ' · ',
        `${onDecks(elapsedSeconds(session))} recorded`
      )
    ),
    demoTag(session)
  );
}

/** The tracks of a set, in the order they played, those the search finds. */
export function trackTable(session, { query = '', limit = Infinity, onSearch = null, searchId = 'set-search' } = {}) {
  const order = session.tracks
    .map((track, index) => ({ track, index }))
    .sort((a, b) => (a.track.start ?? Infinity) - (b.track.start ?? Infinity) || a.index - b.index);
  const first = order.find((item) => item.track.start !== null)?.track.start ?? 0;
  const found = order.filter((item) => matches(item.track, query));
  const rows = found.slice(0, limit);
  return h(
    'div',
    { class: 'cs-tracks', key: 'tracks' },
    onSearch
      ? searchBar({
          id: searchId,
          label: 'Find a track in this set',
          value: query,
          onInput: onSearch,
          note: 'Played in order',
        })
      : null,
    rows.length === 0
      ? h('p', { class: 'cs-tracks-none' }, `No track of this set matches “${query}”.`)
      : h(
          'table',
          { class: 'cs-tracktable' },
          h('caption', { class: 'sr-only' }, `The tracks of ${session.title}`),
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { scope: 'col', class: 'is-number' }, '#'),
              h('th', { scope: 'col' }, 'Track / artist'),
              h('th', { scope: 'col', class: 'is-narrow' }, 'Deck'),
              h('th', { scope: 'col', class: 'is-narrow' }, 'BPM'),
              h('th', { scope: 'col', class: 'is-narrow' }, 'Key'),
              h('th', { scope: 'col', class: 'is-narrow' }, 'Played')
            )
          ),
          h(
            'tbody',
            null,
            rows.map(({ track }, position) =>
              h(
                'tr',
                { key: `${track.title}-${position}` },
                h(
                  'td',
                  { class: 'is-number', 'data-label': '#' },
                  String(order.indexOf(found[position]) + 1).padStart(2, '0')
                ),
                h('th', { scope: 'row', 'data-label': 'Track' }, trackName(track)),
                h(
                  'td',
                  { class: 'is-narrow', 'data-label': 'Deck' },
                  track.deck ? h('span', { class: 'cs-deck' }, track.deck) : '—'
                ),
                h('td', { class: 'is-narrow', 'data-label': 'BPM' }, track.bpm ?? '—'),
                h('td', { class: 'is-narrow', 'data-label': 'Key' }, track.key ?? '—'),
                h(
                  'td',
                  { class: 'is-narrow', 'data-label': 'Played' },
                  track.start === null ? '—' : clock(track.start - first)
                )
              )
            )
          )
        )
  );
}

function searchBar({ id, label, value, onInput, note }) {
  return h(
    'div',
    { class: 'cs-search', key: 'search' },
    h(
      'label',
      { class: 'cs-search-field', for: id },
      mixIcon('search'),
      h('span', { class: 'sr-only' }, label),
      h('input', {
        id,
        class: 'cs-search-input',
        type: 'search',
        value,
        placeholder: `${label}…`,
        autocomplete: 'off',
        spellcheck: 'false',
        maxlength: String(LIMITS.text),
        onInput: (event) => onInput(event.currentTarget.value),
      })
    ),
    note ? h('span', { class: 'cs-search-note' }, note) : null
  );
}

// The Overview's part.

function heroArt() {
  return h(
    'div',
    { class: 'cs-hero-card-art', 'aria-hidden': 'true' },
    h(
      'svg',
      { class: 'cs-vinyl', viewBox: '0 0 240 240', focusable: 'false' },
      h('circle', { class: 'cs-record-disc', cx: '120', cy: '120', r: '116' }),
      [100, 86, 72, 58].map((r) =>
        h('circle', { key: String(r), class: 'cs-record-groove', cx: '120', cy: '120', r: String(r) })
      ),
      h('circle', { class: 'cs-record-label', cx: '120', cy: '120', r: '36' }),
      h('path', { class: 'cs-record-dome', d: 'M102 127a18 18 0 0 1 36 0v11a4 4 0 0 1-4 4h-28a4 4 0 0 1-4-4z' })
    ),
    h(
      'span',
      { class: 'cs-sleeve' },
      h('span', { class: 'cs-sleeve-text' }, 'Side A', h('br'), 'Good things', h('br'), 'on repeat.')
    ),
    h('span', { class: 'cs-hero-card-caption' }, 'Collect moments, not just tracks.')
  );
}

export function heroCard() {
  return h(
    'section',
    { class: 'cs-hero-card', key: 'hero', 'aria-labelledby': 'hero-card-title' },
    h(
      'div',
      { class: 'cs-hero-card-text' },
      h('p', { class: 'eyebrow' }, mixIcon('bars', 'is-small'), ` ${TEASER_EYEBROW}`),
      h('h2', { class: 'cs-hero-card-title', id: 'hero-card-title' }, TEASER_TITLE),
      h(
        'p',
        { class: 'cs-hero-card-lede' },
        'That blend you stumbled into? Keep it for the next time you step behind the decks.'
      ),
      h('a', { class: 'cs-link-more', href: '#/mixes/transitions' }, 'Revisit your transitions', icon('arrow-right'))
    ),
    heroArt()
  );
}

export function mixTiles(sessions) {
  const sum = figures(sessions);
  const tile = (key, label, iconName, value, note, ink = false) =>
    h(
      'div',
      { class: `cs-tile ${ink ? 'on-ink' : ''}`.trim(), key },
      h('p', { class: 'cs-tile-label' }, label, mixIcon(iconName, 'is-small cs-tile-icon')),
      h('p', { class: 'cs-tile-value' }, value),
      h('p', { class: 'cs-tile-note' }, note)
    );
  return h(
    'div',
    { class: 'cs-tiles', key: 'tiles' },
    tile('time', 'Time on decks', 'clock', onDecks(sum.seconds), 'Two decks at once counted once', true),
    tile(
      'sessions',
      'Sessions',
      'layers',
      String(sum.sessions),
      sum.sessions === 0 ? 'None in this range' : 'A place for every experiment'
    ),
    tile(
      'plays',
      'Tracks played',
      'note',
      String(sum.plays),
      sum.unique === 1 ? '1 track in rotation' : `${sum.unique} tracks in rotation`
    ),
    tile('overlaps', 'Track overlaps', 'swap', String(sum.overlaps), 'Where both decks played at once')
  );
}

function lastSet(ctx, session) {
  return h(
    'section',
    { class: 'cs-last', key: 'last', 'aria-labelledby': 'last-title' },
    h(
      'header',
      { class: 'cs-section-head' },
      h('h2', { class: 'cs-section-title', id: 'last-title' }, 'Back to your last set', icon('arrow-right', 'cs-tilt')),
      h('a', { class: 'cs-link-quiet', href: '#/mixes/sessions' }, 'All sessions', icon('arrow-right'))
    ),
    h(
      'article',
      { class: 'cs-panel' },
      h(
        'div',
        { class: 'cs-panel-pad' },
        h(
          'div',
          { class: 'cs-set-top' },
          sessionHead(session, { link: true }),
          button(
            'is-small cs-export-set',
            () => ctx.actions.mix.exportSession(session.id),
            icon('download'),
            h('span', null, 'Export set')
          )
        ),
        setShape(session)
      ),
      trackTable(session, {
        query: ctx.mixes.query,
        limit: 5,
        onSearch: ctx.actions.mix.setQuery,
        searchId: 'last-search',
      }),
      h(
        'footer',
        { class: 'cs-panel-foot' },
        h(
          'span',
          null,
          `Showing ${Math.min(5, session.tracks.length)} of ${session.tracks.length === 1 ? '1 track' : `${session.tracks.length} tracks`}`
        ),
        h('a', { class: 'cs-link-quiet', href: `#/sessions/${session.id}` }, 'Open full session', icon('arrow-right'))
      )
    )
  );
}

function onRepeat(sessions) {
  const top = libraryOf(sessions).slice(0, 4);
  return h(
    'section',
    { class: 'cs-panel cs-panel-pad cs-repeat', key: 'repeat', 'aria-labelledby': 'repeat-title' },
    h('h2', { class: 'cs-card-title', id: 'repeat-title' }, 'On repeat'),
    h('p', { class: 'cs-card-lede' }, 'Your most played tracks, all in one place.'),
    h(
      'ol',
      { class: 'cs-repeat-list' },
      top.map((track, index) =>
        h(
          'li',
          { key: track.title + track.artist },
          h('span', { class: 'cs-rank' }, String(index + 1).padStart(2, '0')),
          trackName(track),
          h('span', { class: 'cs-plays' }, track.plays === 1 ? '1 play' : `${track.plays} plays`)
        )
      )
    ),
    h(
      'a',
      { class: 'cs-link-quiet cs-repeat-more', href: '#/mixes/library' },
      'Explore your rotation',
      icon('arrow-right')
    )
  );
}

function revisit(ctx, pair) {
  if (!pair) return null;
  const saved = ctx.mixes.journal.moments.some((moment) => moment.id === pair.id);
  return h(
    'section',
    { class: 'cs-revisit', key: 'revisit', 'aria-labelledby': 'revisit-title' },
    mixIcon('sparkle'),
    h('h2', { class: 'cs-card-title', id: 'revisit-title' }, 'A moment to come back to.'),
    h(
      'p',
      { class: 'cs-revisit-pair' },
      h('strong', null, pair.from.title),
      h('br'),
      '↳ ',
      h('strong', null, pair.to.title)
    ),
    h('p', { class: 'cs-revisit-text' }, `${pair.overlap} seconds together. Write a note while the idea is fresh.`),
    button(
      'is-small',
      () => ctx.actions.mix.open({ kind: 'moment', id: pair.id }),
      mixIcon(saved ? 'bookmark-on' : 'bookmark'),
      h('span', null, saved ? 'Kept: see your note' : 'Keep this transition')
    )
  );
}

function journalNote() {
  return h(
    'p',
    { class: 'cs-note', key: 'journal-note' },
    icon('shield'),
    h(
      'span',
      null,
      "Your journal lives in this browser, not on Cranium's servers. Export a backup to keep it with you."
    )
  );
}

/** No session to show: the journal is empty, or the range has none. */
export function noSessions(ctx) {
  const { mixes } = ctx;
  if (mixes.source === 'journal' && mixes.journal.sessions.length === 0) {
    return h(
      'section',
      { class: 'cs-placeholder', key: 'empty-journal', 'aria-labelledby': 'empty-title' },
      h('span', { class: 'tag is-warn cs-placeholder-tag' }, 'Your board: ', NOT_BUILT),
      h('h2', { class: 'cs-placeholder-title', id: 'empty-title' }, 'Your journal is empty.'),
      h('p', { class: 'cs-placeholder-text' }, WHY_EMPTY),
      h(
        'p',
        { class: 'cs-placeholder-text' },
        'Until it is, import a session file: a CSV of the tracks you played, or a file this site exported.'
      ),
      h(
        'p',
        { class: 'cs-placeholder-actions' },
        button(
          'is-primary',
          () => ctx.actions.mix.open({ kind: 'import' }),
          icon('upload'),
          h('span', null, 'Import session')
        ),
        button('', () => ctx.actions.mix.setSource('demo'), h('span', null, 'Explore the demo'))
      )
    );
  }
  return empty({
    iconName: 'clock',
    title: 'No session in this range.',
    text: 'Choose All time to see every session.',
    action: {
      href: '#',
      label: 'Show all time',
      onClick: (event) => {
        event.preventDefault();
        ctx.actions.mix.setRange('all');
      },
    },
  });
}

/** The mixes on the Overview: the card, the figures, the last set, the tracks on repeat. */
export function overviewMixes(ctx) {
  const sessions = shown(ctx);
  const last = latest(sessions);
  return [
    sourceBar(ctx),
    heroCard(),
    mixTiles(sessions),
    last
      ? h(
          'div',
          { class: 'cs-grid', key: 'grid' },
          h('div', { class: 'cs-grid-main' }, lastSet(ctx, last)),
          h(
            'div',
            { class: 'cs-grid-side' },
            onRepeat(sessions),
            revisit(ctx, momentToRevisit(sessions)),
            journalNote()
          )
        )
      : h('div', { key: 'none' }, noSessions(ctx)),
  ];
}

// Sessions.

function sessionCard(session) {
  return h(
    'li',
    { class: 'cs-panel cs-session', key: session.id },
    h('div', { class: 'cs-panel-pad' }, sessionHead(session, { link: true }), setShape(session)),
    h(
      'a',
      {
        class: 'cs-panel-foot cs-session-foot',
        href: `#/sessions/${session.id}`,
        'aria-label': `Open ${session.title}`,
      },
      h(
        'span',
        null,
        session.tracks.length === 1 ? '1 track' : `${session.tracks.length} tracks`,
        ' · ',
        `${onDecks(elapsedSeconds(session))} on decks`
      ),
      icon('arrow-right')
    )
  );
}

export function sessionsList(ctx) {
  const sessions = shown(ctx);
  return [
    sourceBar(ctx),
    sessions.length === 0
      ? noSessions(ctx)
      : h('ul', { class: 'cs-sessions', key: 'sessions' }, sessions.map(sessionCard)),
  ];
}

/** One session, all of it. */
export function sessionPage(ctx, session) {
  const own = session.source !== 'demo';
  return [
    h(
      'div',
      { class: 'cs-panel', key: `session-${session.id}` },
      h(
        'div',
        { class: 'cs-panel-pad' },
        h(
          'div',
          { class: 'cs-set-top' },
          sessionHead(session, { level: 'h2' }),
          h(
            'div',
            { class: 'cs-set-tools' },
            button(
              'is-small',
              () => ctx.actions.mix.exportSession(session.id),
              icon('download'),
              h('span', null, 'Export set')
            ),
            own
              ? button(
                  'is-small is-danger-quiet',
                  () => ctx.actions.mix.open({ kind: 'forget', id: session.id }),
                  mixIcon('trash'),
                  h('span', null, 'Remove')
                )
              : null
          )
        ),
        setShape(session)
      ),
      trackTable(session, { query: ctx.mixes.query, onSearch: ctx.actions.mix.setQuery, searchId: 'session-search' })
    ),
    transitionCards(ctx, transitionsOf([session]), { heading: 'Its transitions' }),
  ];
}

// Transitions.

function transitionCard(ctx, pair) {
  const saved = ctx.mixes.journal.moments.some((moment) => moment.id === pair.id);
  const bpm = pair.from.bpm && pair.to.bpm ? `${pair.from.bpm} → ${pair.to.bpm} BPM` : null;
  return h(
    'li',
    { class: 'cs-panel cs-panel-pad cs-pair', key: pair.id },
    h(
      'div',
      { class: 'cs-pair-covers', 'aria-hidden': 'true' },
      cover(pair.from, 'is-large'),
      icon('swap', 'cs-pair-swap'),
      cover(pair.to, 'is-large')
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'btn is-icon is-quiet cs-pair-keep',
        'aria-pressed': saved ? 'true' : 'false',
        'aria-label': saved
          ? `Kept: ${pair.from.title} to ${pair.to.title}. See your note`
          : `Keep ${pair.from.title} to ${pair.to.title}`,
        onClick: () => ctx.actions.mix.open({ kind: 'moment', id: pair.id }),
      },
      mixIcon(saved ? 'bookmark-on' : 'bookmark')
    ),
    h(
      'h3',
      { class: 'cs-pair-title' },
      pair.from.title,
      h('span', { class: 'cs-pair-arrow', 'aria-label': ' to ' }, ' → '),
      pair.to.title
    ),
    h(
      'p',
      { class: 'cs-pair-meta' },
      bpm ? h('span', null, bpm) : null,
      h('span', null, pair.overlap === null ? 'Overlap not known' : `${pair.overlap}s overlap`)
    ),
    h(
      'a',
      { class: 'cs-link-quiet cs-pair-set', href: `#/sessions/${pair.session.id}` },
      pair.session.title,
      icon('arrow-right')
    )
  );
}

export function transitionCards(ctx, pairs, { heading = 'From one track to the next' } = {}) {
  return h(
    'section',
    { class: 'cs-pairs-wrap', key: 'pairs', 'aria-labelledby': 'pairs-title' },
    h(
      'header',
      { class: 'cs-section-head' },
      h('h2', { class: 'cs-section-title', id: 'pairs-title' }, heading),
      h('span', { class: 'cs-count' }, pairs.length === 1 ? '1 pair' : `${pairs.length} pairs`)
    ),
    pairs.length === 0
      ? h('p', { class: 'card-note' }, 'A session needs two tracks for a transition.')
      : h(
          'ul',
          { class: 'cs-pairs' },
          pairs.map((pair) => transitionCard(ctx, pair))
        ),
    h(
      'p',
      { class: 'cs-fine' },
      "Pairs follow the order the tracks started in. An overlap is worked out when both tracks' times are known. " +
        'Keeping one is your own call: nothing here rates a blend.'
    )
  );
}

export function transitionsList(ctx) {
  const sessions = shown(ctx);
  return [sourceBar(ctx), sessions.length === 0 ? noSessions(ctx) : transitionCards(ctx, transitionsOf(sessions))];
}

// The track library.

export function libraryList(ctx) {
  const sessions = shown(ctx);
  const tracks = libraryOf(sessions);
  const found = tracks.filter((track) => matches(track, ctx.mixes.libraryQuery));
  return [
    sourceBar(ctx),
    mixTiles(sessions),
    sessions.length === 0
      ? noSessions(ctx)
      : h(
          'section',
          { class: 'cs-panel', key: 'library' },
          searchBar({
            id: 'library-search',
            label: 'Search your rotation',
            value: ctx.mixes.libraryQuery,
            onInput: ctx.actions.mix.setLibraryQuery,
            note: 'Ranked by plays',
          }),
          found.length === 0
            ? h('p', { class: 'cs-tracks-none' }, `No track matches “${ctx.mixes.libraryQuery}”.`)
            : h(
                'table',
                { class: 'cs-tracktable' },
                h('caption', { class: 'sr-only' }, 'Your tracks, the most played first'),
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { scope: 'col', class: 'is-number' }, '#'),
                    h('th', { scope: 'col' }, 'Track / artist'),
                    h('th', { scope: 'col', class: 'is-narrow' }, 'Plays'),
                    h('th', { scope: 'col', class: 'is-narrow' }, 'BPM'),
                    h('th', { scope: 'col', class: 'is-narrow' }, 'Played')
                  )
                ),
                h(
                  'tbody',
                  null,
                  found.map((track) =>
                    h(
                      'tr',
                      { key: track.title + track.artist },
                      h(
                        'td',
                        { class: 'is-number', 'data-label': '#' },
                        String(tracks.indexOf(track) + 1).padStart(2, '0')
                      ),
                      h('th', { scope: 'row', 'data-label': 'Track' }, trackName(track)),
                      h('td', { class: 'is-narrow', 'data-label': 'Plays' }, String(track.plays)),
                      h('td', { class: 'is-narrow', 'data-label': 'BPM' }, track.bpm ?? '—'),
                      h(
                        'td',
                        { class: 'is-narrow', 'data-label': 'Played' },
                        track.seconds > 0 ? clock(track.seconds) : '—'
                      )
                    )
                  )
                )
              )
        ),
    h(
      'p',
      { class: 'cs-fine', key: 'fine' },
      'A play is a track in a session. Played is how long it was on a deck in all, where its times are known. ' +
        'BPM and key are what the session file says; nothing here judges taste.'
    ),
  ];
}

// Saved moments.

export function momentsList(ctx) {
  const { moments } = ctx.mixes.journal;
  if (moments.length === 0) {
    return [
      empty({
        iconName: 'list',
        title: 'No saved moments yet.',
        text: 'On Transitions, keep a pair worth trying again, with a note on what made it work.',
        action: { href: '#/mixes/transitions', label: 'Go to Transitions' },
      }),
      journalNote(),
    ];
  }
  return [
    h(
      'ul',
      { class: 'cs-moments', key: 'moments' },
      moments.map((moment) =>
        h(
          'li',
          { class: 'cs-panel cs-panel-pad cs-moment', key: moment.id },
          h(
            'div',
            { class: 'cs-pair-covers', 'aria-hidden': 'true' },
            cover(moment.from, 'is-large'),
            icon('swap', 'cs-pair-swap'),
            cover(moment.to, 'is-large')
          ),
          h(
            'h3',
            { class: 'cs-pair-title' },
            moment.from.title,
            h('span', { class: 'cs-pair-arrow', 'aria-label': ' to ' }, ' → '),
            moment.to.title
          ),
          h(
            'p',
            { class: 'cs-pair-meta' },
            h('span', null, moment.session || 'A session'),
            moment.overlap !== null ? h('span', null, `${moment.overlap}s overlap`) : null,
            moment.demo ? h('span', { class: 'tag cs-demo-tag' }, 'Demo') : null
          ),
          moment.note
            ? h('blockquote', { class: 'cs-moment-note' }, moment.note)
            : h('p', { class: 'cs-fine' }, 'No note.'),
          h(
            'p',
            { class: 'cs-moment-tools' },
            h('span', { class: 'cs-fine' }, `Kept ${sessionDay(moment.savedAt)}`),
            button('is-small is-quiet', () => ctx.actions.mix.open({ kind: 'moment', id: moment.id }), 'Edit note'),
            button(
              'is-small is-danger-quiet',
              () => ctx.actions.mix.forgetMoment(moment.id),
              mixIcon('trash'),
              h('span', null, 'Forget')
            )
          )
        )
      )
    ),
    journalNote(),
  ];
}

// Dialogs.

function dialog(ctx, key, title, body, foot) {
  return h(
    'dialog',
    {
      key: `dialog-${key}`,
      class: 'dialog cs-dialog',
      'aria-labelledby': 'mix-dialog-title',
      ref: (el) => {
        try {
          el.showModal();
        } catch {
          el.setAttribute('open', '');
        }
      },
      onClose: () => ctx.actions.mix.close(),
      onClick: (event) => {
        if (event.target === event.currentTarget) ctx.actions.mix.close();
      },
    },
    h(
      'div',
      { class: 'dialog-form cs-dialog-body' },
      h(
        'header',
        { class: 'dialog-head' },
        h('h2', { class: 'dialog-title', id: 'mix-dialog-title' }, title),
        h(
          'button',
          {
            type: 'button',
            class: 'btn is-icon is-quiet',
            'aria-label': 'Close',
            onClick: () => ctx.actions.mix.close(),
          },
          icon('x')
        )
      ),
      h('div', { class: 'dialog-body' }, body),
      foot ? h('footer', { class: 'dialog-foot' }, foot) : null
    )
  );
}

function connectDialog(ctx) {
  const boards = ctx.state.boards?.value ?? null;
  const online = boards ? boards.filter((board) => board.online).length : 0;
  return dialog(
    ctx,
    'connect',
    'A little more connected.',
    [
      h(
        'p',
        { class: 'cs-chain', key: 'chain' },
        'Mixxx on the Raspberry Pi',
        ' → ',
        'your Cranium board',
        ' → ',
        'this page'
      ),
      h(
        'p',
        { key: 'what' },
        TEASER_TEXT,
        ' Your board would send the name of each track, its deck, and when it started and stopped; ' +
          'never the music.'
      ),
      h('h3', { class: 'cs-card-title', key: 'coming' }, TEASER_MORE),
      h(
        'ol',
        { class: 'cs-steps', key: 'steps' },
        h(
          'li',
          null,
          h('strong', null, 'Built: '),
          'your board reports to Cranium every 30 seconds, and its updates arrive over the air.'
        ),
        h(
          'li',
          null,
          h('strong', null, `${NOT_BUILT}: `),
          'the Raspberry Pi recording the tracks Mixxx plays, and the board passing them on.'
        ),
        h('li', null, h('strong', null, 'Meanwhile: '), 'import a session file, or explore the demo.')
      ),
      h(
        'p',
        { class: 'cs-connect-state', key: 'state' },
        boards === null
          ? badge('idle', 'chip', 'Your boards are loading')
          : boards.length === 0
            ? badge('idle', 'chip', 'No board on your account yet')
            : badge(
                online > 0 ? 'good' : 'idle',
                online > 0 ? 'online' : 'offline',
                `${online} of ${boards.length} ${boards.length === 1 ? 'board' : 'boards'} online`
              )
      ),
      h('p', { class: 'cs-fine', key: 'note' }, MIXES_NOTE),
    ],
    [
      h(
        'a',
        { key: 'boards', class: 'btn is-quiet', href: '#/devices', onClick: () => ctx.actions.mix.close() },
        'See your boards'
      ),
      h('span', { class: 'dialog-spacer', key: 'spacer' }),
      button('', () => ctx.actions.mix.sample(), icon('download'), h('span', null, 'Sample session file')),
      button(
        'is-primary',
        () => ctx.actions.mix.open({ kind: 'import' }),
        icon('upload'),
        h('span', null, 'Import instead')
      ),
    ]
  );
}

function importDialog(ctx) {
  const { dialog: model } = ctx.mixes;
  return dialog(
    ctx,
    'import',
    'Import a session',
    [
      h(
        'p',
        { key: 'what' },
        'A file this site exported (JSON), or a CSV of the tracks you played, one line each, with these columns:'
      ),
      h(
        'p',
        { class: 'cs-columns-list mono', key: 'columns' },
        'session, started, title, artist, deck, start, end, bpm, key'
      ),
      h(
        'p',
        { class: 'cs-fine', key: 'columns-note' },
        '“started” is when the set began (2026-11-05T21:00:00Z); “start” and “end” are when the track played, in seconds or ' +
          'm:ss from the start of the set; “deck” is A or B. Only “started” and “title” are needed. At most 1 MB.'
      ),
      h(
        'label',
        { class: 'cs-file', key: 'file' },
        h('span', { class: 'field-label' }, 'Session file'),
        h('input', {
          class: 'cs-file-input',
          type: 'file',
          accept: '.json,.csv,application/json,text/csv',
          disabled: model.busy ? '' : null,
          onChange: (event) => ctx.actions.mix.importFile(event.currentTarget.files?.[0] ?? null),
        })
      ),
      model.problem ? h('p', { class: 'field-problem', role: 'alert', key: 'problem' }, model.problem) : null,
      model.done ? h('p', { class: 'cs-done', role: 'status', key: 'done' }, icon('check-circle'), model.done) : null,
      ctx.mixes.storage
        ? null
        : h(
            'p',
            { class: 'cs-fine', key: 'storage' },
            'This browser does not let the site keep data, so the journal lasts until you close the page. Export a backup before you go.'
          ),
    ],
    [
      button('is-quiet', () => ctx.actions.mix.sample(), icon('download'), h('span', null, 'Download a sample')),
      h('span', { class: 'dialog-spacer', key: 'spacer' }),
      model.done
        ? button(
            'is-primary',
            () => {
              ctx.actions.mix.close();
              ctx.actions.mix.setSource('journal');
            },
            'See my journal'
          )
        : button('', () => ctx.actions.mix.close(), 'Cancel'),
    ]
  );
}

function exportDialog(ctx) {
  const { journal } = ctx.mixes;
  const none = journal.sessions.length === 0 && journal.moments.length === 0;
  return dialog(
    ctx,
    'export',
    'Export or back up your journal',
    [
      h(
        'p',
        { key: 'what' },
        'Your journal lives in this browser only. A backup brings it back here, or to another browser, with Import session.'
      ),
      h(
        'ul',
        { class: 'cs-export-list', key: 'list' },
        h(
          'li',
          null,
          h(
            'span',
            null,
            h('strong', null, 'Backup'),
            h('span', { class: 'cs-fine' }, ' · every session and saved moment, as JSON')
          ),
          button('is-small', () => ctx.actions.mix.exportJournal('json'), icon('download'), h('span', null, 'Back up'))
        ),
        h(
          'li',
          null,
          h(
            'span',
            null,
            h('strong', null, 'Spreadsheet'),
            h('span', { class: 'cs-fine' }, ' · every track of every session, as CSV')
          ),
          button('is-small', () => ctx.actions.mix.exportJournal('csv'), icon('download'), h('span', null, 'CSV'))
        )
      ),
      none
        ? h(
            'p',
            { class: 'cs-fine', key: 'none' },
            'Your journal is empty, so the files will be too. The demo is not part of it.'
          )
        : null,
    ],
    [h('span', { class: 'dialog-spacer', key: 'spacer' }), button('', () => ctx.actions.mix.close(), 'Done')]
  );
}

function momentDialog(ctx) {
  const { dialog: model, journal } = ctx.mixes;
  const pair = ctx.mixes.pairs.get(model.id) ?? null;
  const saved = journal.moments.find((moment) => moment.id === model.id) ?? null;
  const from = pair?.from ?? saved?.from;
  const to = pair?.to ?? saved?.to;
  if (!from || !to) return null;
  return dialog(
    ctx,
    'moment',
    'Remember this blend',
    [
      h('p', { class: 'cs-pair-title', key: 'pair' }, from.title, ' → ', to.title),
      h(
        'p',
        { class: 'cs-fine', key: 'meta' },
        [
          pair?.session.title ?? saved?.session,
          (pair?.overlap ?? saved?.overlap) !== null ? `${pair?.overlap ?? saved?.overlap}s overlap` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      ),
      h(
        'label',
        { class: 'field', key: 'note' },
        h('span', { class: 'field-label' }, 'Your note'),
        h('textarea', {
          id: 'moment-note',
          class: 'input cs-note-input',
          rows: '4',
          maxlength: String(LIMITS.note),
          placeholder: 'What made it work? The filter on B, the key, the loop…',
          value: model.note,
          onInput: (event) => ctx.actions.mix.setNote(event.currentTarget.value),
        }),
        h(
          'span',
          { class: 'field-hint' },
          `Kept in this browser with your journal. ${LIMITS.note - model.note.length} characters left.`
        )
      ),
    ],
    [
      saved
        ? button(
            'is-danger-quiet',
            () => ctx.actions.mix.forgetMoment(model.id),
            mixIcon('trash'),
            h('span', null, 'Forget it')
          )
        : null,
      h('span', { class: 'dialog-spacer', key: 'spacer' }),
      button('', () => ctx.actions.mix.close(), 'Cancel'),
      pair || saved
        ? button(
            'is-primary',
            () => ctx.actions.mix.saveMoment(),
            mixIcon('bookmark'),
            h('span', null, saved ? 'Save the note' : 'Keep it')
          )
        : null,
    ]
  );
}

function forgetDialog(ctx) {
  const session = ctx.mixes.journal.sessions.find((item) => item.id === ctx.mixes.dialog.id);
  if (!session) return null;
  return dialog(
    ctx,
    'forget',
    'Remove this session?',
    [
      h(
        'p',
        { key: 'what' },
        `“${session.title}”, of ${sessionDay(session.startedAt)}, leaves your journal in this browser. ` +
          'Saved moments of it stay. Export a backup first if you might want it again.'
      ),
    ],
    [
      h('span', { class: 'dialog-spacer', key: 'spacer' }),
      button('', () => ctx.actions.mix.close(), 'Keep it'),
      button('is-danger', () => ctx.actions.mix.forgetSession(session.id), mixIcon('trash'), h('span', null, 'Remove')),
    ]
  );
}

export function mixDialog(ctx) {
  const kind = ctx.mixes?.dialog?.kind;
  if (kind === 'connect') return connectDialog(ctx);
  if (kind === 'import') return importDialog(ctx);
  if (kind === 'export') return exportDialog(ctx);
  if (kind === 'moment') return momentDialog(ctx);
  if (kind === 'forget') return forgetDialog(ctx);
  return null;
}
