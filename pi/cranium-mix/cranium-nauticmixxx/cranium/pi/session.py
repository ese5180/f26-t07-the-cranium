#!/usr/bin/python3
"""Cranium session shell. Desktop access is explicit and lasts this boot only."""
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time

RUNTIME = Path(os.environ.get('XDG_RUNTIME_DIR', '/run/user/' + str(os.getuid())))
MARKER = RUNTIME / 'cranium-developer'


def ipc(command):
    result = subprocess.run(['swaymsg', '-r', command], capture_output=True, text=True, timeout=2)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or 'Window manager unavailable')
    replies = json.loads(result.stdout)
    if isinstance(replies, list) and any(not entry.get('success', False) for entry in replies):
        raise RuntimeError('Window manager rejected a mode change')


def windows(node, hidden=False):
    hidden = hidden or (node.get('type') == 'workspace' and node.get('name') == '__i3_scratch')
    for child in node.get('nodes', []) + node.get('floating_nodes', []):
        yield from windows(child, hidden)
    if node.get('app_id') or node.get('window'):
        yield {**node, '_cranium_hidden': hidden}


def kiosk_actions(tree):
    """Return exact container commands; never evaluate window titles as code."""
    nodes = list(windows(tree))
    mains = [node for node in nodes if node.get('app_id') == 'org.mixxx.Mixxx'
             and (node.get('name') or '').startswith('CRANIUM')]
    if not mains:
        return []
    main = mains[0]
    commands = []
    for node in nodes:
        if node.get('app_id') != 'org.mixxx.Mixxx' and not node.get('_cranium_hidden') and node.get('scratchpad_state', 'none') == 'none':
            commands.append(f'[con_id={int(node["id"])}] move scratchpad')
    if main.get('fullscreen_mode') != 1:
        commands.append(f'[con_id={int(main["id"])}] fullscreen enable')
    # Refocus only when an unrelated app has focus, not every timer tick.
    if any(node.get('focused') and node.get('app_id') != 'org.mixxx.Mixxx' for node in nodes):
        commands.append(f'[con_id={int(main["id"])}] focus')
    return commands


def enforce():
    if MARKER.exists():
        return
    result = subprocess.run(['swaymsg', '-r', '-t', 'get_tree'], capture_output=True, text=True, timeout=2)
    if result.returncode:
        return
    tree = json.loads(result.stdout)
    # A mapped window is observable readiness, not proof that audio is ready.
    for node in windows(tree):
        if node.get('app_id') == 'org.mixxx.Mixxx' and (node.get('name') or '').startswith('CRANIUM'):
            marker = RUNTIME / 'cranium-window.json'
            try:
                previous = json.loads(marker.read_text()) if marker.exists() else {}
                if previous.get('pid') != node.get('pid'):
                    temporary = marker.with_suffix('.new')
                    temporary.write_text(json.dumps({'pid': node.get('pid'),
                        'uptime_seconds': float(Path('/proc/uptime').read_text().split()[0])}))
                    temporary.replace(marker)
            except (OSError, ValueError):
                pass
            break
    for command in kiosk_actions(tree):
        ipc(command)


def keyboard_supervisor(start):
    """The native search keyboard needs no external keyboard process."""
    pidfile = RUNTIME / 'osk-supervisor.pid'
    pid = None
    try:
        candidate = int(pidfile.read_text())
        arguments = (Path('/proc') / str(candidate) / 'cmdline').read_bytes().split(b'\0')
        if candidate > 1 and b'/usr/local/bin/cranium-osk-supervisor' in arguments:
            pid = candidate
    except (OSError, ValueError):
        pass
    if start and pid is None:
        state = Path.home() / '.local/state/cranium'
        state.mkdir(parents=True, exist_ok=True)
        with (state / 'desktop.log').open('a') as log:
            subprocess.Popen(['/usr/local/bin/cranium-osk-supervisor'],
                             stdout=log, stderr=log, start_new_session=True)
    elif not start and pid is not None:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


def stop_bar():
    pidfile = RUNTIME / 'cranium-waybar.pid'
    try:
        pid = int(pidfile.read_text())
        if (Path('/proc') / str(pid) / 'comm').read_text().strip() == 'waybar':
            os.kill(pid, signal.SIGTERM)
    except (OSError, ValueError):
        pass
    pidfile.unlink(missing_ok=True)
    subprocess.run(['pkill', '-u', str(os.getuid()), '-x', 'waybar'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def change_mode(developer):
    RUNTIME.mkdir(parents=True, exist_ok=True)
    if developer:
        # Only set the marker after the compositor accepts the mode.
        ipc('mode "cranium-developer"')
        MARKER.write_text('temporary developer desktop\n')
        try:
            keyboard_supervisor(True)
            ipc('[app_id="org.mixxx.Mixxx"] fullscreen disable')
            ipc('[app_id="org.mixxx.Mixxx"] border normal')
            if not (RUNTIME / 'cranium-waybar.pid').exists():
                state = Path.home() / '.local/state/cranium'
                state.mkdir(parents=True, exist_ok=True)
                log = open(state / 'desktop.log', 'a')
                bar = subprocess.Popen(['waybar'], stdout=log, stderr=log)
                (RUNTIME / 'cranium-waybar.pid').write_text(str(bar.pid))
        except Exception:
            MARKER.unlink(missing_ok=True)
            keyboard_supervisor(False)
            ipc('mode "default"')
            enforce()
            raise
    else:
        MARKER.unlink(missing_ok=True)
        keyboard_supervisor(False)
        stop_bar()
        ipc('mode "default"')
        ipc('[app_id="org.mixxx.Mixxx"] border none')
        enforce()
        # Developer trial apps can replace Cranium; returning must relaunch it.
        tree = subprocess.run(['swaymsg', '-r', '-t', 'get_tree'], capture_output=True, text=True, timeout=2)
        if tree.returncode == 0 and not any(node.get('app_id') == 'org.mixxx.Mixxx' and
                (node.get('name') or '').startswith('CRANIUM') for node in windows(json.loads(tree.stdout))):
            subprocess.Popen(['/usr/local/bin/cranium-launch', 'nauticmixxx'], start_new_session=True)



def guard():
    RUNTIME.mkdir(parents=True, exist_ok=True)
    with (RUNTIME / 'cranium-shell.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        MARKER.unlink(missing_ok=True)
        keyboard_supervisor(False)
        stop_bar()
        monitor = subprocess.Popen(['swaymsg', '-m', '-r', '-t', 'subscribe', '["window"]'],
                                   stdout=subprocess.PIPE, text=True, bufsize=1)
        try:
            while monitor.poll() is None:
                # Window events enforce immediately; idle recovery is a slower
                # safety check, avoiding one full compositor tree read/second.
                ready, _, _ = select.select([monitor.stdout], [], [], 10)
                if ready:
                    line = monitor.stdout.readline()
                    if not line:
                        break
                try:
                    enforce()
                except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
                    pass
        finally:
            monitor.terminate()


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else 'start'
    if action == 'start':
        guard()
    elif action in ('developer', 'kiosk'):
        change_mode(action == 'developer')
    else:
        raise SystemExit('Expected start, developer or kiosk')


if __name__ == '__main__':
    main()
