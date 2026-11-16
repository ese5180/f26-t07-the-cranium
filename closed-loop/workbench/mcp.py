"""Small stdio MCP adapter; fixed project tools, no arbitrary shell execution.

Long operations return a job ID immediately, so agent transports cannot time
out midway through a real capture. Jobs retain their output after disconnect.
"""
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid
from .build import ROOT
from .runner import config, doctor, save, requirements
from .power import power_readiness,validate_duration

TOOLS = [
    ('cranium_doctor','Discover selected DK, Saleae and PPK2; read-only, never supplies power.',{}),
    ('cranium_start_run','Start one real build/flash/Saleae/PPK2 before-after experiment. Requires verified bench wiring; max three runs per AI loop.',{}),
    ('cranium_start_build','Build both Nordic cores for one profile; does not flash.',{'profile':{'type':'string','enum':['baseline','optimized']}}),
    ('cranium_test','Run host contract and evidence-validator tests; returns a job ID, never a HIL pass.',{}),
    ('cranium_job_status','Read a job state and a bounded output tail. Poll at most once every 10 seconds.',{'job_id':{'type':'string','pattern':'^[a-f0-9]{32}$'}}),
    ('cranium_latest','Read the last measured experiment report, including failures or missing hardware.',{}),
    ('cranium_start_power','Standalone PPK2 measure/hold; does not flash, needs no Saleae, never a full HIL pass.',
      {'action':{'type':'string','enum':['measure','hold']},'seconds':{'type':'number','minimum':1,'maximum':900}})
]


def start_job(command, profile=None,seconds=None):
    import fcntl
    state=ROOT/'.state';state.mkdir(mode=0o700,exist_ok=True)
    with (state/'jobs.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        jobs=state/'jobs';jobs.mkdir(exist_ok=True)
        for path in jobs.glob('*.json'):
            job=json.loads(path.read_text())
            if job['status']=='running':
                try:os.kill(job['pid'],0)
                except ProcessLookupError:
                    job['status']='interrupted';save(path,job)
                else:raise RuntimeError('Another workbench job is already running: '+job['id'])
        if command in ('run','measure','hold'):
            check=doctor(config()) if command=='run' else power_readiness(config())
            if not check['ready']:return {'status':'blocked','blocking':check['blocking'],'hardware_passed':False}
            budget_path=state/'budget.json'
            budget=json.loads(budget_path.read_text()) if budget_path.exists() else {'attempts':0}
            if budget['attempts']>=requirements()['max_ai_attempts']:
                return {'status':'blocked','blocking':['Three-attempt budget used; stop and report to the user'],'hardware_passed':False}
            budget['attempts']+=1;save(budget_path,budget)
        job_id=uuid.uuid4().hex
        log=jobs/(job_id+'.log')
        args=[sys.executable,'-m','workbench.worker',job_id,command]
        if profile:args+=['--profile',profile]
        if seconds is not None:args+=['--seconds',str(seconds)]
        with log.open('wb') as output:
            process=subprocess.Popen(args,cwd=ROOT,stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
        job={'id':job_id,'pid':process.pid,'status':'running','command':command,'profile':profile,
             'started_at':dt.datetime.now(dt.timezone.utc).isoformat(),'log':str(log)}
        save(jobs/(job_id+'.json'),job)
        return job


def call(name,args):
    if name=='cranium_doctor':return doctor(config())
    if name=='cranium_start_run':return start_job('run')
    if name=='cranium_start_build':
        if args.get('profile') not in ('baseline','optimized'):raise ValueError('Invalid profile')
        return start_job('build',args['profile'])
    if name=='cranium_test':return start_job('test')
    if name=='cranium_start_power':
        action,seconds=args.get('action'),args.get('seconds')
        validate_duration(action,seconds)
        return start_job(action,seconds=seconds)
    if name=='cranium_latest':
        path=ROOT/'.state/latest.json'
        return json.loads(path.read_text()) if path.exists() else {'status':'not_run','hardware_passed':False}
    if name=='cranium_job_status':
        key=args.get('job_id','')
        if not re.fullmatch('[a-f0-9]{32}',key):raise ValueError('Invalid job ID')
        path=ROOT/'.state/jobs'/(key+'.json')
        job=json.loads(path.read_text())
        log=Path(job['log'])
        job['output_tail']=log.read_text(errors='replace')[-5000:] if log.exists() else ''
        return job
    raise ValueError('Unknown tool')


def dispatch(request):
    method=request.get('method')
    if method=='initialize':
        return {'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'cranium-bench','version':'1.0.0'}}
    if method in ('ping','notifications/initialized'):return {}
    if method=='tools/list':
        return {'tools':[{'name':name,'description':desc,'inputSchema':{'type':'object','properties':props,
                         'required':list(props),'additionalProperties':False}} for name,desc,props in TOOLS]}
    if method=='tools/call':
        try:
            params=request['params'];result=call(params['name'],params.get('arguments',{}))
            return {'content':[{'type':'text','text':json.dumps(result,indent=2)}],'isError':False}
        except Exception as error:
            return {'content':[{'type':'text','text':str(error)}],'isError':True}
    if method=='resources/list':return {'resources':[]}
    if method=='prompts/list':return {'prompts':[]}
    raise ValueError('Unsupported method')


def main():
    os.chdir(ROOT)
    for line in sys.stdin:
        if len(line)>1048576:continue
        request={}
        try:
            request=json.loads(line)
            if 'id' not in request:continue
            response={'jsonrpc':'2.0','id':request['id'],'result':dispatch(request)}
        except Exception as error:
            response={'jsonrpc':'2.0','id':request.get('id'),'error':{'code':-32603,'message':str(error)}}
        print(json.dumps(response),flush=True)


if __name__=='__main__':main()
