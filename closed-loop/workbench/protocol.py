"""Wire contract: CRC-16/CCITT-FALSE over header + UTF-8 NDJSON payload."""
import binascii
import json


def encode(seq, payload):
    if not 0 <= seq <= 0xffffffff:
        raise ValueError('sequence must fit uint32')
    data = json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    if len(data) > 480:
        raise ValueError('telemetry payload exceeds 480 bytes')
    header = f'C1:{seq}:{len(data)}:'.encode() + data
    return header + f'*{binascii.crc_hqx(header, 0xffff):04X}\n'.encode()


def parse_ack(line):
    fields = line.decode('ascii').strip().split(':')
    if len(fields) != 4 or fields[0] != 'ACK' or fields[2] not in ('OK', 'CRC', 'FRAME', 'DUP') or fields[3] not in ('0', '1'):
        raise ValueError('invalid ACK')
    return {'seq': int(fields[1]), 'status': fields[2], 'radio_queued': fields[3] == '1'}
