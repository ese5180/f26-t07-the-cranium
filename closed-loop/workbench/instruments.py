"""USB instrument adapters. Real captures only; simulation is never accepted."""
import csv
import json
import statistics
import time
from pathlib import Path
from .analysis import power_stats
from .protocol import encode, parse_ack


def serial_inventory():
    from serial.tools.list_ports import comports
    return [{'port': p.device, 'product': p.product, 'serial': p.serial_number,
             'vid': p.vid, 'pid': p.pid} for p in comports()]


def logic_devices(port=10430):
    from saleae import automation as a
    with a.Manager.connect(port=port, connect_timeout_seconds=3) as manager:
        return [{'id': d.device_id, 'simulation': d.is_simulation, 'type': str(d.device_type)}
                for d in manager.get_devices(include_simulation_devices=True)]


def drain_stream(device, quiet_seconds=.3, timeout=5):
    """Wait for a genuinely quiet stopped stream, including in-flight USB data."""
    started=last_data=time.monotonic()
    while time.monotonic()-started < timeout:
        available=device.ser.in_waiting
        if available:
            device.ser.read(available)
            last_data=time.monotonic()
        elif time.monotonic()-last_data >= quiet_seconds:
            return
        time.sleep(.01)
    raise RuntimeError('PPK2 stream failed to become quiet before calibration')


class PowerMeter:
    def __init__(self, cfg):
        self.cfg, self.device = cfg, None

    def __enter__(self):
        from ppk2_api.ppk2_api import PPK2_API
        if self.cfg.get('power_wiring_verified') is not True:
            raise RuntimeError('Power wiring must be verified in bench.local.json first')
        port = self.cfg['ppk2_port']
        if port not in PPK2_API.list_devices():
            raise RuntimeError('Configured PPK2 is not present')
        self.device = p = PPK2_API(port, timeout=1, write_timeout=1, exclusive=True)
        try:
            p.stop_measuring()
            drain_stream(p)
            if p.get_modifiers() is not True:
                raise RuntimeError('PPK2 calibration metadata unavailable; select the data port and check the instrument')
            if str(p.modifiers.get('Calibrated','')).lower() not in ('1','1.0','true','yes'):
                raise RuntimeError('PPK2 does not report factory calibration; qualify the instrument before measuring')
            mode = self.cfg['power_mode']
            mv = self.cfg['voltage_mV']
            if not 1700 <= mv <= 3600:
                raise ValueError('nRF5340 bench voltage must be 1700..3600 mV')
            if mode == 'ampere':
                p.use_ampere_meter()
                # 0.9.2 needs the external rail voltage for calibration and
                # start_measuring even in ampere mode. Do NOT command a source.
                p.current_vdd = mv
            elif mode == 'source':
                p.use_source_meter(); p.set_source_voltage(mv)
            else:
                raise ValueError('unknown PPK2 power mode')
            p.toggle_DUT_power('ON')
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *args):
        if self.device:
            try:
                self.device.stop_measuring()
            finally:
                try:
                    self.device.toggle_DUT_power('OFF')
                finally:
                    self.device.ser.close()

    def capture(self, folder, requirements):
        folder = Path(folder); folder.mkdir(parents=True, exist_ok=True)
        values, chunks, pending = [], [], bytearray()
        p = self.device
        duration = requirements['power_duration_s']
        # Discard stale samples from functional traffic; only idle belongs here.
        p.ser.reset_input_buffer()
        (folder / 'ppk2-calibration.json').write_text(json.dumps(p.modifiers,indent=2)+'\n')
        p.start_measuring(); start = time.monotonic()
        raw=(folder/'ppk2-raw.bin').open('wb')
        try:
            while time.monotonic() - start < duration:
                data = p.get_data()
                if data:
                    raw.write(data);pending.extend(data)
                    complete=len(pending)//4*4
                    if not complete:
                        continue
                    samples, _ = p.get_samples(bytes(pending[:complete]));del pending[:complete]
                    values.extend(samples)
                    chunks.append((time.monotonic()-start, len(samples)))
                    if len(samples) >= 500 and statistics.fmean(samples) > requirements['power_current_uA_max']:
                        p.toggle_DUT_power('OFF')
                        raise RuntimeError('PPK2 overcurrent limit; output will be switched off')
                time.sleep(.005)
        finally:
            raw.close()
            p.stop_measuring()
            with (folder / 'current.csv').open('w', newline='') as stream:
                writer = csv.writer(stream)
                writer.writerow(['sample_index', 'nominal_sample_time_s', 'current_uA'])
                writer.writerows((i, f'{i/100000:.6f}', f'{v:.4f}') for i, v in enumerate(values))
            (folder / 'chunks.json').write_text(json.dumps(chunks))
        stats = power_stats(values, duration, requirements)
        stats.update(source='ppk2_usb', port=self.cfg['ppk2_port'], mode=self.cfg['power_mode'],
                     voltage_mV=self.cfg['voltage_mV'], scope=self.cfg['measurement_scope'])
        (folder / 'power.json').write_text(json.dumps(stats, indent=2) + '\n')
        return stats


