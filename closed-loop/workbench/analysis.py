"""Independent decoding and acceptance: never manufacture hardware evidence."""
import bisect
import csv
import math
import re
import statistics
from pathlib import Path


def uart_bytes(edges, baud=115200):
    """Decode 8N1 from Saleae transition times; sample at the center of each bit."""
    if len(edges) < 2:
        return []
    times = [t for t, _ in edges]
    bit = 1 / baud
    decoded = []
    busy_until = -math.inf
    previous = edges[0][1]
    for start, level in edges[1:]:
        falling = previous == 1 and level == 0
        previous = level
        if not falling or start < busy_until - bit * .1:
            continue
        def at(t):
            index = bisect.bisect_right(times, t) - 1
            if index < 0 or t > times[-1]:
                raise ValueError('truncated UART byte')
            return edges[index][1]
        if at(start + .5 * bit) != 0 or at(start + 9.5 * bit) != 1:
            raise ValueError('UART framing error')
        value = sum(at(start + (1.5 + i) * bit) << i for i in range(8))
        decoded.append((start, value, start + 10 * bit))
        busy_until = start + 10 * bit
    return decoded


def uart_lines(decoded):
    lines, data, begin = [], bytearray(), None
    for start, value, end in decoded:
        if begin is None:
            begin = start
        data.append(value)
        if value == 10:
            lines.append((begin, bytes(data), end))
            data, begin = bytearray(), None
    return lines


def read_edges(path, channels):
    with Path(path).open(newline='') as stream:
        rows = csv.reader(stream)
        names = next(rows)
        positions = {}
        for channel in channels:
            matches = [i for i, s in enumerate(names) if re.fullmatch(r'(?:Channel\s*|D)' + str(channel), s.strip(), re.I)]
            if len(matches) != 1:
                raise ValueError(f'Saleae CSV missing channel {channel}: {names}')
            positions[channel] = matches[0]
        edges = {c: [] for c in channels}
        last_time = -math.inf
        for row in rows:
            t = float(row[0])
            if not math.isfinite(t) or t < last_time:
                raise ValueError('invalid capture timestamps')
            last_time = t
            for c, pos in positions.items():
                v = int(row[pos])
                if v not in (0, 1):
                    raise ValueError('invalid logic level')
                if not edges[c] or edges[c][-1][1] != v:
                    edges[c].append((t, v))
        for c in channels:
            if edges[c] and edges[c][-1][0] < last_time:
                edges[c].append((last_time, edges[c][-1][1]))
        return edges


def validate_uart(path, cfg, requirements, expected):
    channels = [cfg['rx_channel'], cfg['tx_channel']]
    edges = read_edges(path, channels)
    incoming = uart_lines(uart_bytes(edges[channels[0]], requirements['baud']))
    outgoing = uart_lines(uart_bytes(edges[channels[1]], requirements['baud']))
    rx = [(a, b, c) for a, b, c in incoming if b.startswith(b'C1:')]
    tx = [(a, b, c) for a, b, c in outgoing if b.startswith(b'ACK:')]
    if len(rx) != len(expected) or len(tx) != len(expected):
        raise ValueError(f'logic capture frame count: RX={len(rx)} ACK={len(tx)}, expected {len(expected)}')
    latencies = []
    for request, reply, test in zip(rx, tx, expected):
        if request[1] != bytes.fromhex(test['wire_hex']):
            raise ValueError('logic capture differs from transmitted bytes')
        fields = reply[1].decode('ascii').strip().split(':')
        if len(fields) != 4 or fields[:3] != ['ACK', str(test['seq']), test['status']] or fields[3] not in ('0','1'):
            raise ValueError(f'unexpected logic ACK {reply[1]!r}')
        latency = (reply[0] - request[2]) * 1000
        # Receiver hardware can assert RX-ready during the final stop bit;
        # allow 20 us of stop-bit/sample quantization, never a late ACK.
        if not -.020 <= latency <= requirements['ack_latency_ms_max']:
            raise ValueError(f'ACK latency {latency:.3f} ms outside bound')
        latencies.append(max(0,latency))
    return {'passed': True, 'frames': len(expected), 'ack_latency_ms_max': max(latencies),
            'ack_latency_ms_mean': statistics.fmean(latencies), 'source': 'saleae_raw_digital_csv'}


def power_stats(values, seconds, requirements, sample_rate=100000):
    if not values or any(not math.isfinite(v) or v < 0 for v in values):
        raise ValueError('missing, negative or non-finite current samples')
    coverage = len(values) / (seconds * sample_rate)
    if not requirements['power_sample_coverage_min'] <= coverage <= 1.15:
        raise ValueError(f'invalid PPK2 sample coverage {coverage:.1%}')
    mean = statistics.fmean(values)
    if not requirements['power_current_uA_min'] <= mean <= requirements['power_current_uA_max']:
        raise ValueError('current outside credible measurement range; check rail and wiring')
    return {'mean_uA': mean, 'peak_uA': max(values), 'sample_count': len(values),
            'duration_s': seconds, 'sample_rate_hz': sample_rate, 'coverage': coverage}


def compare_power(before, after, requirements):
    if len(before) != requirements['power_repeats'] or len(after) != len(before):
        raise ValueError('incomplete before/after repeats')
    baseline = statistics.median(v['mean_uA'] for v in before)
    optimized = statistics.median(v['mean_uA'] for v in after)
    reduction = 100 * (1 - optimized / baseline)
    # Require improvement in every paired run, as well as the median threshold.
    consistent = all(a['mean_uA'] < b['mean_uA'] for b, a in zip(before, after))
    return {'passed': consistent and reduction >= requirements['power_reduction_percent_min'],
            'baseline_median_uA': baseline, 'optimized_median_uA': optimized,
            'reduction_percent': reduction, 'every_pair_improved': consistent,
            'required_reduction_percent': requirements['power_reduction_percent_min']}
