#!/usr/bin/python3
"""One automounter per session; keep removable USB music working."""
import fcntl
import os
from pathlib import Path
import shutil
import signal
import subprocess


def command(find=shutil.which):
    if executable := find('udiskie'):
        return [executable, '--no-tray']
    if executable := find('devmon'):
        return [executable]
    raise RuntimeError('No USB automounter installed; Developer Tools can inspect this.')


def main():
    runtime = Path(os.environ['XDG_RUNTIME_DIR'])
    state = Path.home() / '.local/state/cranium'
    state.mkdir(parents=True, exist_ok=True)
    with (runtime / 'cranium-media.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        path = state / 'media.log'
        if path.exists() and path.stat().st_size > 1_000_000:
            path.replace(path.with_suffix('.previous.log'))
        with path.open('a') as log:
            child = subprocess.Popen(command(), stdout=log, stderr=log)
            def stop(_signum, _frame):
                child.terminate()
            signal.signal(signal.SIGTERM, stop)
            signal.signal(signal.SIGINT, stop)
            raise SystemExit(child.wait())


if __name__ == '__main__':
    main()
