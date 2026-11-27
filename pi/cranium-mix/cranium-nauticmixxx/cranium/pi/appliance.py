#!/usr/bin/python3
"""Reversible startup configuration for the existing Bookworm appliance."""
import argparse
import configparser
import hashlib
import json
import os
from pathlib import Path
import re
import shutil

FILES = (
    '/boot/firmware/cmdline.txt', '/boot/firmware/config.txt',
    '/home/pi/.config/sway/config',
    '/usr/local/bin/cranium-launch', '/usr/local/bin/cranium-app-menu',
    '/usr/local/bin/cranium-session', '/usr/local/bin/cranium-media',
    '/usr/local/bin/cranium-performance', '/usr/local/bin/cranium-appliance',
    '/usr/local/share/cranium/start.png',
    '/home/pi/.config/systemd/user/waybar.service.d/cranium.conf',
    '/etc/systemd/system/getty@tty1.service.d/cranium-appliance.conf',
)
BEGIN = '# BEGIN CRANIUM quiet startup'
END = '# END CRANIUM quiet startup'
OPTIONS = ('quiet', 'loglevel=3', 'logo.nologo', 'vt.global_cursor_default=0',
           'systemd.show_status=false')
TOKEN = r'(?:[^\s"]+|"[^"\n]*")+'


def quiet_cmdline(text):
    """Retain opaque quoted arguments and every root/display/serial option."""
    value = text.strip()
    if '\n' in value or '\r' in value or not re.fullmatch(TOKEN + r'(?:[ \t]+' + TOKEN + r')*', value):
        raise ValueError('Expected one valid kernel command line.')
    tokens = re.findall(TOKEN, value)
    if sum(token.startswith('root=') for token in tokens) != 1:
        raise ValueError('Expected exactly one existing root argument.')
    if any(token.startswith(('systemd.run', 'systemd.unit=', 'init=', 'rdinit=')) for token in tokens):
        raise ValueError('Restore normal boot / complete the pending installer first.')
    keys = {option.split('=')[0] for option in OPTIONS}
    retained = [token for token in tokens if token.split('=')[0] not in keys]
    # Move kernel console text away from the visible login VT. Serial recovery
    # remains unchanged; no getty, display manager or network service is removed.
    retained = ['console=tty3' if token == 'console=tty1' else token for token in retained]
    return ' '.join(retained + list(OPTIONS)) + '\n'


def quiet_config(text):
    if text.count(BEGIN) != text.count(END) or text.count(BEGIN) > 1:
        raise ValueError('Malformed managed startup block.')
    if BEGIN in text:
        # [all] belongs to our block, so existing conditional sections are kept.
        text, count = re.subn(re.escape(BEGIN) + r'\n\[all\]\ndisable_splash=1\n' + re.escape(END) + r'\n?', '', text)
        if count != 1:
            raise ValueError('Unexpected managed startup block; inspect before updating.')
    return text.rstrip() + '\n\n' + BEGIN + '\n[all]\ndisable_splash=1\n' + END + '\n'


def boot_plan(root=Path('/')):
    boot = root / 'boot/firmware'
    return {boot / 'cmdline.txt': quiet_cmdline((boot / 'cmdline.txt').read_text()).encode(),
            boot / 'config.txt': quiet_config((boot / 'config.txt').read_text()).encode()}


def check_graphical_login(root=Path('/')):
    """Never suppress tty1 on a machine that relies on it to start graphics."""
    display_manager = root / 'etc/systemd/system/display-manager.service'
    config = configparser.ConfigParser(strict=False)
    config.read(root / 'etc/lightdm/lightdm.conf')
    if (not display_manager.exists() or display_manager.resolve().name != 'lightdm.service'
            or config.get('Seat:*', 'autologin-user', fallback='') != 'pi'
            or config.get('Seat:*', 'autologin-session', fallback='') != 'sway'):
        raise ValueError('Expected independent LightDM → pi/Sway graphical login; startup not changed.')


def atomic(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.cranium-startup-new')
    with temporary.open('wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(mode)
    temporary.replace(path)


def snapshot(backup, root=Path('/')):
    """Only startup files; app/profile backups are handled by installer.py."""
    folder = backup / 'startup'
    folder.mkdir(parents=True)
    entries = []
    for index, name in enumerate(FILES):
        path = root / name.lstrip('/')
        if path.is_symlink():
            raise ValueError('Startup path must be a regular file: ' + name)
        entry = {'path': name, 'existed': path.exists(), 'copy': str(index)}
        if path.exists():
            entry.update(mode=path.stat().st_mode & 0o777, uid=path.stat().st_uid,
                         gid=path.stat().st_gid, sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            shutil.copyfile(path, folder / str(index))
        entries.append(entry)
    atomic(folder / 'files.json', json.dumps(entries, indent=2).encode())


def seal(backup, root=Path('/')):
    folder = backup / 'startup'
    entries = json.loads((folder / 'files.json').read_text())
    for entry in entries:
        path = root / entry['path'].lstrip('/')
        entry['installed_sha256'] = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
    atomic(folder / 'files.json', json.dumps(entries, indent=2).encode())


def restore(backup, root=Path('/')):
    folder = backup / 'startup'
    entries = json.loads((folder / 'files.json').read_text())
    if [entry['path'] for entry in entries] != list(FILES):
        raise ValueError('Unrecognized startup backup.')
    # Validate the entire restore before writing anything. Later updates or
    # manual edits require deliberate reconciliation, never silent overwrites.
    for index, entry in enumerate(entries):
        path = root / entry['path'].lstrip('/')
        if entry['copy'] != str(index) or path.is_symlink():
            raise ValueError('Unsafe backup path.')
        current = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
        if 'installed_sha256' not in entry or current != entry['installed_sha256']:
            raise ValueError('Startup changed since this backup: ' + entry['path'])
        if entry['existed'] and hashlib.sha256((folder / str(index)).read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError('Startup backup checksum mismatch.')
    for entry in entries:
        path = root / entry['path'].lstrip('/')
        if entry['existed']:
            atomic(path, (folder / entry['copy']).read_bytes(), entry['mode'])
            if root == Path('/'):
                os.chown(path, entry['uid'], entry['gid'])
        else:
            path.unlink(missing_ok=True)


def apply_boot(plan):
    before = {path: (path.read_bytes(), path.stat().st_mode & 0o777) for path in plan}
    try:
        for path, data in plan.items():
            atomic(path, data, before[path][1])
    except OSError:
        for path, (data, mode) in before.items():
            atomic(path, data, mode)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['restore'])
    parser.add_argument('backup', type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Restore requires sudo on the device.')
    restore(args.backup.resolve())
    print('Previous startup restored. Reboot when playback is stopped.')
