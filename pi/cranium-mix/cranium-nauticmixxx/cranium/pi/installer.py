#!/usr/bin/python3
"""Install only the isolated NauticMixxx trial and extend the existing chooser."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import subprocess
import tarfile
import time
import uuid

HELPERS = ('installer.py', 'install.sh', 'launch.py', 'app-menu.sh', 'session.py',
           'kiosk.py', 'diag.py', 'appliance.py', 'media.py', 'performance.py', 'start.png')


def verify_helpers(package):
    metadata = json.loads((package / 'startup-manifest.json').read_text())
    if metadata.get('revision') != 'appliance-v1' or set(metadata.get('files', {})) != set(HELPERS):
        raise RuntimeError('Incomplete or unrecognized startup manifest.')
    for name in HELPERS:
        if hashlib.sha256((package / name).read_bytes()).hexdigest() != metadata['files'][name]:
            raise RuntimeError('Startup file checksum mismatch: ' + name)
    return metadata


def atomic_write(path, data, mode=0o644):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.cranium-new')
    with temporary.open('wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def set_setting(text, section, key, value):
    lines = text.splitlines()
    header = '[' + section + ']'
    if header not in lines:
        return text.rstrip() + '\n\n' + header + '\n' + key + ' ' + str(value) + '\n'
    start = lines.index(header) + 1
    end = next((i for i in range(start, len(lines)) if lines[i].startswith('[')), len(lines))
    entries = [line for line in lines[start:end] if not re.match(r'^' + re.escape(key) + r'(?:\s|$)', line)]
    return '\n'.join(lines[:start] + entries + [key + ' ' + str(value)] + lines[end:]) + '\n'


def verify_archive(package):
    manifest = json.loads((package / 'manifest.json').read_text())
    archive = package / 'nauticmixxx-arm64-bookworm.tar.gz'
    if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest['sha256']:
        raise RuntimeError('NauticMixxx archive checksum mismatch.')
    return archive, manifest


def seed_trial_profile(app, home):
    profile = home / '.cranium-nauticmixxx'
    if (profile / 'mixxx.cfg').exists():
        return {'seeded': False, 'profile': str(profile)}
    spec = importlib.util.spec_from_file_location('nautic_seed', app / 'libexec/nauticmixxx/launch.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.seed_profile(app / 'share/mixxx', profile)
    config = profile / 'mixxx.cfg'
    text = config.read_text()
    audio_source = next((home / name for name in ('.cranium-bitedj', '.mixxx')
                         if (home / name / 'soundconfig.xml').is_file()), None)
    if audio_source:
        shutil.copyfile(audio_source / 'soundconfig.xml', profile / 'soundconfig.xml')
        settings = (audio_source / 'mixxx.cfg').read_text()
        section = re.search(r'^\[Soundcard\]\s*\n(.*?)(?=^\[|\Z)', settings, re.MULTILINE | re.DOTALL)
        if section:
            for line in section.group(1).splitlines():
                parts = line.split(None, 1)
                if len(parts) == 2 and not line.startswith('#'):
                    text = set_setting(text, 'Soundcard', *parts)
        ports = []
        active_section = ''
        for line in settings.splitlines():
            if line.startswith('['):
                active_section = line.strip()
            elif active_section in ('[Controller]', '[ControllerPreset]'):
                parts = line.split(None, 1)
                if len(parts) == 2 and 'FLX4' in line.upper():
                    ports.append(parts[0])
    else:
        ports = []
    mapping = profile / 'controllers/Pioneer-DDJ-FLX4-RX3.midi.xml'
    for port in sorted(set(['DDJ-FLX4', *ports])):
        text = set_setting(text, 'ControllerPreset', port, mapping)
        text = set_setting(text, 'Controller', port, 1)
    for section, key, value in [('Config', 'StartInFullscreen', '1'),
                                 ('Config', 'show_menubar_hint', '0'),
                                 ('Config', 'ScaleFactor', '1'), ('Config', 'ScaleFactorAuto', '0'),
                                 ('NauticUpdates', 'CheckOnStartup', '0'),
                                 ('NauticUpdates', 'AutomaticallyDownload', '0')]:
        text = set_setting(text, section, key, value)
    atomic_write(config, text.encode(), 0o600)
    return {'seeded': True, 'profile': str(profile), 'audio_copied_from': str(audio_source) if audio_source else None}


def enable_waveform_touch_profile(home, backup):
    """One-time requested setting: leave small overview seeking unlocked."""
    config = home / '.cranium-nauticmixxx/mixxx.cfg'
    before = config.read_bytes()
    text = before.decode()
    if re.search(r'^WaveformTouchVersion\s+1\s*$', text, re.MULTILINE):
        return False
    backup.mkdir(parents=True, exist_ok=True)
    (backup / 'mixxx.cfg.before-waveform-touch').write_bytes(before)
    text = set_setting(text, 'RX3Settings', 'needle_lock', 0)
    text = set_setting(text, 'Cranium', 'WaveformTouchVersion', 1)
    atomic_write(config, text.encode(), 0o600)
    return True


def update_flx4_encoder_profile(app, home, backup):
    """Refresh the requested encoder resource in existing isolated profiles."""
    name = 'Nautic-RX3-Encoder-FLX4.js'
    source = app / 'share/mixxx/controllers' / name
    target = home / '.cranium-nauticmixxx/controllers' / name
    updated = source.read_bytes()
    if target.exists() and target.read_bytes() == updated:
        return False
    if target.exists():
        backup.mkdir(parents=True, exist_ok=True)
        shutil.copy2(target, backup / (name + '.before-encoder-zoom'))
    atomic_write(target, updated)
    return True


def update_flx4_fx_profile(app, home, backup):
    """Refresh FX selector callbacks without resetting the saved audio profile."""
    name = 'Pioneer-DDJ-FLX4-script.js'
    source = app / 'share/mixxx/controllers' / name
    target = home / '.cranium-nauticmixxx/controllers' / name
    updated = source.read_bytes()
    if target.exists() and target.read_bytes() == updated:
        return False
    if target.exists():
        backup.mkdir(parents=True, exist_ok=True)
        shutil.copy2(target, backup / (name + '.before-fx-selector'))
    atomic_write(target, updated)
    return True


def install(package):
    if os.geteuid() != 0 or platform.machine() != 'aarch64':
        raise RuntimeError('Run on the expected 64-bit Pi as root.')
    user = pwd.getpwnam('pi')
    home = Path(user.pw_dir)
    if home != Path('/home/pi') or not Path('/usr/local/bin/cranium-launch').is_file():
        raise RuntimeError('The installed Cranium app chooser was not found.')
    if 'exec /usr/local/bin/cranium-launch auto' not in (home / '.config/sway/config').read_text():
        raise RuntimeError('Unexpected desktop startup; nothing changed.')
    startup_metadata = verify_helpers(package)
    archive, manifest = verify_archive(package)
    startup_spec = importlib.util.spec_from_file_location('cranium_appliance', package / 'appliance.py')
    startup = importlib.util.module_from_spec(startup_spec)
    startup_spec.loader.exec_module(startup)
    # Preflight before replacing any application, profile or startup file.
    startup.check_graphical_login()
    boot_changes = startup.boot_plan()
    for name in ('launch.py', 'app-menu.sh', 'session.py', 'kiosk.py', 'media.py',
                 'performance.py', 'start.png', 'appliance.py'):
        if not (package / name).is_file():
            raise RuntimeError('Incomplete startup update: ' + name)
    diagnostic_spec = importlib.util.spec_from_file_location('cranium_diag', package / 'diag.py')
    diagnostic = importlib.util.module_from_spec(diagnostic_spec)
    diagnostic_spec.loader.exec_module(diagnostic)
    atomic_write(package / 'diag.json', (json.dumps(diagnostic.capture(), indent=2) + '\n').encode())

    if shutil.disk_usage('/opt').free < manifest['unpacked_bytes'] * 2 + 100_000_000:
        raise RuntimeError('Insufficient free Linux partition space.')
    stamp = time.strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex[:6]
    backup = home / 'cranium-nauticmixxx-backups' / stamp
    backup.mkdir(parents=True)
    startup.snapshot(backup)
    target = Path('/opt/cranium/nauticmixxx')
    staging = Path('/opt/cranium') / ('nautic-stage-' + stamp)
    staging.mkdir()
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar.getmembers():
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'nauticmixxx':
                raise RuntimeError('Unsafe archive member.')
            if not (member.isfile() or member.isdir()):
                raise RuntimeError('Unexpected link or special file in app archive.')
        tar.extractall(staging)
    candidate = staging / 'nauticmixxx'
    if list((candidate / 'lib/cranium').glob('libwayland-*')):
        raise RuntimeError('Package must use system Wayland libraries.')
    env = {**os.environ, 'LD_LIBRARY_PATH': str(candidate / 'lib/cranium')}
    resolved = subprocess.run(['ldd', str(candidate / 'libexec/nauticmixxx/NauticMixxx')],
                              env=env, capture_output=True, text=True)
    if resolved.returncode or 'not found' in resolved.stdout + resolved.stderr:
        raise RuntimeError('Native dependencies failed: ' + resolved.stdout + resolved.stderr)
    if target.exists():
        target.rename(backup / 'previous-app')
    candidate.rename(target)
    staging.rmdir()
    profile_report = seed_trial_profile(target, home)
    profile_report['flx4_encoder_updated'] = update_flx4_encoder_profile(target, home, backup)
    profile_report['flx4_fx_updated'] = update_flx4_fx_profile(target, home, backup)
    profile_report['small_overviews_unlocked'] = enable_waveform_touch_profile(home, backup)
    fonts = home / '.local/share/fonts/cranium-nauticmixxx'
    if not fonts.exists():
        shutil.copytree(target / 'share/cranium/fonts', fonts)
    for filename in ('cranium-launch', 'cranium-app-menu'):
        shutil.copyfile(Path('/usr/local/bin') / filename, backup / filename)
    preference = home / '.config/cranium/app'
    if preference.exists():
        shutil.copyfile(preference, backup / 'app-selection')
    boot_selector = Path('/boot/firmware/cranium-app.txt')
    if boot_selector.exists():
        shutil.copyfile(boot_selector, backup / 'cranium-app.txt')
    # Commit the chooser update only once the application/profile are ready.
    atomic_write('/usr/local/bin/cranium-launch', (package / 'launch.py').read_bytes(), 0o755)
    atomic_write('/usr/local/bin/cranium-app-menu', (package / 'app-menu.sh').read_bytes(), 0o755)
    # Preserve the original developer desktop and hardware setup, then install
    # a separate normal-use shell with no wallpaper, bar or application launcher.
    sway = home / '.config/sway/config'
    desktop = home / '.config/sway/cranium-desktop.conf'
    shutil.copyfile(sway, backup / 'sway-config')
    if not desktop.exists():
        atomic_write(desktop, sway.read_bytes())
    spec = importlib.util.spec_from_file_location('cranium_kiosk', package / 'kiosk.py')
    kiosk = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(kiosk)
    atomic_write('/usr/local/bin/cranium-session', (package / 'session.py').read_bytes(), 0o755)
    for target_name, source_name in [('cranium-media', 'media.py'),
                                     ('cranium-performance', 'performance.py'),
                                     ('cranium-appliance', 'appliance.py')]:
        atomic_write(Path('/usr/local/bin') / target_name, (package / source_name).read_bytes(), 0o755)
    atomic_write('/usr/local/share/cranium/start.png', (package / 'start.png').read_bytes())
    atomic_write(sway, kiosk.configure_sway(desktop.read_text()).encode())
    os.chown(sway, user.pw_uid, user.pw_gid)
    os.chown(desktop, user.pw_uid, user.pw_gid)
    # Some images also auto-start Waybar via the user graphical target.
    # A service condition prevents a boot-time bar even without Sway's bar block.
    override = home / '.config/systemd/user/waybar.service.d/cranium.conf'
    if override.exists():
        shutil.copyfile(override, backup / 'waybar-service-override')
    atomic_write(override, b'[Unit]\nConditionPathExists=%t/cranium-developer\n')
    for directory in (override.parent, override.parent.parent, override.parent.parent.parent):
        os.chown(directory, user.pw_uid, user.pw_gid)
    os.chown(override, user.pw_uid, user.pw_gid)
    waybar = home / '.config/waybar/config'
    if waybar.exists():
        shutil.copyfile(waybar, backup / 'waybar-config')
        try:
            bar = json.loads(waybar.read_text())
            bar['custom/mixxx'] = {'format': ' CRANIUM ', 'on-click': '/usr/local/bin/cranium-session kiosk'}
            atomic_write(waybar, (json.dumps(bar, indent=2) + '\n').encode())
            os.chown(waybar, user.pw_uid, user.pw_gid)
        except ValueError:
            pass  # Preserve JSONC rather than damaging a developer configuration.

    atomic_write(preference, b'nauticmixxx\n')
    atomic_write(boot_selector, b'auto\n')
    for parent in (home / '.cranium-nauticmixxx', fonts, backup):
        for root, directories, files in os.walk(parent):
            for name in directories + files:
                os.chown(Path(root) / name, user.pw_uid, user.pw_gid)
        os.chown(parent, user.pw_uid, user.pw_gid)
    os.chown(preference, user.pw_uid, user.pw_gid)
    # Suppress tty1's autologin chatter only after verifying LightDM independently
    # starts Sway. A marker file on the SD boot volume restores tty1 next boot.
    atomic_write('/etc/systemd/system/getty@tty1.service.d/cranium-appliance.conf',
                 b'[Unit]\nConditionPathExists=/boot/firmware/cranium-console-enabled\n')
    startup.apply_boot(boot_changes)
    startup.seal(backup)
    return {'status': 'installed', 'default_app': 'nauticmixxx', 'backup': str(backup),
            'trial_size': [800, 480], 'profile': profile_report,
            'overlay_commit': manifest['overlay_commit'], 'engine_commit': manifest['engine_commit'],
            'bitedj_application_and_profile_changed': False, 'original_mixxx_changed': False,
            'physical_playback_tested': False, 'cranium_appliance_shell': True,
            'startup_revision': 'appliance-v1', 'quiet_boot': True,
            'startup_source_commit': startup_metadata['source_commit'],
            'performance_capture': '30-second delay, 120-second bounded low-priority capture',
            'startup_restore': 'sudo cranium-appliance restore ' + str(backup)}


if __name__ == '__main__':
    package = Path(__file__).resolve().parent
    try:
        result = install(package)
    except Exception as error:
        result = {'status': 'failed', 'error': str(error)}
        atomic_write(package / 'install-result.json', (json.dumps(result, indent=2) + '\n').encode())
        raise
    atomic_write(package / 'install-result.json', (json.dumps(result, indent=2) + '\n').encode())
    print(json.dumps(result), flush=True)
