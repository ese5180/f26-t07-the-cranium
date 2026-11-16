#!/usr/bin/env python3
"""Resolve the public manifest offline against an already installed pinned SDK.

Run with the NCS toolchain's Python, or install requirements-build.txt first.
Does not fetch dependencies or modify the installed SDK.
"""
import argparse
from pathlib import Path
from tempfile import TemporaryDirectory
from west.manifest import Manifest


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--sdk',type=Path,default=Path('/opt/nordic/ncs/v3.4.0'))
    args=p.parse_args();app=Path(__file__).resolve().parents[1]/'app'
    def importer(project,file):
        relative=Path(project.path).relative_to('deps')
        source=(args.sdk/relative/file).resolve()
        if not source.is_relative_to(args.sdk.resolve()):raise ValueError('Manifest import escapes SDK')
        return source.read_text()
    with TemporaryDirectory(prefix='cranium-west-') as d:
        root=Path(d);(root/'.west').mkdir()
        (root/'deps').symlink_to(args.sdk,target_is_directory=True)
        (root/'.west/config').write_text('[manifest]\npath = app\nfile = west.yml\n')
        (root/'app').symlink_to(app,target_is_directory=True)
        manifest=Manifest(topdir=root,importer=importer)
        assert all(project.name=='manifest' or project.path.startswith('deps/') for project in manifest.projects)
        nrf=manifest.get_projects(['nrf'])[0]
        assert nrf.revision=='99553055607b2e9885fbc80ccd11fa9da81c2df0'
        for name in ('nrf','zephyr','nrfxlib','hal_nordic','cmsis_6'):
            project=manifest.get_projects([name])[0]
            print(name,project.path,project.revision)
        print('Recursive manifest resolved:',len(manifest.projects),'projects; fetched SDK paths isolated under deps/')


if __name__=='__main__':main()
