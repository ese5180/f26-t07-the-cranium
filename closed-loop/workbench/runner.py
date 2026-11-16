import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
from .build import ROOT, build, flash, source_hash
from .instruments import PowerMeter, functional_capture, logic_devices, serial_inventory
from .analysis import compare_power


def requirements():
    return json.loads((ROOT / 'requirements.json').read_text())


def config():
    path = ROOT / 'bench.local.json'
    return json.loads((path if path.exists() else ROOT / 'bench.example.json').read_text())


def save(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n'); temp.replace(path)


def doctor(cfg):
    from ppk2_api.ppk2_api import PPK2_API
    ports = serial_inventory()
    reasons = []
    try:
        logic = logic_devices(cfg['saleae_port'])
    except Exception as error:
        logic = []
        reasons.append('Open Saleae Logic 2 and enable Automation API on port 10430: ' + str(error)[:180])
    ppk = PPK2_API.list_devices()
    if not str(cfg.get('board_serial', '')).isdigit():
        reasons.append('Set the nRF7002 DK J-Link serial in bench.local.json')
    if cfg.get('uart_port') not in [p['port'] for p in ports]:
        reasons.append('Connect the DK debug USB and select its VCOM uart_port')
    else:
        selected=next(p for p in ports if p['port']==cfg['uart_port'])
        serial=(selected.get('serial') or '').split('_')[0]
        if selected['vid']!=0x1366 or not serial.isdigit() or not str(cfg['board_serial']).isdigit() or int(serial)!=int(cfg['board_serial']):
            reasons.append('Selected VCOM must belong to the configured J-Link serial')
    if not any(not d['simulation'] and d['id'] == cfg.get('saleae_device_id') for d in logic):
        reasons.append('Connect and select a real Saleae; simulated devices cannot pass HIL')
    if cfg.get('ppk2_port') not in ppk:
        reasons.append('Connect and select the Nordic PPK2')
    if cfg.get('power_wiring_verified') is not True:
        reasons.append('Verify power-rail wiring and voltage, then set power_wiring_verified=true')
    if cfg.get('radio_disconnected_for_power') is not True:
        reasons.append('Disconnect BLE receivers for the matched advertising-idle power test')
    if cfg.get('rx_channel') == cfg.get('tx_channel'):
        reasons.append('Saleae RX and TX must use separate channels')
    return {'ready': not reasons, 'blocking': reasons, 'serial_ports': ports,
            'saleae_devices': logic, 'ppk2_ports': ppk,
            'hardware_tested': False, 'checked_at': dt.datetime.now(dt.timezone.utc).isoformat()}


def artifact_manifest(folder):
    return {str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(folder.rglob('*')) if p.is_file() and p.name != 'report.json'}


def experiment(cfg):
    state = ROOT / '.state'; state.mkdir(mode=0o700, exist_ok=True)
    with (state / 'bench.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another bench run owns the instruments')
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
        folder = ROOT / 'captures' / stamp; folder.mkdir(parents=True)
        req = requirements()
        report = {'id': stamp, 'status': 'running', 'hardware_passed': False,
                  'requirements_sha256': hashlib.sha256((ROOT / 'requirements.json').read_bytes()).hexdigest(),
                  'requirements': req, 'bench': cfg, 'rounds': [], 'started_at': stamp}
        save(folder / 'report.json', report)
        try:
            check = doctor(cfg); save(folder / 'preflight.json', check)
            if not check['ready']:
                report['status'] = 'blocked'
                report['blocking'] = check['blocking']
                return report
            builds = {profile: build(profile) for profile in ('baseline', 'optimized')}
            report['builds'] = builds
            frozen = source_hash()
            if any(item['source_sha256']!=frozen for item in builds.values()):
                raise RuntimeError('Firmware changed between profile builds; rebuild both profiles')
            before, after = [], []
            # Alternate matched baseline/candidate pairs; each image is flashed
            # and functionally rechecked before its current is measured.
            for repeat in range(req['power_repeats']):
                for profile, values in (('baseline', before), ('optimized', after)):
                    if source_hash() != frozen:
                        raise RuntimeError('Firmware changed during experiment; evidence invalid')
                    dest = folder / f'{repeat+1}-{profile}'; dest.mkdir()
                    with PowerMeter(cfg) as meter:
                        try:
                            print(f'Round {repeat+1}: flash and measure {profile}',file=sys.stderr,flush=True)
                            flash(profile, cfg['board_serial'], dest / 'flash.log')
                            time.sleep(req['power_settle_s'])
                            functional = functional_capture(dest, cfg, req)
                            time.sleep(req['power_settle_s'])
                            power = meter.capture(dest, req)
                            values.append(power)
                            report['rounds'].append({'repeat': repeat+1, 'profile': profile,
                                                     'functional': functional, 'power': power})
                            save(folder / 'report.json', report)
                        except BaseException:
                            # The candidate can never strand the known baseline
                            # after a functional/instrument failure.
                            if profile == 'optimized' and before:
                                try:
                                    flash('baseline', cfg['board_serial'], dest / 'rollback.log')
                                    report['baseline_restored'] = True
                                except Exception as rollback:
                                    report['rollback_error'] = str(rollback)
                            raise
            verdict = compare_power(before, after, req)
            if source_hash()!=frozen:
                raise RuntimeError('Firmware changed before final acceptance; evidence invalid')
            report['power_comparison'] = verdict
            report['hardware_passed'] = verdict['passed']
            report['status'] = 'passed' if verdict['passed'] else 'failed'
            if not verdict['passed']:
                # Revert the flashed candidate if the power requirement fails.
                with PowerMeter(cfg):
                    flash('baseline', cfg['board_serial'], folder / 'rollback.log')
                report['baseline_restored'] = True
        except KeyboardInterrupt:
            report.update(status='interrupted', error='User interrupted run')
        except Exception as error:
            report.update(status='failed', error=str(error))
        finally:
            report['finished_at'] = dt.datetime.now(dt.timezone.utc).isoformat()
            report['artifacts_sha256'] = artifact_manifest(folder)
            save(folder / 'report.json', report)
            save(state / 'latest.json', {'report': str(folder / 'report.json'), **report})
            from .report import update_readme
            update_readme(ROOT,report,folder)
        return report


def main():
    p = argparse.ArgumentParser(description='CRANIUM closed-loop bench')
    p.add_argument('command', choices=['doctor', 'configure', 'build', 'run', 'latest', 'test','measure','hold'])
    p.add_argument('--profile', choices=['baseline', 'optimized'], default='optimized')
    p.add_argument('--seconds',type=float)
    args = p.parse_args()
    if args.command == 'doctor':
        result = doctor(config())
    elif args.command == 'configure':
        path = ROOT / 'bench.local.json'
        if not path.exists(): shutil.copyfile(ROOT / 'bench.example.json', path)
        result = {'config': str(path), 'next': 'Select device IDs and verify wiring; then run doctor'}
    elif args.command == 'build':
        result = build(args.profile)
    elif args.command == 'run':
        result = experiment(config())
    elif args.command == 'latest':
        result = json.loads((ROOT / '.state/latest.json').read_text())
    elif args.command in ('measure','hold'):
        from .power import standalone_power
        seconds=args.seconds if args.seconds is not None else 20 if args.command=='measure' else 60
        result=standalone_power(args.command,seconds,config())
    else:
        return subprocess.call([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-v'], cwd=ROOT)
    print(json.dumps(result, indent=2))
    return 0 if result.get('status', 'passed') in ('passed','measurement_recorded','hold_complete') and result.get('ready',True) else 2


if __name__ == '__main__':
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    raise SystemExit(main())
