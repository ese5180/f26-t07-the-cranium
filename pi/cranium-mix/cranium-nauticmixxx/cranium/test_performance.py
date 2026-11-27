import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('performance', Path(__file__).resolve().parent / 'pi/performance.py')
performance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(performance)


class PerformanceTests(unittest.TestCase):
    def test_throttling_current_and_historical_are_distinct(self):
        flags = performance.throttle_flags('throttled=0x50001')
        self.assertEqual(flags['current'], ['undervoltage'])
        self.assertEqual(flags['since_boot'], ['undervoltage', 'throttled'])
        self.assertEqual(performance.throttle_flags('throttled=0x0')['current'], [])
        self.assertIsNone(performance.throttle_flags('command unavailable'))

    def test_cpu_guest_time_is_not_double_counted_and_iowait_is_separate(self):
        first = performance.cpu_counters('cpu  100 0 50 700 50 0 0 0 20 0\ncpu0 1 0 0 1 0 0 0 0\n')
        second = performance.cpu_counters('cpu  150 0 60 720 70 0 0 0 30 0\n')
        self.assertEqual(first['total_ticks'], 900)
        self.assertEqual(performance.rates(first, second), {'busy_percent': 60.0, 'iowait_percent': 20.0})
        self.assertIsNone(performance.rates(first, first))
        self.assertIsNone(performance.rates(None, second))

    def test_missing_memory_fields_are_unknown_not_fabricated_zeroes(self):
        self.assertEqual(performance.memory('MemTotal: 1000 kB\nSwapFree: 500 kB\n'),
                         {'MemTotal_kib': 1000, 'SwapFree_kib': 500})
        self.assertEqual(performance.memory('MemAvailable: unavailable\n'), {})

    def test_capture_is_bounded_and_unavailable_pi_sensors_are_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proc = root / 'proc'; proc.mkdir()
            (proc / 'uptime').write_text('100.0 80.0\n')
            (proc / 'stat').write_text('cpu 100 0 50 700 50 0 0 0\n')
            (proc / 'meminfo').write_text('MemTotal: 1024000 kB\nMemAvailable: 600000 kB\n')
            (proc / 'vmstat').write_text('pgmajfault 5\npswpin 3\npswpout 1\n')
            with mock.patch.object(performance, 'PROC', proc), \
                    mock.patch.object(performance, 'SYS', root / 'sys'), \
                    mock.patch.object(performance, 'RUNTIME', root / 'runtime'), \
                    mock.patch.object(performance, 'STATE', root / 'state'), \
                    mock.patch.object(performance, 'run', return_value={'status': 'unavailable', 'text': ''}), \
                    mock.patch.object(performance.time, 'monotonic', side_effect=[0,0,0,0,1,1,1,2,2,2]), \
                    mock.patch.object(performance.time, 'sleep') as sleep, \
                    mock.patch('builtins.print'):
                path = performance.capture(2, 1)
            report = json.loads(path.read_text())
            self.assertEqual(len(report['samples']), 3)
            self.assertEqual(sleep.call_count, 2)
            self.assertEqual(report['elapsed_seconds'], 2)
            self.assertIsNone(report['samples'][0]['temperature_celsius'])
            self.assertIsNone(report['samples'][0]['throttling'])
            self.assertIsNone(report['samples'][0]['app'])
            self.assertFalse(report['audio_underruns_measured'])
            self.assertFalse(report['audio_settings_changed'])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_native_metrics_use_verified_app_pid_and_handle_stat_format(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / 'runtime'; runtime.mkdir()
            proc = root / 'proc'; base = proc / '123'; base.mkdir(parents=True)
            (runtime / 'cranium-launch.json').write_text(json.dumps({'pid':123, 'uptime_seconds':10}))
            (runtime / 'cranium-window.json').write_text(json.dumps({'pid':123, 'uptime_seconds':13.5}))
            fields = ['R'] + ['0'] * 25
            fields[9], fields[11], fields[12] = '7', '40', '10'
            (base / 'stat').write_text('123 (name with spaces) ' + ' '.join(fields))
            (base / 'comm').write_text('NauticMixxx\n')
            (base / 'status').write_text('Name: NauticMixxx\nVmRSS: 150000 kB\n')
            with mock.patch.object(performance, 'PROC', proc), mock.patch.object(performance, 'RUNTIME', runtime):
                self.assertEqual(performance.app_metrics(),
                    {'pid':123, 'cpu_ticks':50, 'resident_kib':150000, 'major_faults':7})
                self.assertEqual(performance.startup_timing()['launch_to_window_seconds'], 3.5)
                self.assertIn('audio readiness not measured', performance.startup_timing()['meaning'])
                (base / 'comm').write_text('other process')
                self.assertIsNone(performance.app_metrics())
                (runtime / 'cranium-window.json').write_text('{"pid":456,"uptime_seconds":13.5}')
                self.assertEqual(performance.startup_timing(), {'status':'window timing unavailable'})

    def test_missing_command_and_timeout_do_not_break_diagnostics(self):
        import subprocess
        for error in (FileNotFoundError(), subprocess.TimeoutExpired('vcgencmd', 3)):
            with mock.patch.object(performance.subprocess, 'run', side_effect=error):
                self.assertEqual(performance.run(['vcgencmd', 'get_throttled'])['status'], 'unavailable')


if __name__ == '__main__':
    unittest.main()
