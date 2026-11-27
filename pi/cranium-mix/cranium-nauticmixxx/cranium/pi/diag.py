"""Read-only connection evidence captured on the Pi during an offline update."""
from pathlib import Path
import stat


def capture():
    devices=[]
    for entry in sorted(Path('/sys/bus/usb/devices').glob('*')):
        if not (entry/'idVendor').exists():
            continue
        fields={}
        for name in ('idVendor','idProduct','manufacturer','product'):
            try:
                fields[name]=(entry/name).read_text().strip()
            except OSError:
                pass
        if fields:
            devices.append(fields)
    evidence={'usb_devices':devices,'audio':{},'midi_nodes':[]}
    for name,path in [('cards','/proc/asound/cards'),('sequencer','/proc/asound/seq/clients')]:
        try:
            evidence['audio'][name]=Path(path).read_text()
        except OSError as error:
            evidence['audio'][name]=str(error)
    for node in sorted(Path('/dev/snd').glob('midi*')):
        value=node.stat()
        evidence['midi_nodes'].append({'name':node.name,'mode':stat.filemode(value.st_mode),'uid':value.st_uid,'gid':value.st_gid})
    return evidence
