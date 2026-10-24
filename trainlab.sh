#!/usr/bin/env sh
# Start TrainLab (macOS / Linux). Usage: ./trainlab.sh [--demo]
set -e
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || ./setup.sh
if [ "$1" = "--demo" ]; then
  [ -f data/demo.db ] || .venv/bin/python scripts/demo_data.py
  export SPORT_DEMO=1 SPORT_PORT=8766
fi
exec .venv/bin/python run.py
