#!/bin/sh
cd "$(dirname "$0")" || exit 1
.venv/bin/python -m workbench.launch run
printf '\nPress Enter to close this window.\n'
read -r response
