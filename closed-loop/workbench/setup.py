"""Repeatable local installation. No credentials copied, board flashed or power enabled."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import tomllib
import urllib.request
import zipfile
from .build import ROOT,sdk_env
from .launch import agent_cli
from .runner import config


# Saleae's download host answers 403 to urllib's default User-Agent, so every download names this tool.
USER_AGENT='cranium-bench-setup/1 (+https://github.com/ese5180/f26-t07-the-cranium)'


def download(url,path,digest):
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest()==digest:return
    temp=path.with_suffix('.download')
    request=urllib.request.Request(url,headers={'User-Agent':USER_AGENT})
    with urllib.request.urlopen(request,timeout=30) as source,temp.open('wb') as target:
        shutil.copyfileobj(source,target)
    if hashlib.sha256(temp.read_bytes()).hexdigest()!=digest:
        temp.unlink();raise RuntimeError('Archive checksum mismatch: '+url)
    temp.replace(path)


def register_mcp(cfg):
    # agent_config in bench.local.json names the coding agent's TOML file that
    # lists its MCP servers under [mcp_servers.*]. Without one, register
    # ./mcp-server as cranium-bench through the agent's own settings.
    if not cfg.get('agent_config'):
        print('Register '+str(ROOT/'mcp-server')+' as the MCP server cranium-bench in your coding agent,')
        print('or set agent_config in bench.local.json and run setup.sh again.')
        return
    path=Path(cfg['agent_config']).expanduser();path.parent.mkdir(parents=True,exist_ok=True)
    text=path.read_text() if path.exists() else ''
    before=tomllib.loads(text)
    ours=before.get('mcp_servers',{}).get('cranium-bench')
    command=str(ROOT/'mcp-server')
    if ours:
        if ours.get('command')!=command:raise RuntimeError('cranium-bench already points at another checkout; update that entry intentionally')
        return
    backup=ROOT/'.state/agent-config.before-mcp.toml'
    if not backup.exists():backup.write_text(text);backup.chmod(0o600)
    # Append exactly one project adapter. The CLI MCP-add command in the tested
    # desktop build normalizes away unknown fields in existing servers, so do
    # not round-trip the user's unrelated configuration through its serializer.
    updated=text+'\n[mcp_servers.cranium-bench]\ncommand = '+json.dumps(command)+'\n'
    after=tomllib.loads(updated)
    for name,value in before.get('mcp_servers',{}).items():assert after['mcp_servers'][name]==value
    for key in ('approval_policy','sandbox_mode','sandbox_workspace_write'):assert before.get(key)==after.get(key)
    path.write_text(updated)


def main():
    if platform.system()!='Darwin' or platform.machine()!='arm64':
        raise RuntimeError('This installed kit is qualified for Apple Silicon macOS; adapt the platform lock before using another host')
    local=ROOT/'.local';state=ROOT/'.state'
    for p in (local,state):p.mkdir(mode=0o700,exist_ok=True);p.chmod(0o700)
    lock=json.loads((ROOT/'upstream.lock.json').read_text())
    hapi=lock['hapimatic'];archive=local/'hapi-darwin-arm64.tar.gz'
    download('https://github.com/SolidPD/hapimatic-core/releases/download/v'+hapi['version']+'/hapi-darwin-arm64.tar.gz',archive,hapi['archive_sha256'])
    if not (local/'hapi').exists():
        with tarfile.open(archive) as t:
            for name in ('hapi','LICENSE','NOTICE','THIRD-PARTY-NOTICES.md'):
                member=t.getmember(name)
                if not member.isfile():raise ValueError('Unexpected archive entry')
                (local/name).write_bytes(t.extractfile(member).read())
        (local/'hapi').chmod(0o755)
    with tarfile.open(archive) as t:
        expected=hashlib.sha256(t.extractfile('hapi').read()).digest()
    if hashlib.sha256((local/'hapi').read_bytes()).digest()!=expected:
        raise RuntimeError('Hapimatic executable differs from pinned official archive')
    logic=lock['logic2'];archive=local/'Logic-2.4.49-macos-arm64.zip'
    download(logic['archive_url'],archive,logic['archive_sha256'])
    app=local/'logic2/Saleae Logic.app'
    if not app.exists():
        app.parent.mkdir(exist_ok=True)
        subprocess.run(['ditto','-x','-k',str(archive),str(app.parent)],check=True)
    # Logic's embedded Python generates extra .pyc files inside its signed
    # bundle on first launch. Remove ONLY those unarchived disposable caches,
    # then verify the original signature; do not re-sign or skip verification.
    with zipfile.ZipFile(archive) as z:
        archived=set(z.namelist())
    for file in app.rglob('*.pyc'):
        if file.parent.name=='__pycache__' and str(file.relative_to(app.parent)) not in archived:
            file.unlink()
    subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
    sdk,env=sdk_env()
    if not (sdk/'zephyr').is_dir():raise RuntimeError('Install NCS 3.4.0 or set CRANIUM_SDK and CRANIUM_TOOLCHAIN')
    if not (ROOT/'bench.local.json').exists():shutil.copyfile(ROOT/'bench.example.json',ROOT/'bench.local.json')
    cfg=config()
    if not cfg.get('agent'):
        print('No coding agent set: add agent (and agent_cli if it is not on PATH) to bench.local.json before Start AI Loop.')
    elif not agent_cli(cfg):
        raise RuntimeError('Install and sign in to the coding agent named in bench.local.json before starting an AI loop')
    else:
        register_mcp(cfg)
    for file in ('bench','mcp-server','setup.sh','Open Workbench.command','Configure Bench.command','Start AI Loop.command'):
        (ROOT/file).chmod(0o755)
    print('CRANIUM software setup ready. No board flashed and no PPK2 output enabled.')
    print('Next: PHYSICAL-SETUP.md, then Configure Bench.command and Start AI Loop.command.')


if __name__=='__main__':main()
