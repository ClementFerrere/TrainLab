@echo off
rem Lance TrainLab sur le jeu de donnees synthetique (http://127.0.0.1:8766)
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" call setup.bat
if not exist "data\demo.db" ".venv\Scripts\python.exe" scripts\demo_data.py
set SPORT_DEMO=1
set SPORT_PORT=8766
".venv\Scripts\python.exe" run.py
pause
