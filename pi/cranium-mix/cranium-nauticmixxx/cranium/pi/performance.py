#!/usr/bin/python3
"""Bounded, read-only performance capture. Never changes audio or power settings."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

PROC = Path('/proc')
SYS = Path('/sys')
RUNTIME = Path(os.environ.get('XDG_RUNTIME_DIR', '/run/user/' + str(os.getuid())))
STATE = Path.home() / '.local/state/cranium'


def read(path):
    try:
        return path.read_text().strip()
    except OSError:
        return ''


def number(path, scale=1):
    try:
        return float(read(path)) / scale
    except ValueError:
        return None


def run(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=3)
        return {'status': 'ok' if result.returncode == 0 else 'unavailable',
                'text': (result.stdout + result.stderr)[:24000].strip()}
    except (OSError, subprocess.TimeoutExpired):
        return {'status': 'unavailable', 'text': ''}


def throttle_flags(text):
    try:
        value = int(text.strip().split('=')[-1], 16)
    except ValueError:
        return None
    labels = ['undervoltage', 'frequency_capped', 'throttled', 'soft_temperature_limit']
    return {'raw': hex(value),
            'current': [label for bit, label in enumerate(labels) if value & (1 << bit)],
            'since_boot': [label for bit, label in enumerate(labels) if value & (1 << (bit + 16))]}


def memory(text):
    values = {}
    for line in text.splitlines():
        fields = line.split()
        if fields and fields[0].rstrip(':') in ('MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'):
            try:
                values[fields[0].rstrip(':') + '_kib'] = int(fields[1])
            except (ValueError, IndexError):
                pass
    return values


def cpu_counters(text):
    for line in text.splitlines():
        fields = line.split()
        if fields and fields[0] == 'cpu':
            values = [int(value) for value in fields[1:9]]
            if len(values) == 8:
                return {'total_ticks': sum(values), 'idle_ticks': values[3], 'iowait_ticks': values[4]}
    return None


def rates(previous, current):
    """Whole-machine CPU use; iowait is separate, not counted as busy CPU."""
    if not previous or not current:
        return None
    total = current['total_ticks'] - previous['total_ticks']
    if total <= 0:
        return None
    idle = current['idle_ticks'] - previous['idle_ticks']
    wait = current['iowait_ticks'] - previous['iowait_ticks']
    return {'busy_percent': round(100 * max(0, total - idle - wait) / total, 2),
            'iowait_percent': round(100 * max(0, wait) / total, 2)}


def app_metrics():
    try:
        event = json.loads(read(RUNTIME / 'cranium-launch.json'))
        pid = int(event['pid'])
        base = PROC / str(pid)
        # The launcher execs through to the native app with the same PID.
        if read(base / 'comm') != 'NauticMixxx' or base.stat().st_uid != os.getuid():
            return None
        status = read(base / 'status')
        fields = read(base / 'stat').rsplit(')', 1)[1].split()
        return {'pid': pid, 'cpu_ticks': int(fields[11]) + int(fields[12]),
                'resident_kib': next((int(line.split()[1]) for line in status.splitlines()
                                      if line.startswith('VmRSS:')), None),
                'major_faults': int(fields[9])}
    except (OSError, ValueError, KeyError, IndexError):
        return None


def snapshot():
    vm = {}
    for line in read(PROC / 'vmstat').splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] in ('pgmajfault', 'pswpin', 'pswpout'):
            vm[parts[0]] = int(parts[1])
    throttle = run(['vcgencmd', 'get_throttled'])
    return {'uptime_seconds': float((read(PROC / 'uptime') or '0').split()[0]),
            'cpu': cpu_counters(read(PROC / 'stat')),
            'memory': memory(read(PROC / 'meminfo')), 'vm_counters': vm,
            'temperature_celsius': number(SYS / 'class/thermal/thermal_zone0/temp', 1000),
            'frequency_mhz': number(SYS / 'devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', 1000),
            'governor': read(SYS / 'devices/system/cpu/cpu0/cpufreq/scaling_governor') or None,
            'throttling': throttle_flags(throttle['text']) if throttle['status'] == 'ok' else None,
            'pressure': {name: read(PROC / 'pressure' / name) or None for name in ('cpu', 'memory', 'io')},
            'app': app_metrics()}


def startup_timing():
    try:
        launched = json.loads(read(RUNTIME / 'cranium-launch.json'))
        mapped = json.loads(read(RUNTIME / 'cranium-window.json'))
        if launched['pid'] == mapped['pid'] and mapped['uptime_seconds'] >= launched['uptime_seconds']:
            return {'app_launch_uptime_seconds': launched['uptime_seconds'],
                    'first_window_uptime_seconds': mapped['uptime_seconds'],
                    'launch_to_window_seconds': round(mapped['uptime_seconds'] - launched['uptime_seconds'], 2),
                    'meaning': 'window mapped; audio readiness not measured'}
    except (ValueError, KeyError, TypeError):
        pass
    return {'status': 'window timing unavailable'}


def save(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.new')
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def capture(seconds, interval, startup=False):
    STATE.mkdir(parents=True, exist_ok=True)
    report = {'format': 1, 'kind': 'startup' if startup else 'manual',
              'samples': [], 'interval_seconds': interval,
              'audio_underruns_measured': False, 'audio_settings_changed': False}
    previous = None
    previous_app = None
    previous_uptime = None
    start = time.monotonic()
    while True:
        tick = time.monotonic()
        sample = snapshot()
        sample['cpu_usage'] = rates(previous, sample['cpu'])
        previous = sample['cpu']
        app = sample['app']
        if app and previous_app and app['pid'] == previous_app['pid']:
            elapsed = sample['uptime_seconds'] - previous_uptime
            if elapsed > 0:
                app['cpu_percent_one_core'] = round(100 * (app['cpu_ticks'] - previous_app['cpu_ticks']) /
                    os.sysconf('SC_CLK_TCK') / elapsed, 2)
        previous_app, previous_uptime = app, sample['uptime_seconds']
        report['samples'].append(sample)
        if not startup:
            print(f"Captured {len(report['samples'])}: CPU {sample['cpu_usage']}, "
                  f"temperature {sample['temperature_celsius']} C", flush=True)
        remaining = seconds - (time.monotonic() - start)
        if remaining <= 0:
            break
        time.sleep(min(remaining, max(0, interval - (time.monotonic() - tick))))
    report['elapsed_seconds'] = round(time.monotonic() - start, 2)
    report['startup'] = startup_timing()
    # These run after sampling, not on the critical application startup path.
    report['boot'] = {name: run(['systemd-analyze', *arguments]) for name, arguments in
                      [('time', ['time']), ('blame', ['blame', '--no-pager']),
                       ('critical_chain', ['critical-chain', 'display-manager.service', '--no-pager'])]}
    usage = shutil.disk_usage('/')
    report['root_storage'] = {'total_bytes': usage.total, 'free_bytes': usage.free}
    path = STATE / ('startup-performance.json' if startup else 'performance.json')
    save(path, report)
    print('CRANIUM performance report saved: ' + str(path), flush=True)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--startup', action='store_true')
    parser.add_argument('--seconds', type=int, default=120)
    parser.add_argument('--interval', type=int, default=10)
    parser.add_argument('--show', action='store_true', help='Keep the developer terminal open after capture')
    args = parser.parse_args()
    if not 1 <= args.seconds <= 600 or not 1 <= args.interval <= 60:
        parser.error('Capture must be 1–600 seconds, interval 1–60 seconds.')
    if args.startup and Path('/boot/firmware/cranium-no-diagnostics').exists():
        return
    RUNTIME.mkdir(parents=True, exist_ok=True)
    with (RUNTIME / 'cranium-performance.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('A short performance capture is already running. Try again shortly.')
        else:
            done = RUNTIME / 'cranium-performance-done'
            if args.startup and done.exists():
                return
            os.nice(19)
            if args.startup:
                time.sleep(30)
            capture(args.seconds, args.interval, args.startup)
            if args.startup:
                done.touch()
    if args.show:
        input('Press Enter to close. Audio settings were not changed. ')


if __name__ == '__main__':
    main()
