#!/usr/bin/env python3
"""Ensure flattened installs preserve every controller's referenced script."""
from pathlib import Path
import hashlib
import sys
import xml.etree.ElementTree as ET
root=Path(__file__).resolve().parents[1]
folders=['Hercules_DJControl_Inpulse_500_RX3','Pioneer_DDJ_FLX4_RX3','Pioneer_DDJ_FLX6_RX3','Pioneer_Roland_RX3']
files={}
for folder in folders:
    for source in (root/'controllers'/folder).glob('*.js'):
        data=source.read_bytes()
        assert source.name not in files or files[source.name]==data, f'Conflicting installed script: {source.name}'
        files[source.name]=data
count=0
installed=Path(sys.argv[1]) if len(sys.argv)>1 else None
for folder in folders:
    for preset in (root/'controllers'/folder).glob('*.xml'):
        for script in ET.parse(preset).findall('./controller/scriptfiles/file'):
            name=script.attrib['filename']
            if name not in files:
                # Native Mixxx script libraries live outside the preset folders.
                assert (root.parent/'res/controllers'/name).is_file(), (preset,name)
                continue
            if installed:
                assert (installed/name).read_bytes()==files[name], f'Wrong packaged script: {name}'
            count+=1
print(f'{count} script references verified; no conflicting filenames in flattened installs.')