def stimulus(requirements):
    tests = []
    for seq in range(requirements['valid_frames']):
        payload = {'v': 1, 'type': 'play', 'deck': seq % 2 + 1,
                   'track_id': f'cranium-test-{seq}', 'title': 'Bench track', 'bpm': 130}
        tests.append({'seq': seq, 'status': 'OK', 'wire_hex': encode(seq, payload).hex()})
    tests.append(dict(tests[-1], status='DUP'))
    bad = bytearray(encode(requirements['valid_frames'], {'v': 1, 'type': 'corrupt-test'}))
    bad[-2] = ord('0') if bad[-2] != ord('0') else ord('1')
    tests.append({'seq': requirements['valid_frames'], 'status': 'CRC', 'wire_hex': bytes(bad).hex()})
    return tests


def functional_capture(folder, cfg, requirements):
    from saleae import automation as a
    import serial
    from .analysis import validate_uart
    folder = Path(folder); folder.mkdir(parents=True, exist_ok=True)
    tests = stimulus(requirements)
    (folder / 'stimulus.json').write_text(json.dumps(tests, indent=2) + '\n')
    with a.Manager.connect(port=cfg['saleae_port'], connect_timeout_seconds=3) as manager:
        actual = [d for d in manager.get_devices() if not d.is_simulation and d.device_id == cfg['saleae_device_id']]
        if len(actual) != 1:
            raise RuntimeError('The configured real Saleae is not connected')
        channels = [cfg['rx_channel'], cfg['tx_channel']]
        device = a.LogicDeviceConfiguration(enabled_digital_channels=channels,
                                            digital_sample_rate=requirements['capture_sample_rate'])
        capture_config = a.CaptureConfiguration(capture_mode=a.TimedCaptureMode(duration_seconds=requirements['capture_duration_s']))
        with serial.Serial(cfg['uart_port'], requirements['baud'], timeout=1, write_timeout=1, exclusive=True) as uart:
            uart.reset_input_buffer()
            with manager.start_capture(device_id=cfg['saleae_device_id'], device_configuration=device,
                                       capture_configuration=capture_config) as capture:
                finished = False
                try:
                    time.sleep(.25)
                    for test in tests:
                        uart.write(bytes.fromhex(test['wire_hex'])); uart.flush()
                        # Serial is a supplementary liveness check; timing pass
                        # comes only from independent physical Saleae edges.
                        reply = parse_ack(uart.readline())
                        if reply['seq'] != test['seq'] or reply['status'] != test['status']:
                            raise RuntimeError(f'Unexpected serial reply {reply}')
                        time.sleep(.005)
                    capture.wait()
                    finished = True
                finally:
                    if not finished:
                        capture.stop()
                    capture.save_capture(str(folder / 'capture.sal'))
                    capture.export_raw_data_csv(directory=str(folder), digital_channels=channels)
    stats = validate_uart(folder / 'digital.csv', cfg, requirements, tests)
    (folder / 'functional.json').write_text(json.dumps(stats, indent=2) + '\n')
    return stats
