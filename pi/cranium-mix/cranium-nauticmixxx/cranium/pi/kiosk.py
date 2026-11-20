"""Generate a minimal appliance Sway config while retaining display/touch setup."""
import re


def hardware_settings(text):
    output = []
    lines = iter(text.splitlines())
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('set $'):
            output.append(line)
        elif stripped.startswith(('input ', 'output ')):
            block = [line]
            depth = line.count('{') - line.count('}')
            while depth > 0:
                next_line = next(lines)
                block.append(next_line)
                depth += next_line.count('{') - next_line.count('}')
            # Wallpapers are replaced with Cranium, retain modes, transforms,
            # touch maps, libinput options, scale and connector placement.
            cleaned = []
            for entry in block:
                if re.search(r'\b(?:bg|background)\b', entry):
                    entry = re.sub(r'\b(?:bg|background)\s+.*?(?=\s*\}|$)', '', entry)
                    if entry.strip().startswith('output ') and '{' not in entry and len(entry.split()) == 2:
                        continue
                if entry.strip():
                    cleaned.append(entry)
            output.extend(cleaned)
    return '\n'.join(output)


def configure_sway(original):
    hardware = hardware_settings(original)
    defaults = ''.join('set $' + name + ' ' + value + '\n' for name, value in [('mod', 'Mod1'), ('term', 'foot')]
                       if not re.search(r'^set \$' + name + r'\s', hardware, re.MULTILINE))
    return '''# CRANIUM appliance session. Desktop is available in Developer Tools.
''' + defaults + hardware + '''
output * bg /usr/local/share/cranium/start.png fill
seat seat0 hide_cursor 1200
seat seat0 fallback true
default_border none
default_floating_border none
gaps inner 0
gaps outer 0
font pango:DejaVu Sans 11
popup_during_fullscreen smart
focus_on_window_activation none
for_window [app_id="org.mixxx.Mixxx" title="^CRANIUM"] fullscreen enable
for_window [app_id="org.mixxx.Mixxx" title="^CRANIUM"] inhibit_idle open
# Recovery shortcut is deliberate; normal touch use exposes no desktop chrome.
bindsym Ctrl+Mod1+d exec /usr/local/bin/cranium-session developer
mode "cranium-developer" {
    bindsym $mod+Return exec $term
    bindsym $mod+d exec fuzzel
    bindsym $mod+Shift+q kill
    bindsym $mod+Left focus left
    bindsym $mod+Right focus right
    bindsym $mod+Up focus up
    bindsym $mod+Down focus down
    bindsym Ctrl+Mod1+d exec /usr/local/bin/cranium-session kiosk
    bindsym $mod+Shift+Escape exec /usr/local/bin/cranium-session kiosk
}
exec dbus-update-activation-environment --systemd DISPLAY WAYLAND_DISPLAY SWAYSOCK XDG_CURRENT_DESKTOP
exec /usr/local/bin/cranium-session start
exec /usr/local/bin/cranium-media
exec /usr/local/bin/cranium-launch auto
exec /usr/local/bin/cranium-performance --startup
'''
