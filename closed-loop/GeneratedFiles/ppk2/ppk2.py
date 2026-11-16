#!/usr/bin/env python3
"""CRANIUM counterpart to the professor's PPK2 measure/hold entry point.

Use the project venv:
  .venv/bin/python GeneratedFiles/ppk2/ppk2.py measure 20
  .venv/bin/python GeneratedFiles/ppk2/ppk2.py hold 120

Configured Nordic P22 wiring is required; no board is flashed by this helper.
"""
import argparse
import json
from pathlib import Path
import signal
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from workbench.runner import config
from workbench.power import standalone_power


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['measure','hold'])
    p.add_argument('seconds',type=float,nargs='?')
    args=p.parse_args()
    seconds=args.seconds if args.seconds is not None else 20 if args.action=='measure' else 60
    def interrupted(*args):raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,interrupted)
    result=standalone_power(args.action,seconds,config())
    print(json.dumps(result,indent=2))
    return 0 if result['status'] in ('measurement_recorded','hold_complete') else 2


if __name__=='__main__':raise SystemExit(main())
