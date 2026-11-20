#!/usr/bin/python3
"""Bundle a staged ARM64 NauticMixxx build for offline Pi installation."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument('stage', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--engine', type=Path, required=True)
args = parser.parse_args()
if platform.system() != 'Linux' or platform.machine() != 'aarch64':
    raise SystemExit('Package in the ARM64 Bookworm builder.')
project = Path(__file__).resolve().parent.parent
out = args.output.resolve()
root = out / 'stage/opt/cranium/nauticmixxx'
if out.exists():
    raise SystemExit('Use a new output directory.')
shutil.copytree(args.stage, root, symlinks=False)
binary = root / 'libexec/nauticmixxx/NauticMixxx'
if not binary.is_file():
    raise SystemExit('Missing staged native application.')
plugins = root / 'lib/qt6/plugins'
for group in ('platforms', 'imageformats', 'sqldrivers', 'wayland-shell-integration',
              'wayland-graphics-integration-client', 'wayland-decoration-client',
              'egldeviceintegrations'):
    source = Path('/usr/lib/aarch64-linux-gnu/qt6/plugins') / group
    if source.is_dir():
        shutil.copytree(source, plugins / group)
private = root / 'lib/cranium'
private.mkdir(parents=True)
# Match the Pi's graphics driver to its own Wayland/C/C++ runtimes. Never
# repeat the initial BiteDJ package's older-libwayland override.
system = re.compile(r'^(ld-linux-|lib(c|m|dl|rt|pthread|resolv|util|anl|stdc\+\+|gcc_s)\.so|'
                    r'lib(EGL|GL|GLX|GLdispatch|OpenGL|GLESv[12]|gbm|drm.*|vulkan|'
                    r'wayland-(client|cursor|server|egl))\.so)')
libraries = {}
for executable in [binary, *plugins.rglob('*.so')]:
    output = subprocess.check_output(['ldd', str(executable)], text=True)
    if 'not found' in output:
        raise RuntimeError(output)
    for line in output.splitlines():
        match = re.match(r'\s*(\S+) => (/\S+) \(', line)
        if not match:
            continue
        name, path = match.groups()
        if system.match(name) or name in libraries:
            continue
        libraries[name] = str(Path(path).resolve())
        shutil.copyfile(Path(path).resolve(), private / name)
licenses = root / 'share/cranium/licenses'
licenses.mkdir(parents=True)
for name in ('LICENSE', 'LICENSE.md', 'THIRD_PARTY_NOTICES.md'):
    shutil.copyfile(project / name, licenses / ('NauticMixxx-' + name))
shutil.copyfile(args.engine / 'LICENSE', licenses / 'Mixxx-LICENSE')
packages = {}
for name, location in libraries.items():
    found = subprocess.run(['dpkg-query', '-S', location], capture_output=True, text=True)
    if found.returncode:
        found = subprocess.run(['dpkg-query', '-S', '*/' + Path(location).name], capture_output=True, text=True)
    if not found.returncode:
        package = found.stdout.splitlines()[0].split(': /')[0]
        packages[name] = package
        copyright_file = Path('/usr/share/doc') / package.split(':')[0] / 'copyright'
        if copyright_file.is_file():
            shutil.copyfile(copyright_file, licenses / (package.replace(':', '_') + '.copyright'))
fonts = root / 'share/cranium/fonts'
shutil.copytree(args.engine / 'res/fonts', fonts)
commit = lambda path: subprocess.check_output(['git', '-C', str(path), 'rev-parse', 'HEAD'], text=True).strip()
metadata = {'product': 'NauticMixxx Cranium 800x480 trial', 'overlay_commit': commit(project),
            'engine_commit': commit(args.engine), 'arch': 'aarch64', 'os': 'Debian 12 Bookworm',
            'reference_size': [1280, 800], 'trial_size': [800, 480],
            'scaling': 'Live reference scaler with ReferenceFill=true; persistent touch navigation, hidden pad strip',
            'navigation': 'Tap active navigation button again to return to performance',
            'uses_system_wayland_and_graphics': True, 'private_libraries': libraries,
            'library_packages': packages, 'hardware_playback_tested': False}
(root / 'share/cranium/build.json').write_text(json.dumps(metadata, indent=2) + '\n')
archive = out / 'nauticmixxx-arm64-bookworm.tar.gz'
with tarfile.open(archive, 'w:gz', dereference=True) as tar:
    tar.add(root, arcname='nauticmixxx')
manifest = {**metadata, 'archive': archive.name,
            'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
            'unpacked_bytes': sum(p.stat().st_size for p in root.rglob('*') if p.is_file())}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({key: manifest[key] for key in ('archive', 'sha256', 'unpacked_bytes', 'overlay_commit', 'engine_commit')}, indent=2))
