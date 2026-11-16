#!/usr/bin/env python3
"""Export tracked/public source plus verified build images; exclude local secrets."""
from pathlib import Path
import hashlib
import json
import subprocess
import stat
import sys
import zipfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from workbench.build import source_hash


def main():
    top=subprocess.check_output(['git','rev-parse','--show-toplevel'],cwd=ROOT,text=True).strip()
    if Path(top).resolve()!=ROOT:raise RuntimeError('Initialize this workbench as its own Git repository first')
    names=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT).decode().split('\0')
    dest=ROOT/'output/cranium-closed-loop-kit.zip';dest.parent.mkdir(exist_ok=True)
    files={}
    for name in names:
        if not name:continue
        p=Path(name)
        if p.parts[0] in ('.git','.local','.state','.venv','.west','deps','captures','build','output') or name=='bench.local.json' or p.name.startswith('.env'):
            continue
        source=ROOT/p
        if source.is_symlink() or not source.is_file():raise ValueError('Unexpected source entry: '+name)
        files[name]=source.read_bytes()
    for profile in ('baseline','optimized'):
        folder=ROOT/'build'/profile
        manifest=json.loads((folder/'manifest.json').read_text())
        if manifest['source_sha256']!=source_hash():raise ValueError('Firmware changed since its build')
        for rel,name in (('app/zephyr/zephyr.hex','application.hex'),('ipc_radio/zephyr/zephyr.hex','network.hex')):
            data=(folder/name).read_bytes()
            if hashlib.sha256(data).hexdigest()!=manifest['images'][rel]:raise ValueError('Image checksum mismatch')
            files[f'firmware-artifacts/{profile}/{name}']=data
        files[f'firmware-artifacts/{profile}/manifest.json']=(folder/'manifest.json').read_bytes()
    pdf=ROOT/'output/pdf/cranium-closed-loop-readme.pdf'
    if pdf.exists():files['docs/current-readme.pdf']=pdf.read_bytes()
    manifest={'hardware_passed':False,'note':'Source/build distribution only; inspect actual rig reports for HIL proof.',
              'files':{name:hashlib.sha256(data).hexdigest() for name,data in sorted(files.items())}}
    with zipfile.ZipFile(dest,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for name,data in sorted(files.items()):
            info=zipfile.ZipInfo('cranium-workbench/'+name)
            info.create_system=3;info.compress_type=zipfile.ZIP_DEFLATED
            executable=name.endswith('.command') or name in ('bench','mcp-server','setup.sh')
            info.external_attr=(stat.S_IFREG|(0o755 if executable else 0o644))<<16
            z.writestr(info,data)
        z.writestr('cranium-workbench/kit-manifest.json',json.dumps(manifest,indent=2)+'\n')
    with zipfile.ZipFile(dest) as z:
        assert z.testzip() is None
        for name,digest in manifest['files'].items():assert hashlib.sha256(z.read('cranium-workbench/'+name)).hexdigest()==digest
    print(dest)
    print('Source/HEX kit verified; local credentials and captures excluded.')


if __name__=='__main__':main()
