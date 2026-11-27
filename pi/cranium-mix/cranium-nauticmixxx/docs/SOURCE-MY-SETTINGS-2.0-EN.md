# SOURCE and MY SETTINGS — NauticMixxx 2.0 development

The upper navigation row follows SOURCE, BROWSE, TAG LIST, PLAYLIST, SEARCH,
MENU in BROWSE/SOURCE, reached with the existing assigned SOURCE command.
PERFORMANCE retains its original countdown/progress rail without navigation
buttons. INFO remains on the right. SOURCE keeps its own full-width title row
above DEVICE NAME and device information. USB icons, their labels and arrows
are separated; SOURCE has no synthetic TOOLS device.

Highlight a connected, ready USB in SOURCE. BROWSE opens its categories,
TAG LIST opens that session's tagged tracks, PLAYLIST opens its exported
playlist tree, and SEARCH searches its tracks. These buttons resolve the
highlighted SOURCE device before opening their view, even if another USB
was previously browsed. Without a ready source, music navigation is disabled.
MENU opens the unified UTILITY settings/operations table; the existing
controller TOOLS command is an alias for this same view.
Beat FX and software settings remain
available without USB. The established controller gestures are unchanged.

## MY SETTINGS MENU

The button opens a separate right-side SOURCE panel, retaining the selected
device list and browser footer. It does not open SHORTCUT.

- LOAD reads supported preferences from that selected USB's Pioneer settings
  files using the shared SHORTCUT loader. Pause both decks before loading.
  Headers, file lengths, enumerations and CRC are validated before applying
  changes. Missing or invalid files produce an explicit message. Hardware-only
  preferences are not applied; the full loader result is available in the
  status tooltip. The SOURCE panel keeps its USB root through the load action.
- BACKGROUND COLOR offers DEFAULT, RED, ORANGE, YELLOW, GREEN, AQUA, BLUE and
  PURPLE accents for the USB icon and browser device label. It saves a small
  versioned `PIONEER/NAUTIC_BACKGROUND_COLOR.json` on that USB, so NauticMixxx
  can restore it after reconnection or on another computer. This is a Nautic
  extension, not a Pioneer background-color format. Original DAT/PDB files
  remain unchanged. A failed write is reported and does not apply the choice.
- WAVEFORM COLOR offers BLUE, RGB and 3BAND. It updates the same native waveform
  setting as SHORTCUT and persists in the Nautic profile. RX3 detailed and
  overview waveforms follow the factory's existing style-change notification.

Turn the controller's BROWSER encoder past the final USB to select MY SETTINGS
MENU, then short-press to open. Turn through LOAD and both color options;
press to open a color list, turn to choose, and press to apply. Each panel
includes encoder-selectable BACK. The existing back gesture also works.
Continuing beyond MY SETTINGS MENU reaches the upper navigation buttons.
Changing or removing the source closes its settings panel.

Common controls in `[RX3Browser]` include `source`, `browse`, `tag_list`,
`playlist`, `search`, `my_settings`, `tools`, `move`, `enter` and `back`.
Command controls are pulsed back to zero. No controller-specific gesture was
reassigned to add these capabilities.

The RX3 instruction manual describes SOURCE MY SETTINGS independently from
SHORTCUT and defines BACKGROUND COLOR as a USB icon/screen accent rather than
a waveform color: [Pioneer DJ XDJ-RX3 instruction manual, page 22](https://manuals.plus/m/abad2088de2b2dcacd1c2de6f0ae3790806238e676ae6597a9e31d2fdb698857_optim.pdf).

The delivered `2.0.0-source-settings-2` test candidate includes SOURCE settings,
navigation and the original PERFORMANCE topbar. Native tests and isolated Qt
renders do not certify physical controller behavior or Pioneer interoperability
of Nautic's separate accent file.
