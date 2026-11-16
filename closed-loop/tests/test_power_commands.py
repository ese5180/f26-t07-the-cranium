import json
import io
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock,patch
from workbench import power
from workbench.instruments import drain_stream


class PowerCommandsTests(unittest.TestCase):
    def test_invalid_or_unbounded_duration_rejected(self):
        for action,seconds in (('measure',0),('measure',61),('hold',901),('hold',float('nan')),('shell',10)):
            with self.assertRaises(ValueError):power.validate_duration(action,seconds)

    def test_measurement_without_analyzer_never_claims_hil(self):
        cfg={'measurement_scope':'unit fixture'}
        meter=MagicMock();meter.__enter__.return_value.capture.return_value={'mean_uA':1000,'source':'unit fixture'}
        with tempfile.TemporaryDirectory() as d,patch.object(power,'ROOT',Path(d)),\
             patch.object(power,'power_readiness',return_value={'ready':True}),\
             patch.object(power,'PowerMeter',return_value=meter),patch.object(power.time,'sleep'):
            report=power.standalone_power('measure',20,cfg)
            saved=json.loads((Path(d)/'.state/latest-power.json').read_text())
        self.assertEqual(report['status'],'measurement_recorded')
        self.assertFalse(report['hardware_passed']);self.assertFalse(saved['hardware_passed'])
        self.assertIn('not verified',report['firmware_identity'])
        meter.__exit__.assert_called_once()

    def test_blocked_power_operation_never_opens_instrument(self):
        with tempfile.TemporaryDirectory() as d,patch.object(power,'ROOT',Path(d)),\
             patch.object(power,'power_readiness',return_value={'ready':False,'blocking':['No PPK2']}),\
             patch.object(power,'PowerMeter') as meter:
            report=power.standalone_power('measure',20,{})
        self.assertEqual(report['status'],'blocked');self.assertFalse(report['hardware_passed'])
        meter.assert_not_called()

    def test_hold_always_releases_after_interrupt(self):
        meter=MagicMock()
        with tempfile.TemporaryDirectory() as d,patch.object(power,'ROOT',Path(d)),\
             patch.object(power,'power_readiness',return_value={'ready':True}),\
             patch.object(power,'PowerMeter',return_value=meter),\
             patch.object(power.time,'sleep',side_effect=KeyboardInterrupt):
            report=power.standalone_power('hold',60,{})
        self.assertEqual(report['status'],'interrupted');self.assertFalse(report['hardware_passed'])
        meter.__exit__.assert_called_once()

    def test_drain_waits_for_delayed_usb_bytes(self):
        class Clock:
            now=0
            def monotonic(self):return self.now
            def sleep(self,seconds):self.now+=seconds
        clock=Clock();device=MagicMock();reads=[]
        class Serial:
            sent=False
            @property
            def in_waiting(self):
                return 4 if .1<=clock.now and not self.sent else 0
            def read(self,n):self.sent=True;reads.append(n);return b'data'
        device.ser=Serial()
        with patch('workbench.instruments.time.monotonic',side_effect=clock.monotonic),patch('workbench.instruments.time.sleep',side_effect=clock.sleep):
            drain_stream(device)
        self.assertEqual(reads,[4]);self.assertGreaterEqual(clock.now,.4)

    def test_configuration_can_finish_without_logic_analyzer(self):
        from workbench import launch
        from workbench.build import ROOT
        cfg=json.loads((ROOT/'bench.example.json').read_text())
        ports=[{'port':'DK','vid':0x1366,'serial':'00012345'}]
        with tempfile.TemporaryDirectory() as d,patch.object(launch,'ROOT',Path(d)),\
             patch.object(launch,'config',return_value=cfg),patch.object(launch,'serial_inventory',return_value=ports),\
             patch.object(launch,'start_logic'),patch.object(launch,'logic_devices',return_value=[]),\
             patch.object(launch,'doctor',return_value={'ready':False,'blocking':['No analyzer']}),\
             patch('ppk2_api.ppk2_api.PPK2_API.list_devices',return_value=['PPK']),\
             patch('builtins.input',side_effect=['1800','READY']),redirect_stdout(io.StringIO()) as output:
            launch.configure_bench()
            saved=json.loads((Path(d)/'bench.local.json').read_text())
        self.assertEqual(saved['saleae_device_id'],'');self.assertTrue(saved['power_wiring_verified'])
        self.assertIn('"power_only"',output.getvalue())
