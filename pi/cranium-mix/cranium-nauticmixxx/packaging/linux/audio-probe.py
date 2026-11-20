#!/usr/bin/env python3
"""List output devices in a separate process; never touch the DJ engine's streams."""
import ctypes as c
import ctypes.util
import json
import re
import sys


class Device(c.Structure):
    _fields_=[('version',c.c_int),('name',c.c_char_p),('api',c.c_int),('inputs',c.c_int),('outputs',c.c_int),
              ('low_in',c.c_double),('low_out',c.c_double),('high_in',c.c_double),('high_out',c.c_double),('rate',c.c_double)]

class Api(c.Structure):
    _fields_=[('version',c.c_int),('type',c.c_int),('name',c.c_char_p),('count',c.c_int),('default_in',c.c_int),('default_out',c.c_int)]


def normalize(api,name,index):
    hardware='';short=name
    if api=='ALSA':
        match=re.fullmatch(r'(.*) \((plug)?(hw:\d+(?:,\d+)?)\)',name)
        if match:short,hardware=match[1],match[3]
    return api+'|'+short+'|'+hardware+('' if hardware else '|'+str(index))


def probe():
    # LD_LIBRARY_PATH selects the same bundled PortAudio as the main app.
    library=c.CDLL(c.util.find_library('portaudio') or 'libportaudio.so.2')
    library.Pa_Initialize.restype=c.c_int
    library.Pa_GetDeviceCount.restype=c.c_int
    library.Pa_GetDeviceInfo.argtypes=[c.c_int];library.Pa_GetDeviceInfo.restype=c.POINTER(Device)
    library.Pa_GetHostApiInfo.argtypes=[c.c_int];library.Pa_GetHostApiInfo.restype=c.POINTER(Api)
    if library.Pa_Initialize()!=0:raise RuntimeError('Audio device detection is unavailable. Try again.')
    devices=[]
    try:
        count=library.Pa_GetDeviceCount()
        if count<0:raise RuntimeError('Audio device detection failed. Try again.')
        for index in range(count):
            pointer=library.Pa_GetDeviceInfo(index)
            if not pointer:continue
            device=pointer.contents
            if device.outputs<2:continue
            host=library.Pa_GetHostApiInfo(device.api)
            if not host:continue
            name=(device.name or b'').decode('utf-8','replace');api=host.contents.name.decode('utf-8','replace')
            friendly=name
            if 'bcm2835' in name.lower() or 'raspberry' in name.lower():
                friendly='HDMI output' if 'hdmi' in name.lower() else 'Built-in headphones' if 'headphone' in name.lower() else 'Built-in audio'
            devices.append({'id':normalize(api,name,index),'name':friendly+' · '+api,'channels':device.outputs})
    finally:
        library.Pa_Terminate()
    return devices


if __name__=='__main__':
    try:print(json.dumps({'devices':probe()}))
    except Exception as error:
        print(json.dumps({'error':str(error)}));sys.exit(1)
