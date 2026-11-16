"""One-click services, bench selection and a requirements-seeded Hapimatic run."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.error
import urllib.request
import webbrowser
from .build import ROOT
from .runner import config, doctor, save
from .instruments import serial_inventory, logic_devices

URL='http://127.0.0.1:3006'


def environment():
    env=os.environ.copy()
    # The coding agent is chosen per Mac in the Git-ignored bench.local.json:
    # `agent` is Hapimatic's name for it, `agent_cli` its command or full path
    # when that is not on PATH.
    cli=agent_cli(config())
    env['PATH']=str(Path(cli).parent)+os.pathsep+env['PATH'] if cli else env['PATH']
    env.update(HAPI_HOME=str(ROOT/'.state/hapi'),WEBAPP_PORT='3006',HAPI_API_URL=URL,WEBAPP_URL=URL)
    return env


def agent_cli(cfg):
    name=cfg.get('agent_cli') or cfg.get('agent') or ''
    return shutil.which(name) if name else None


def api(path, body=None, token=None):
    headers={'Content-Type':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    request=urllib.request.Request(URL+path,data=json.dumps(body).encode() if body is not None else None,headers=headers)
    with urllib.request.urlopen(request,timeout=90) as response:return json.load(response)


def start_logic():
    from saleae import automation as a
    try:
        with a.Manager.connect(port=10430,connect_timeout_seconds=1):return
    except Exception:pass
    binary=ROOT/'.local/logic2/Saleae Logic.app/Contents/MacOS/Logic'
    if not binary.exists():raise RuntimeError('Run setup.sh to install Saleae Logic 2')
    log=ROOT/'.state/logic2.log';log.parent.mkdir(mode=0o700,exist_ok=True)
    with log.open('ab') as output:
        env=os.environ.copy();env['PYTHONDONTWRITEBYTECODE']='1'
        subprocess.Popen([str(binary),'--automation','--automationPort','10430'],stdin=subprocess.DEVNULL,
                         stdout=output,stderr=subprocess.STDOUT,start_new_session=True,env=env)
    with a.Manager.connect(port=10430,connect_timeout_seconds=30):pass


def services():
    state=ROOT/'.state';state.mkdir(mode=0o700,exist_ok=True);state.chmod(0o700)
    env=environment();hapi=ROOT/'.local/hapi'
    if not hapi.exists():raise RuntimeError('Run setup.sh to install Hapimatic')
    try:
        with urllib.request.urlopen(URL+'/',timeout=2):pass
    except urllib.error.URLError:
        with (state/'hapi-server.log').open('ab') as output:
            subprocess.Popen([str(hapi),'server'],cwd=ROOT,env=env,stdin=subprocess.DEVNULL,
                             stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
        for _ in range(60):
            try:
                with urllib.request.urlopen(URL+'/',timeout=1):break
            except urllib.error.URLError:time.sleep(.5)
        else:raise RuntimeError('Hapimatic startup timed out; see .state/hapi-server.log')
    settings=json.loads((state/'hapi/settings.json').read_text())
    jwt=api('/api/auth',{'accessToken':settings['cliApiToken']})['token']
    with (state/'hapi-daemon.log').open('ab') as output:
        subprocess.run([str(hapi),'daemon','start'],cwd=ROOT,env=env,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=30)
    start_logic()
    return jwt,settings['cliApiToken']


def choose(label, options):
    if not options:raise RuntimeError('No '+label+' found. Connect it, then run Configure Bench again.')
    if len(options)==1:
        print(label+': '+str(options[0]));return options[0]
    for i,option in enumerate(options,1):print(f'{i}. {option}')
    index=int(input('Choose '+label+' number: '))-1
    if not 0<=index<len(options):raise ValueError('Selection out of range')
    return options[index]


def configure_bench():
    from ppk2_api.ppk2_api import PPK2_API
    cfg=config();ports=serial_inventory()
    board=choose('nRF7002 DK VCOM (UART0)',[p for p in ports if p['vid']==0x1366])
    cfg['uart_port']=board['port']
    number=(board['serial'] or '').split('_')[0]
    cfg['board_serial']=str(int(number)) if number.isdigit() else input('DK J-Link numeric serial printed on board: ').strip()
    try:
        start_logic()
        analyzers=[d['id'] for d in logic_devices() if not d['simulation']]
    except Exception:
        analyzers=[]
    cfg['saleae_device_id']=choose('physical Saleae',analyzers) if analyzers else ''
    if not analyzers:print('No physical analyzer: standalone PPK2 measure/hold can still be configured. Full HIL remains blocked.')
    cfg['ppk2_port']=choose('PPK2 data port',PPK2_API.list_devices())
    print('Default: AMPERE mode in series with the prepared P22 VDD measurement rail.')
    print('Follow PHYSICAL-SETUP.md first. Do not connect PPK2 VOUT as a second supply in ampere mode.')
    voltage=int(input('Measured external VDD rail voltage in mV (for example 3000 or 3300): ').strip())
    if not 1700<=voltage<=3600:raise ValueError('Invalid VDD voltage')
    cfg.update(power_mode='ampere',voltage_mV=voltage)
    cfg['power_wiring_verified']=input('PPK2 power rail, polarity, voltage and common ground checked? Type READY: ').strip()=='READY'
    save(ROOT/'bench.local.json',cfg)
    from .power import power_readiness
    print(json.dumps({'power_only':power_readiness(cfg),'full_hil':doctor(cfg)},indent=2))


def seed_loop(jwt):
    # Repeated clicks cannot start overlapping agent runs. The paths and fields
    # of Hapimatic's HTTP API below are its own names and stay as they are.
    agent=config().get('agent','')
    if not agent:raise RuntimeError('Set agent (Hapimatic\'s name for your coding agent) in bench.local.json')
    previous=ROOT/'.state/autopilot.json'
    if previous.exists():
        old=json.loads(previous.read_text())
        active=api('/api/sessions',token=jwt).get('sessions',[])
        if any(s.get('id')==old.get('run_id') and s.get('active') for s in active):
            return old
    machines=api('/api/machines',token=jwt)['machines']
    if len(machines)!=1:raise RuntimeError('Expected one local Hapimatic machine; select the Mac in the web UI')
    save(ROOT/'.state/budget.json',{'attempts':0})
    result=api('/api/machines/'+machines[0]['id']+'/spawn',{
        'directory':str(ROOT),'agent':agent,'sessionType':'simple',
        'permissionMode':'safe-yolo','name':'CRANIUM measured firmware loop'},jwt)
    if result.get('type')!='success':raise RuntimeError('Hapimatic could not start the agent: '+json.dumps(result))
    run_id=result['sessionId']
    api('/api/sessions/'+run_id+'/messages',{'text':(ROOT/'prompts/AUTOPILOT.md').read_text()},jwt)
    state={'run_id':run_id,'url':URL+'/sessions/'+run_id,'seed':'prompts/AUTOPILOT.md'}
    save(previous,state)
    return state


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['open','configure','run','check'],default='open',nargs='?')
    args=parser.parse_args()
    if args.action=='configure':configure_bench();return 0
    jwt,access=services()
    if args.action=='check':
        machines=api('/api/machines',token=jwt)['machines']
        print(json.dumps({'hapimatic_http':200,'online_machines':len(machines),
                          'saleae_devices':logic_devices(),'agent_started':False},indent=2));return 0
    if args.action=='run':
        readiness=doctor(config())
        if not readiness['ready']:
            print('The AI loop is waiting for physical setup:')
            for why in readiness['blocking']:print(' - '+why)
            print('Run Configure Bench.command after following PHYSICAL-SETUP.md.')
            return 2
        loop=seed_loop(jwt);webbrowser.open(loop['url'])
    else:webbrowser.open(URL)
    print('Hapimatic:',URL)
    # The token is not printed: a terminal's scrollback and logs outlive it.
    if shutil.which('pbcopy'):
        subprocess.run(['pbcopy'],input=access.encode(),check=True)
        print('If the browser asks for its access token, paste it: it is on the clipboard.')
    else:
        print('If the browser asks for its access token, it is cliApiToken in '+str(ROOT/'.state/hapi/settings.json'))
    return 0


if __name__=='__main__':raise SystemExit(main())
