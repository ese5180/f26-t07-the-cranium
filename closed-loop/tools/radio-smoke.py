#!/usr/bin/env python3
"""Optional real BLE end-to-end check, separate from the disconnected idle test."""
import asyncio
import datetime as dt
import fcntl
import json
from pathlib import Path
import sys
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from workbench.build import ROOT,build,flash
from workbench.runner import config,save
from workbench.instruments import PowerMeter
from workbench.protocol import encode,parse_ack

TX='6e400003-b5a3-f393-e0a9-e50e24dcca9e'


async def check(cfg,folder):
    import serial
    from bleak import BleakScanner,BleakClient
    devices=[d for d in await BleakScanner.discover(timeout=12) if d.name=='CRANIUM-Link']
    if len(devices)!=1:raise RuntimeError('Expected exactly one advertising CRANIUM-Link')
    received=[];raw=[];buffer=bytearray()
    def notify(characteristic,data):
        raw.append({'time':time.monotonic(),'hex':bytes(data).hex()});buffer.extend(data)
        while b'\n' in buffer:
            line,_,rest=buffer.partition(b'\n');buffer[:]=rest
            received.append(json.loads(line))
    try:
        async with BleakClient(devices[0]) as client:
            await client.start_notify(TX,notify);await asyncio.sleep(2)
            events=[{'v':1,'type':'play','deck':1,'track_id':'bench-A','title':'Transition A'},
                    {'v':1,'type':'play','deck':2,'track_id':'bench-B','title':'Transition B'}]
            with serial.Serial(cfg['uart_port'],115200,timeout=1,write_timeout=1,exclusive=True) as uart:
                uart.reset_input_buffer()
                for seq,event in enumerate(events,1000):
                    uart.write(encode(seq,event));uart.flush()
                    ack=await asyncio.to_thread(uart.readline)
                    reply=parse_ack(ack)
                    if reply['seq']!=seq or reply['status']!='OK' or not reply['radio_queued']:
                        raise RuntimeError('No encrypted subscribed BLE queue: '+str(reply))
                    await asyncio.sleep(.2)
            for _ in range(100):
                if len(received)>=2:break
                await asyncio.sleep(.1)
            if received!=events:raise RuntimeError('Radio events missing, reordered or altered')
    finally:save(folder/'raw-notifications.json',raw)
    save(folder/'radio-result.json',{'hardware_passed':True,'source':'bleak_notifications_from_physical_DK',
                                   'received_events':received,'security':'BLE L2 encrypted Just Works; no MITM authentication'})


def main():
    cfg=config();stamp=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    folder=ROOT/'captures'/('radio-'+stamp);folder.mkdir(parents=True)
    with (ROOT/'.state/bench.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        build('optimized')
        with PowerMeter(cfg):
            flash('optimized',cfg['board_serial'],folder/'flash.log');time.sleep(3)
            asyncio.run(check(cfg,folder))
    print('Real UART -> BLE events verified:',folder)


if __name__=='__main__':main()
