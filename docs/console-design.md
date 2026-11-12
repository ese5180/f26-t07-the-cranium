# Console design

The console (console.craniumiot.com, the admin mode of the phone apps, and the desktop app) is one set of pages:
`cloud/web/src/site/assets/`. From console 2.9.0 it is laid out as an app: phone first, and still at home in a
desktop browser. This page says what it follows and where each part is.

## Design principles

What the console applies, and where it comes from:

- **Content first, one column on a phone** (mobile-web practice). A page is its large title, a line under it, then
  sections. No grid of cards: a section is a heading over one group.
- **Grouped, inset lists** (Apple HIG, Lists and tables; Material 3, Lists). A group is a rounded surface inset from
  the edges, its rows parted by hairlines. A row has a leading mark of state, its primary text, its secondary detail,
  and a trailing value or a chevron when the whole row leads somewhere. Facts are label and value on one row, as in
  Settings.
- **A tab bar of the primary sections, the rest under More** (HIG, Tab bars; Material 3, Navigation bar). From console
  2.28.0 (#114) four tabs, Overview, Devices, Deploy (Deployments) and Alerts, and More, which opens a sheet with the
  others in their groups and the account. The bar floats: a pill a gap in from the sides and the foot, the current tab
  a smaller pill inside it, and the page runs on under it. From 861 px wide a sidebar holds every section in four
  groups (the main three; Releases; Monitoring; Admin) and who is signed in (Material 3, Navigation drawer), and the
  content stops at 76 rem, in two columns only where a page has two things to set side by side.
- **One place for each thing** (#115). The Fleet page is gone: its board types and groups are on Devices, its staged
  rollouts, Update everything and Roll back to last good on Deployments. `#/fleet` leads to Deployments and says so
  (`core.js` `MOVED`). Board setup belongs to Devices ("Set up a board"), and Memfault is named Crashes in the nav.
- **Designed with the screen's rounded corners** (#212). On an iPhone 17 Pro the corners are about 55 pt. Nothing is
  kept out of them with blank padding: what floats near a corner is concentric with it, set a gap in from the edge with
  the radius 55 less that gap (the tab bar 24 px in, radius 31; a sheet or a dialog 8 px in, radius 47 at the top and
  the foot alike; a group inside a sheet 16 px further in, radius 31). Backgrounds run edge to edge into the corners.
  In a browser the screen's radius is 0 and the same rules give a 12 px gap and the usual card radius.
- **A large title that collapses** (HIG, Navigation bars). The page's own heading is large; once it has scrolled under
  the top bar, the bar shows it small. Section headings stay at the top while their rows go by.
- **Sheets for actions** (HIG, Sheets; Material 3, Bottom sheets). On a phone More and every dialog rise from the
  foot of the screen; a dialog keeps one height for all of its steps, so that its buttons do not move.
- **Back works with the browser** (HIG, Navigation). A page's Back goes back in the history when that is where it
  leads, so the page's Back, the browser's and Android's agree and the place in the list is kept.
- **Targets of 44 pt or more** (HIG; WCAG 2.2, 2.5.8 Target size). Tabs are 56 px tall, rows and the bar's buttons
  at least 44 px.
- **Type that scales** (HIG, Typography and Dynamic Type). System fonts in rem, at 400 to 700; nothing is set in
  pixels that should grow with the reader's text size.
- **Contrast and colour** (WCAG 2.2 AA, 1.4.3 and 1.4.11). Text 4.5:1 and marks 3:1 in both themes, checked by
  `cloud/web/test/site.test.mjs`. A state is never colour alone: its word or icon is next to it.
- **Dark mode, reduced motion, keyboard and forced colours** (prefers-color-scheme, prefers-reduced-motion, WCAG
  2.4.7 and 2.4.11). Every colour is a token with a dark value; motion stops when asked; the focus ring is always
  drawn and never under a bar; the current tab is outlined in forced colours.
- **Safe areas** (mobile-web practice). The bars keep clear of the notch and the home indicator with
  `env(safe-area-inset-*)`, through `--safe-*` (`viewport-fit=cover` in `index.html`).
- **Loading, empty and error states that say what to do** (Material 3; skeletons over spinners). A section that is
  loading shows grey lines where its rows will be, with what it is loading in words; a page with nothing yet says how
  to make the first one; a failed read says what could not be read, with Try again.

## Tokens

All in `:root` of `app.css`, with dark values under `prefers-color-scheme: dark`:

| Token | Use |
| --- | --- |
| `--grouped`, `--surface` | the page behind the groups, and the groups |
| `--bar`, `--scrim` | the top bar and tab bar; behind a sheet |
| `--ink`, `--ink-2`, `--ink-3` | text, secondary, tertiary |
| `--accent`, `--accent-wash` | the current tab, links that act, the brand |
| `--good`, `--warn`, `--bad`, `--work` and their washes | states, always with a word or an icon |
| `--space-1` … `--space-6` | 4, 8, 12, 16, 24, 32 px |
| `--radius-group`, `--tap`, `--topbar`, `--tabbar`, `--sidebar`, `--content` | the frame's sizes |
| `--radius-screen` | the screen's own corner: 55px where there is a bottom safe area, else 0 (console 2.28.0) |
| `--edge-gap`, `--radius-tabbar`, `--radius-tab` | the floating tab bar's gap, its pill, and the current tab's pill inside it |
| `--sheet-gap`, `--radius-sheet`, `--radius-inset` | a sheet's or a phone dialog's gap, its corners, and a group's inside it |

The customer site (`cloud/web/src/customer/`) shares these colours and its grouped look. It also loads `app.css`, so
the console's page rules are under the `console` class of the console's `<body>`.

## Components

From console 2.25.17 the pieces every page uses have one set of names, `ui-*`, in `app.css` ("Shared components"):
page head, card, stat tile, table, filter bar, buttons, badges, step list, meter, the empty, loading and error states,
notice, toast and dialog. A new page uses these names only. The older names (`btn`, `badge`, `card`, `data-table`,
`dialog` and the rest) are aliases for one release: the rules that style a piece on its own carry both, and the views write
both. Each page's redesign moves its own rules to the new names; then the older names go. A board is named by its label
first and its ID second (`ui-board`). `cloud/web/test/site.test.mjs` pins the names, the aliases and their contrast.

## Where things are

| Part | Code |
| --- | --- |
| The frame: top bar, tab bar, More sheet, sidebar | `index.html`, `app.css` "The frame", `views.js` `navView` (`SECTIONS`, `NAV_GROUPS`, `TAB_LABELS`), `app.js` `showMore` |
| The large title | `app.js` `watchTitle`, `#masthead-title` |
| Grouped lists | `app.css` "Console 2.7: grouped lists", `views.js` `card()` (`.card-body`) |
| The Overview's glance strip | `views.js` `glanceStrip` |
| Icons (one stroke set) | `views.js` `ICONS` |
| Search and filters of a long list | `views.js` `filterBar`, `filterSelect`, `filterDay`; `app.css` "Search and filters"; [search-filters.md](search-filters.md) |

The renderer is `views.js` `h()` and `render()`. The pages' policy forbids inline style, so a value that a page sets
is a CSS custom property through the `vars` prop. The words are compared with the phone apps' own by their tests, so a
word changes only with its native constant.
