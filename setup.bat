@echo off
rem Cree l environnement Python local et installe les dependances epinglees.
rem --use-feature=truststore : utilise le magasin de certificats Windows (antivirus qui inspecte le HTTPS).
cd /d "%~dp0"
python -m venv .venv
".venv\Scripts\python.exe" -m pip install --use-feature=truststore --upgrade pip
".venv\Scripts\python.exe" -m pip install --use-feature=truststore -r requirements.txt
