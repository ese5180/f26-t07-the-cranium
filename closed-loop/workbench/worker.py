"""Bounded worker for MCP jobs. No agent/model is spawned by this module."""
import datetime as dt
import json
import os
import signal
import subprocess
import sys
import time
from .build import ROOT
from .runner import save


def main():
    key, command, *extra=sys.argv[1:]
    path=ROOT/'.state/jobs'/(key+'.json')
    # Parent writes PID/state while holding the start lock.
    for _ in range(50):
        if path.exists():break
        time.sleep(.02)
    job=json.loads(path.read_text())
    process=subprocess.Popen([sys.executable,'-m','workbench.runner',command,*extra],cwd=ROOT,start_new_session=True)
    try:
        code=process.wait(timeout=900)
        job.update(status='passed' if code==0 else 'failed',exit_code=code)
        if command=='run' and (ROOT/'.state/latest.json').exists():
            result=json.loads((ROOT/'.state/latest.json').read_text())
            job.update(status=result['status'],report=result['report'],hardware_passed=result['hardware_passed'])
        elif command in ('measure','hold') and (ROOT/'.state/latest-power.json').exists():
            result=json.loads((ROOT/'.state/latest-power.json').read_text())
            job.update(status=result['status'],report=result['report'],hardware_passed=False)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid,signal.SIGTERM)
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGKILL);process.wait()
        job.update(status='timed_out',hardware_passed=False)
    finally:
        job['finished_at']=dt.datetime.now(dt.timezone.utc).isoformat()
        save(path,job)


if __name__=='__main__':main()
