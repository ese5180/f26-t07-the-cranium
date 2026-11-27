import importlib.util
from pathlib import Path
import unittest

path=Path(__file__).resolve().parents[1]/'packaging/linux/audio-probe.py'
spec=importlib.util.spec_from_file_location('audio_probe',path);probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)

class ProbeIdentifiers(unittest.TestCase):
    def test_alsa_hardware_identity_does_not_depend_on_enumeration_order(self):
        name='DDJ-FLX4: USB Audio (hw:2,0)'
        self.assertEqual(probe.normalize('ALSA',name,1),'ALSA|DDJ-FLX4: USB Audio|hw:2,0')
        self.assertEqual(probe.normalize('ALSA',name,7),probe.normalize('ALSA',name,1))
        self.assertEqual(probe.normalize('ALSA','Device (plughw:1,0)',3),'ALSA|Device|hw:1,0')
    def test_aliases_and_other_apis_keep_their_port_index(self):
        self.assertEqual(probe.normalize('ALSA','default',2),'ALSA|default||2')
        self.assertEqual(probe.normalize('Other','USB Audio',4),'Other|USB Audio||4')

if __name__=='__main__':unittest.main(verbosity=2)
