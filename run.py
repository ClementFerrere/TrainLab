"""Start the Sport Platform: `.venv\Scripts\python run.py` then open http://127.0.0.1:8765"""
import threading
import webbrowser

import uvicorn

from backend import config

if __name__ == "__main__":
    import sys

    if "--no-browser" not in sys.argv:
        threading.Timer(1.5, lambda: webbrowser.open(config.BASE_URL)).start()
    uvicorn.run("backend.app:app", host=config.HOST, port=config.PORT, log_level="warning")
