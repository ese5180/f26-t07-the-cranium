#!/usr/bin/env python3
"""Feed existing NDJSON history events into the CRANIUM UART/BLE peripheral.

Does not invent playback history or install an observer into Mixxx. The input
must be an actual event journal produced by an installed observer/integration.
Usage: .venv/bin/python tools/relay-journal.py journal.jsonl /dev/cu.usbmodem...
"""
import argparse
import json
from pathlib import Path
import sys
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from workbench.protocol import encode,parse_ack


def main():
    import serial
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('journal',type=Path);p.add_argument('port')
    p.add_argument('--follow',action='store_true')
    p.add_argument('--sequence',type=int,default=int(time.time()))
    args=p.parse_args();seq=args.sequence
    with args.journal.open() as stream,serial.Serial(args.port,115200,timeout=1,write_timeout=1,exclusive=True) as uart:
        uart.reset_input_buffer()
        while True:
            position=stream.tell();line=stream.readline()
            if not line or not line.endswith('\n'):
                if not args.follow:break
                stream.seek(position);time.sleep(.1);continue
            event=json.loads(line)
            uart.write(encode(seq,event));uart.flush()
            ack=parse_ack(uart.readline())
            if ack['seq']!=seq or ack['status']!='OK':raise RuntimeError('Telemetry receipt failed: '+str(ack))
            print(json.dumps(ack),flush=True)
            # radio_queued=false means no wireless receiver or no queue space;
            # it must never be described as delivered to a laptop.
            seq=(seq+1)&0xffffffff


if __name__=='__main__':main()
