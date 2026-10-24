@echo off
rem Lance TrainLab avec tes vraies donnees (http://127.0.0.1:8765)
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" call setup.bat
".venv\Scripts\python.exe" run.py
pause
