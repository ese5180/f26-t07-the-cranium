#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  sdk_python=/opt/nordic/ncs/toolchains/ccc010f809/opt/python@3.12/bin/python3.12
  if [ -n "${CRANIUM_PYTHON:-}" ]; then python_bin=$CRANIUM_PYTHON
  elif [ -x "$sdk_python" ]; then python_bin=$sdk_python
  else python_bin=python3
  fi
  "$python_bin" -c 'import sys; assert sys.version_info >= (3,11), "Install Python 3.11+ or set CRANIUM_PYTHON"'
  "$python_bin" -m venv .venv
fi
.venv/bin/python -m pip install -r requirements.txt
exec .venv/bin/python -m workbench.setup
