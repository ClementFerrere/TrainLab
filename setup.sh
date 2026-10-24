#!/usr/bin/env sh
# Create the local Python environment and install the pinned dependencies (macOS / Linux).
set -e
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
"$PY" -c "import sys; assert sys.version_info >= (3, 11), \"Python 3.11+ required\""
"$PY" -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install --use-feature=truststore -r requirements.txt
echo "OK. Lance ./trainlab.sh (ou ./trainlab.sh --demo pour la démo)."
