"""Standalone PPK2 measure/hold, following the professor's example workflow.

These operations do not flash firmware and cannot produce a full HIL pass.
"""
import datetime as dt
import fcntl
import math
from pathlib import Path
import time
from .build import ROOT
from .instruments import PowerMeter


def power_readiness(cfg):
    from ppk2_api.ppk2_api import PPK2_API
    reasons=[]
    if cfg.get('power_wiring_verified') is not True:
        reasons.append('Verify the P22 rail, polarity and measured voltage in Configure Bench.command first')
    if cfg.get('ppk2_port') not in PPK2_API.list_devices():
        reasons.append('Connect and select the PPK2 data port')
    if cfg.get('power_mode') not in ('ampere','source') or not 1700 <= cfg.get('voltage_mV',0) <= 3600:
        reasons.append('Select the checked nRF5340 power mode and 1700..3600 mV rail')
    return {'ready':not reasons,'blocking':reasons,'hardware_passed':False}


def validate_duration(action,seconds):
    limit=60 if action=='measure' else 900 if action=='hold' else 0
    if isinstance(seconds,bool) or not isinstance(seconds,(int,float)) or not math.isfinite(seconds) or not 1<=seconds<=limit:
        raise ValueError(f'{action}: duration must be 1..{limit} seconds')


def standalone_power(action,seconds,cfg):
    from .runner import requirements,save,artifact_manifest
    validate_duration(action,seconds)
    state=ROOT/'.state';state.mkdir(mode=0o700,exist_ok=True)
    stamp=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    folder=ROOT/'captures'/('ppk2-'+action+'-'+stamp);folder.mkdir(parents=True)
    report={'id':stamp,'action':action,'seconds':seconds,'status':'running','hardware_passed':False,
            'firmware_identity':'not verified: this command does not build or flash',
            'scope':cfg.get('measurement_scope'),'evidence':str(folder.relative_to(ROOT))}
    with (state/'bench.lock').open('a') as lock:
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another workbench operation owns the rig')
        try:
            readiness=power_readiness(cfg)
            if not readiness['ready']:
                report.update(status='blocked',blocking=readiness['blocking'])
                return report
            with PowerMeter(cfg) as meter:
                if action=='measure':
                    req=requirements();req['power_duration_s']=seconds
                    time.sleep(req['power_settle_s'])
                    report['power']=meter.capture(folder,req)
                    report['status']='measurement_recorded'
                else:
                    print(f'PPK2 path enabled for at most {seconds:g} seconds; Ctrl+C releases it.',flush=True)
                    deadline=time.monotonic()+seconds
                    while time.monotonic()<deadline:
                        time.sleep(min(.5,max(0,deadline-time.monotonic())))
                    report['status']='hold_complete'
            report['output_release_requested']=True
        except KeyboardInterrupt:
            report.update(status='interrupted',error='User interrupted; PPK2 cleanup attempted')
        except Exception as error:
            report.update(status='failed',error=str(error))
        finally:
            report['finished_at']=dt.datetime.now(dt.timezone.utc).isoformat()
            report['artifacts_sha256']=artifact_manifest(folder)
            save(folder/'report.json',report)
            save(state/'latest-power.json',{'report':str(folder/'report.json'),**report})
    return report
