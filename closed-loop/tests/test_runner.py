import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from workbench import runner
from workbench.instruments import PowerMeter


class RunnerTests(unittest.TestCase):
    def test_missing_hardware_never_flashes_or_claims_pass(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'requirements.json').write_text(json.dumps(runner.requirements()))
            with patch.object(runner,'ROOT',root),patch.object(runner,'doctor',return_value={'ready':False,'blocking':['Connect board']}),patch.object(runner,'flash') as flash,patch.object(runner,'build') as build:
                result=runner.experiment({})
            self.assertEqual(result['status'],'blocked');self.assertFalse(result['hardware_passed'])
            flash.assert_not_called();build.assert_not_called()
            self.assertTrue((root/'.state/latest.json').is_file())

    def test_power_always_off_and_port_closed_on_measurement_failure(self):
        cfg={'power_wiring_verified':True,'ppk2_port':'test','power_mode':'ampere','voltage_mV':3300}
        device=MagicMock();device.ser.in_waiting=0
        device.get_modifiers.return_value=True;device.modifiers={'Calibrated':'1'}
        with patch('ppk2_api.ppk2_api.PPK2_API') as cls:
            cls.list_devices.return_value=['test'];cls.return_value=device
            with self.assertRaisesRegex(RuntimeError,'measurement failure'):
                with PowerMeter(cfg):raise RuntimeError('measurement failure')
        device.toggle_DUT_power.assert_any_call('ON');device.toggle_DUT_power.assert_called_with('OFF')
        device.ser.close.assert_called_once();device.set_source_voltage.assert_not_called()

    def test_power_refuses_unverified_wiring(self):
        with patch('ppk2_api.ppk2_api.PPK2_API') as cls:
            with self.assertRaises(RuntimeError):
                with PowerMeter({'power_wiring_verified':False}):pass
            cls.assert_not_called()

    def test_bad_ppk_metadata_cannot_enable_power(self):
        cfg={'power_wiring_verified':True,'ppk2_port':'test','power_mode':'ampere','voltage_mV':1800}
        device=MagicMock();device.ser.in_waiting=0;device.get_modifiers.return_value=None
        with patch('ppk2_api.ppk2_api.PPK2_API') as cls:
            cls.list_devices.return_value=['test'];cls.return_value=device
            with self.assertRaisesRegex(RuntimeError,'calibration metadata'):
                with PowerMeter(cfg):pass
        self.assertNotIn((('ON',),{}),[(c.args,c.kwargs) for c in device.toggle_DUT_power.call_args_list])
        device.ser.close.assert_called_once()

    def test_invalid_profile_never_calls_sdk(self):
        from workbench.build import build
        with self.assertRaises(ValueError):build('../../somewhere')

    def test_failed_candidate_restores_verified_baseline(self):
        req=runner.requirements();req['power_repeats']=1
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'requirements.json').write_text(json.dumps(req))
            meter=MagicMock();meter.__enter__.return_value.capture.return_value={'mean_uA':3000}
            with patch.object(runner,'ROOT',root),patch.object(runner,'doctor',return_value={'ready':True}),\
                 patch.object(runner,'source_hash',return_value='frozen'),\
                 patch.object(runner,'build',return_value={'source_sha256':'frozen'}),\
                 patch.object(runner,'PowerMeter',return_value=meter),\
                 patch.object(runner,'functional_capture',side_effect=[{'passed':True},RuntimeError('UART failure')]),\
                 patch.object(runner.time,'sleep'),patch.object(runner,'flash') as flash:
                result=runner.experiment({'board_serial':'123'})
            self.assertEqual(result['status'],'failed');self.assertFalse(result['hardware_passed'])
            self.assertTrue(result['baseline_restored'])
            self.assertEqual([c.args[0] for c in flash.call_args_list],['baseline','optimized','baseline'])

    def test_ppk_serial_fragment_boundaries_preserve_raw_samples(self):
        from workbench.instruments import PowerMeter
        req=runner.requirements();req['power_duration_s']=.003
        device=MagicMock();device.modifiers={'calibration':'test fixture'}
        payload=bytes(range(200))*6
        device.get_data.side_effect=[payload[:1],payload[1:4],payload[4:9],payload[9:],b'']
        device.get_samples.side_effect=lambda data:([3333.0]*(len(data)//4),[])
        meter=PowerMeter({'ppk2_port':'fixture','power_mode':'ampere','voltage_mV':1800,'measurement_scope':'unit fixture'})
        meter.device=device
        times=[0,0,.0002,.0005,.0007,.001,.0012,.0015,.0017,.003]
        with tempfile.TemporaryDirectory() as d,patch('workbench.instruments.time.monotonic',side_effect=times),patch('workbench.instruments.time.sleep'):
            stats=meter.capture(d,req)
            self.assertEqual((Path(d)/'ppk2-raw.bin').read_bytes(),payload)
        self.assertEqual(stats['sample_count'],300)
        self.assertEqual(stats['mean_uA'],3333.0)
        self.assertTrue(all(len(c.args[0])%4==0 for c in device.get_samples.call_args_list))
