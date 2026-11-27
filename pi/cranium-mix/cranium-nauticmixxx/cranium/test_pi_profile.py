import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
spec = importlib.util.spec_from_file_location('pi_install', HERE / 'pi/installer.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class TrialProfileChecks(unittest.TestCase):
    def test_fx_update_refreshes_saved_script_without_resetting_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            app,home,backup=(Path(directory)/p for p in ('app','pi','backup'))
            name='Pioneer-DDJ-FLX4-script.js'
            source=app/'share/mixxx/controllers'/name
            target=home/'.cranium-nauticmixxx/controllers'/name
            source.parent.mkdir(parents=True);target.parent.mkdir(parents=True)
            source.write_bytes(b'new selector');target.write_bytes(b'old selector')
            config=home/'.cranium-nauticmixxx/soundconfig.xml';config.write_bytes(b'preserve FLX4 routing')
            self.assertTrue(installer.update_flx4_fx_profile(app,home,backup))
            self.assertEqual(target.read_bytes(),source.read_bytes())
            self.assertEqual((backup/(name+'.before-fx-selector')).read_bytes(),b'old selector')
            self.assertEqual(config.read_bytes(),b'preserve FLX4 routing')
            self.assertFalse(installer.update_flx4_fx_profile(app,home,backup))

    def test_encoder_update_refreshes_existing_profile_with_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            app,home,backup=(Path(directory)/p for p in ('app','pi','backup'))
            name='Nautic-RX3-Encoder-FLX4.js'
            source=app/'share/mixxx/controllers'/name
            target=home/'.cranium-nauticmixxx/controllers'/name
            source.parent.mkdir(parents=True);target.parent.mkdir(parents=True)
            source.write_bytes(b'new zoom mapping');target.write_bytes(b'previous mapping')
            config=home/'.cranium-nauticmixxx/mixxx.cfg';config.write_bytes(b'keep audio settings')
            self.assertTrue(installer.update_flx4_encoder_profile(app,home,backup))
            self.assertEqual(target.read_bytes(),source.read_bytes())
            self.assertEqual((backup/(name+'.before-encoder-zoom')).read_bytes(),b'previous mapping')
            self.assertEqual(config.read_bytes(),b'keep audio settings')
            self.assertFalse(installer.update_flx4_encoder_profile(app,home,backup))

    def test_copies_audio_into_isolated_profile_and_preserves_existing_apps(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app, home = root / 'app', root / 'home/pi'
            module = app / 'libexec/nauticmixxx/launch.py'
            module.parent.mkdir(parents=True)
            shutil.copyfile(PROJECT / 'packaging/linux/launch.py', module)
            resources = app / 'share/mixxx'
            (resources / 'profiles').mkdir(parents=True)
            shutil.copyfile(PROJECT / 'profile/XDJ_RX3_Mixxx.profile.cfg', resources / 'profiles/XDJ_RX3_Mixxx.profile.cfg')
            shutil.copytree(PROJECT / 'controllers/Pioneer_DDJ_FLX4_RX3', resources / 'controllers')
            shutil.copytree(PROJECT / 'effects/chains', resources / 'effects/chains')
            bitedj = home / '.cranium-bitedj'
            bitedj.mkdir(parents=True)
            old = ('[Config]\nResizableSkin BiteDJ\n[Soundcard]\nSamplerate 44100\n'
                   '[ControllerPreset]\nDDJ-FLX4:DDJ-FLX4_MIDI_1 /old/FLX4.midi.xml\n')
            (bitedj / 'mixxx.cfg').write_text(old)
            (bitedj / 'soundconfig.xml').write_bytes(b'<soundconfig/>')
            (bitedj / 'mixxxdb.sqlite').write_bytes(b'unchanged library')
            result = installer.seed_trial_profile(app, home)
            profile = home / '.cranium-nauticmixxx'
            text = (profile / 'mixxx.cfg').read_text()
            self.assertTrue(result['seeded'])
            self.assertEqual((bitedj / 'mixxx.cfg').read_text(), old)
            self.assertEqual((bitedj / 'mixxxdb.sqlite').read_bytes(), b'unchanged library')
            self.assertFalse((profile / 'mixxxdb.sqlite').exists())
            self.assertEqual((profile / 'soundconfig.xml').read_bytes(), b'<soundconfig/>')
            self.assertIn('Samplerate 44100', text)
            self.assertIn('ResizableSkin XDJ_RX3_Mixxx', text)
            self.assertIn('CheckOnStartup 0', text)
            self.assertIn('DDJ-FLX4:DDJ-FLX4_MIDI_1 ' + str(profile / 'controllers/Pioneer-DDJ-FLX4-RX3.midi.xml'), text)
            (profile / 'mixxx.cfg').write_text(text + '\n[Personal]\nKeep 1\n')
            before = (profile / 'mixxx.cfg').read_bytes()
            self.assertFalse(installer.seed_trial_profile(app, home)['seeded'])
            self.assertEqual((profile / 'mixxx.cfg').read_bytes(), before)

    def test_touch_update_unlocks_only_small_overview_setting_once_and_keeps_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / 'pi'
            backup = Path(directory) / 'backup'
            config = home / '.cranium-nauticmixxx/mixxx.cfg'
            config.parent.mkdir(parents=True)
            before = '[Soundcard]\nSamplerate 44100\n[RX3Settings]\nneedle_lock 1\n[Personal]\nKeep yes\n'
            config.write_text(before)
            self.assertTrue(installer.enable_waveform_touch_profile(home, backup))
            after = config.read_text()
            self.assertIn('needle_lock 0', after)
            self.assertIn('Samplerate 44100', after)
            self.assertIn('Keep yes', after)
            self.assertEqual((backup / 'mixxx.cfg.before-waveform-touch').read_text(), before)
            # Future explicit choices remain user-controlled after the migration.
            config.write_text(after.replace('needle_lock 0', 'needle_lock 1'))
            self.assertFalse(installer.enable_waveform_touch_profile(home, backup))
            self.assertIn('needle_lock 1', config.read_text())


if __name__ == '__main__':
    unittest.main(verbosity=2)
