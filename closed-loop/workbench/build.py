import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def build_directory(profile):
    # Zephyr's Kconfig argument lists split source paths on spaces, even when
    # subprocess argv is correctly quoted. Keep SDK build inputs in a stable,
    # task-specific, space-free cache and copy deliverables back to the repo.
    key = hashlib.sha256(str(ROOT).encode()).hexdigest()[:10]
    base = Path(os.environ.get('CRANIUM_BUILD_ROOT', f'/private/tmp/cranium-workbench-{os.getuid()}-{key}'))
    if ' ' in str(base):
        raise ValueError('CRANIUM_BUILD_ROOT must not contain spaces')
    return base / profile


def source_hash():
    h = hashlib.sha256()
    for path in sorted((ROOT / 'app').rglob('*')):
        if path.is_file():
            h.update(str(path.relative_to(ROOT)).encode() + b'\0' + path.read_bytes())
    return h.hexdigest()


def sdk_env():
    workspace_sdk = ROOT / 'deps'
    default_sdk = workspace_sdk if (workspace_sdk/'nrf/west.yml').is_file() and (workspace_sdk/'zephyr').is_dir() else Path('/opt/nordic/ncs/v3.4.0')
    sdk = Path(os.environ.get('CRANIUM_SDK', default_sdk))
    tc = Path(os.environ.get('CRANIUM_TOOLCHAIN', '/opt/nordic/ncs/toolchains/ccc010f809'))
    env = os.environ.copy()
    env.update(PATH=os.pathsep.join(str(tc / p) for p in ('bin', 'usr/bin', 'opt/bin', 'nrfutil/bin')) + os.pathsep + env['PATH'],
               ZEPHYR_BASE=str(sdk / 'zephyr'), ZEPHYR_SDK_INSTALL_DIR=str(tc / 'opt/zephyr-sdk'),
               ZEPHYR_TOOLCHAIN_VARIANT='zephyr/gnu', PYTHONNOUSERSITE='1',
               NRFUTIL_HOME=str(tc / 'nrfutil/home'),
               CCACHE_DIR=str(build_directory('cache') / '.ccache'))
    return sdk, env


def run_logged(args, log, cwd=None, env=None, timeout=900):
    with Path(log).open('ab') as stream:
        stream.write((repr(args) + '\n').encode()); stream.flush()
        subprocess.run(args, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout, check=True)


def build(profile):
    if profile not in ('baseline', 'optimized'):
        raise ValueError('unknown build profile')
    sdk, env = sdk_env()
    frozen_source=source_hash()
    settings = json.loads((ROOT / 'app/profiles' / (profile + '.json')).read_text())
    interval, heartbeat = settings['advertising_interval_ms'], settings['heartbeat_ms']
    if not 20 <= interval <= 3200 or not 0 <= heartbeat <= 5000 or not isinstance(settings['status_led'], bool):
        raise ValueError('profile outside bounded BLE/heartbeat settings')
    source = build_directory(profile) / 'app'
    source.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT / 'app', source, dirs_exist_ok=True)
    # Remove the old wrapper-generated file, if this cache predates the public
    # CMake profile generator. The public app must build without private files.
    old_header=source/'src/profile.h'
    if old_header.exists():old_header.unlink()
    old_overlay=source/'app.overlay'
    if old_overlay.exists():old_overlay.unlink()
    output = build_directory(profile) / 'zephyr-app'
    cache = build_directory('cache')
    log = ROOT / 'build' / profile / 'build.log'
    log.parent.mkdir(parents=True, exist_ok=True)
    run_logged(['west', 'build', '--sysbuild', '-b', 'nrf7002dk/nrf5340/cpuapp', '-d', str(output), str(source), '--',
                '-DZEPHYR_BASE=' + str(sdk / 'zephyr'), '-DUSER_CACHE_DIR=' + str(cache),
                '-Dapp_USER_CACHE_DIR=' + str(cache), '-Dipc_radio_USER_CACHE_DIR=' + str(cache),
                '-Dapp_CRANIUM_PROFILE=' + profile,
                '-Dapp_DTC_OVERLAY_FILE=' + str(source / 'boards/nrf7002dk_nrf5340_cpuapp.overlay'),
                '-Dipc_radio_EXTRA_CONF_FILE=' + str(source / 'sysbuild/ipc_radio.conf')], log, sdk, env)
    effective_header=(output/'app/generated/profile.h').read_text()
    if f'#define CRANIUM_PROFILE "{profile}"' not in effective_header or f'#define CRANIUM_ADV_UNITS {round(interval/0.625)}' not in effective_header:
        raise RuntimeError('Compiled profile differs from its requested settings')
    if source_hash()!=frozen_source:
        raise RuntimeError('Application source changed during compilation; rebuild this profile')
    images = [output / 'app/zephyr/zephyr.hex', output / 'ipc_radio/zephyr/zephyr.hex']
    if not all(p.is_file() for p in images):
        raise RuntimeError('expected application AND network-core HEX images')
    for image, name in zip(images, ('application.hex', 'network.hex')):
        shutil.copyfile(image, log.parent / name)
    manifest = {'profile': profile, 'source_sha256': frozen_source, 'board': 'nrf7002dk/nrf5340/cpuapp',
                'settings': settings, 'images': {str(p.relative_to(output)): hashlib.sha256(p.read_bytes()).hexdigest() for p in images}}
    (ROOT / 'build' / profile / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def flash(profile, serial, log):
    if not serial or not str(serial).isdigit():
        raise ValueError('an explicit numeric J-Link board serial is required')
    sdk, env = sdk_env()
    output = build_directory(profile) / 'zephyr-app'
    manifest = json.loads((ROOT / 'build' / profile / 'manifest.json').read_text())
    for name, digest in manifest['images'].items():
        if hashlib.sha256((output / name).read_bytes()).hexdigest() != digest:
            raise ValueError('firmware image changed since build')
    # Program the two sysbuild domains; never use recover, erase-all or a guessed board.
    run_logged(['west', 'flash', '--skip-rebuild', '-d', str(output), '--dev-id', str(serial)], log, sdk, env, 120)
