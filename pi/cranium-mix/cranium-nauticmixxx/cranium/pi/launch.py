#!/usr/bin/python3
"""Launch one isolated DJ app and show startup errors in the touchscreen UI."""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

home = Path.home()
developer_marker = Path(os.environ.get('XDG_RUNTIME_DIR', '/run/user/' + str(os.getuid()))) / 'cranium-developer'
state = home / '.local/state/cranium'
state.mkdir(parents=True, exist_ok=True)
preference = home / '.config/cranium/app'
selection = sys.argv[1] if len(sys.argv) > 1 else 'auto'
if selection == 'auto':
    boot = Path('/boot/firmware/cranium-app.txt')
    selection = boot.read_text().strip() if boot.exists() else 'auto'
    if selection == 'auto':
        selection = preference.read_text().strip() if preference.exists() else 'bitedj'
if not developer_marker.exists():
    selection = 'nauticmixxx'
if selection not in ('nauticmixxx', 'bitedj', 'mixxx'):
    selection = 'mixxx'

with (state / 'app.lock').open('w') as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        pidfile = state / 'app.pid'
        if pidfile.exists():
            oldpid = int(pidfile.read_text().strip())
            subprocess.run(['swaymsg', f'[pid={oldpid}] kill'], check=False)
        for _ in range(100):
            time.sleep(0.1)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                pass
        else:
            sys.exit('The current app has not closed; a second DJ app was not started.')
    supervisor = Path(os.environ.get('XDG_RUNTIME_DIR', '/nonexistent')) / 'osk-supervisor.pid'
    try:
        pid = int(supervisor.read_text().strip())
        if pid > 1:
            os.kill(pid, signal.SIGUSR1)
    except (OSError, ValueError):
        pass
    preference.parent.mkdir(parents=True, exist_ok=True)
    preference.write_text(selection + '\n')
    env = os.environ.copy()
    if selection in ('bitedj', 'nauticmixxx'):
        root = Path('/opt/cranium') / selection
        env.update(LD_LIBRARY_PATH=str(root / 'lib/cranium'),
                   QT_PLUGIN_PATH=str(root / 'lib/qt6/plugins'),
                   QT_QPA_PLATFORM='wayland', QT_SCALE_FACTOR='1', QT_AUTO_SCREEN_SCALE_FACTOR='0')
        if selection == 'nauticmixxx':
            env['NAUTICMIXXX_PROFILE'] = str(home / '.cranium-nauticmixxx')
            env['CRANIUM_APPLIANCE'] = '1'
            command = [str(root / 'bin/nauticmixxx'), '--full-screen']
        else:
            command = [str(root / 'bin/mixxx'), '--full-screen',
                       '--settings-path', str(home / '.cranium-bitedj'),
                       '--resource-path', str(root / 'share/mixxx')]
    else:
        command = ['/usr/bin/mixxx']
    logfile = state / (selection + '.log')
    # A normal-mode exit returns to Cranium rather than exposing a desktop.
    for attempt in range(4):
        with logfile.open('a') as log:
            try:
                app = subprocess.Popen(command, env=env, stdout=log, stderr=log)
                (state / 'app.pid').write_text(str(app.pid) + '\n')
                try:
                    marker = developer_marker.parent / 'cranium-launch.json'
                    temporary = marker.with_suffix('.new')
                    temporary.write_text(json.dumps({'pid': app.pid, 'app': selection,
                        'uptime_seconds': float(Path('/proc/uptime').read_text().split()[0])}))
                    temporary.replace(marker)
                except (OSError, ValueError):
                    pass  # Diagnostics must never prevent playback startup.
                result = app.wait()
            except OSError as error:
                log.write('Cranium launcher error: ' + str(error) + '\n')
                result = 1
            finally:
                (state / 'app.pid').unlink(missing_ok=True)
        if developer_marker.exists() or selection != 'nauticmixxx':
            sys.exit(result)
        time.sleep(1)
    # Keep the branded background if startup repeatedly fails. Recovery is
    # explicit; no terminal, browser or alternate app opens automatically.
    subprocess.run(['swaynag', '-t', 'error', '--layer', 'overlay',
                    '-m', 'CRANIUM could not start. Retry or open Developer Tools.',
                    '-Z', 'RETRY', '/usr/local/bin/cranium-launch auto',
                    '-Z', 'DEVELOPER TOOLS', '/usr/local/bin/cranium-session developer',
                    '--dismiss-button', 'CLOSE', '--background', '080808',
                    '--button-background', '222222'], check=False)
    sys.exit(result)
