import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

PI = Path(__file__).resolve().parent / 'pi'


def load(name):
    spec = importlib.util.spec_from_file_location(name, PI / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


appliance = load('appliance')
installer = load('installer')
media = load('media')


class BootTests(unittest.TestCase):
    def test_boot_keeps_root_serial_display_and_quoted_arguments(self):
        original = ('console=serial0,115200 console=tty1 root=PARTUUID=test-root '
                    'rootfstype=ext4 rootwait video=DSI-1:800x480@60 '
                    'custom="keep these spaces" quiet loglevel=7 systemd.show_status=true\n')
        updated = appliance.quiet_cmdline(original)
        for token in ('console=serial0,115200', 'root=PARTUUID=test-root', 'rootfstype=ext4',
                      'rootwait', 'video=DSI-1:800x480@60', 'custom="keep these spaces"'):
            self.assertIn(token, updated)
        self.assertNotIn('console=tty1', updated)
        self.assertIn('console=tty3', updated)
        self.assertNotIn('loglevel=7', updated)
        self.assertEqual(updated.count('quiet'), 1)
        self.assertEqual(updated.count('\n'), 1)
        self.assertEqual(appliance.quiet_cmdline(updated), updated)

    def test_pending_install_and_ambiguous_boot_are_refused(self):
        for text in ('root=a systemd.run="/bin/bash /boot/install.sh"',
                     'root=a systemd.unit=kernel-command-line.target',
                     'root=a init=/resize', 'root=a rdinit=/unknown',
                     'root=a root=b', 'quiet rootwait', 'root=a\nquiet',
                     'root=a incomplete="quoted'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                appliance.quiet_cmdline(text)

    def test_display_config_sections_and_overlays_survive(self):
        original = ('# display installed by owner\n[pi4]\n'
                    'dtoverlay=vc4-kms-v3d\n[all]\n'
                    'dtoverlay=vc4-kms-dsi-waveshare-panel,7_0_inch\n'
                    'display_auto_detect=0\n[pi5]\ninclude pi5-extra.txt\n')
        updated = appliance.quiet_config(original)
        self.assertTrue(updated.startswith(original.rstrip() + '\n'))
        self.assertEqual(updated.count('disable_splash=1'), 1)
        self.assertEqual(appliance.quiet_config(updated), updated)
        with self.assertRaises(ValueError):
            appliance.quiet_config(original + appliance.BEGIN)

    def test_tty1_suppression_requires_independent_graphical_login(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                appliance.check_graphical_login(root)
            service = root / 'usr/lib/systemd/system/lightdm.service'
            service.parent.mkdir(parents=True)
            service.touch()
            link = root / 'etc/systemd/system/display-manager.service'
            link.parent.mkdir(parents=True)
            link.symlink_to(service)
            config = root / 'etc/lightdm/lightdm.conf'
            config.parent.mkdir(parents=True)
            config.write_text('[Seat:*]\nautologin-user=pi\nautologin-session=sway\n')
            appliance.check_graphical_login(root)
            config.write_text('[Seat:*]\nautologin-user=pi\nautologin-session=other\n')
            with self.assertRaises(ValueError):
                appliance.check_graphical_login(root)

    def test_failed_boot_write_restores_both_original_files(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / 'cmdline.txt', Path(directory) / 'config.txt'
            first.write_bytes(b'old command'); second.write_bytes(b'old display')
            real_write = appliance.atomic
            failed = False
            def write(path, data, mode=0o644):
                nonlocal failed
                if path == second and not failed:
                    failed = True
                    raise OSError('simulated full boot partition')
                real_write(path, data, mode)
            with mock.patch.object(appliance, 'atomic', side_effect=write), self.assertRaises(OSError):
                appliance.apply_boot({first: b'new command', second: b'new display'})
            self.assertEqual(first.read_bytes(), b'old command')
            self.assertEqual(second.read_bytes(), b'old display')


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'system'
        self.backup = Path(self.temporary.name) / 'backup'
        self.first = self.root / appliance.FILES[0].lstrip('/')
        self.first.parent.mkdir(parents=True)
        self.first.write_bytes(b'original command')
        self.first.chmod(0o640)
        appliance.snapshot(self.backup, self.root)
        self.first.write_bytes(b'updated command')
        self.new = self.root / appliance.FILES[1].lstrip('/')
        self.new.write_bytes(b'added config')
        appliance.seal(self.backup, self.root)

    def test_restore_returns_exact_bytes_modes_and_removes_added_files(self):
        appliance.restore(self.backup, self.root)
        self.assertEqual(self.first.read_bytes(), b'original command')
        self.assertEqual(self.first.stat().st_mode & 0o777, 0o640)
        self.assertFalse(self.new.exists())

    def test_later_manual_change_blocks_the_entire_restore(self):
        self.new.write_bytes(b'later manual change')
        with self.assertRaises(ValueError):
            appliance.restore(self.backup, self.root)
        self.assertEqual(self.first.read_bytes(), b'updated command')
        self.assertEqual(self.new.read_bytes(), b'later manual change')

    def test_corrupt_backup_blocks_the_entire_restore(self):
        (self.backup / 'startup/0').write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            appliance.restore(self.backup, self.root)
        self.assertEqual(self.first.read_bytes(), b'updated command')

    def test_symlink_is_not_followed(self):
        self.new.unlink()
        self.new.symlink_to(self.first)
        with self.assertRaises(ValueError):
            appliance.restore(self.backup, self.root)
        self.assertEqual(self.first.read_bytes(), b'updated command')


class PackagingTests(unittest.TestCase):
    def test_helper_tampering_is_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            hashes = {}
            for name in installer.HELPERS:
                data = (PI / name).read_bytes()
                (package / name).write_bytes(data)
                hashes[name] = hashlib.sha256(data).hexdigest()
            (package / 'startup-manifest.json').write_text(json.dumps(
                {'revision': 'appliance-v1', 'files': hashes, 'source_commit': 'fixture'}))
            installer.verify_helpers(package)
            (package / 'media.py').write_text('changed')
            with self.assertRaisesRegex(RuntimeError, 'media.py'):
                installer.verify_helpers(package)

    def test_only_one_automounter_is_selected_and_missing_backend_is_explicit(self):
        both = {'udiskie': '/usr/bin/udiskie', 'devmon': '/usr/bin/devmon'}
        self.assertEqual(media.command(both.get), ['/usr/bin/udiskie', '--no-tray'])
        self.assertEqual(media.command({'devmon': '/usr/bin/devmon'}.get), ['/usr/bin/devmon'])
        with self.assertRaises(RuntimeError):
            media.command({}.get)


if __name__ == '__main__':
    unittest.main()
