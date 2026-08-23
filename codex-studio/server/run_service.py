import os
import sys
from pathlib import Path

import uvicorn
from app.main import app as studio_app


def prepare_headless_streams() -> None:
    """PyInstaller windowed mode sets stdout/stderr to None on Windows."""
    if sys.stdout is not None and sys.stderr is not None:
        return
    log_dir = Path(os.getenv("LOCALAPPDATA", Path.home())) / "AI-Film-Studio" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    if sys.stdout is None:
        sys.stdout = open(log_dir / "service-stdout.log", "a", encoding="utf-8", buffering=1)
    if sys.stderr is None:
        sys.stderr = open(log_dir / "service-stderr.log", "a", encoding="utf-8", buffering=1)

if __name__ == "__main__":
    prepare_headless_streams()
    uvicorn.run(
        studio_app,
        host="127.0.0.1",
        port=18118,
        log_config=None,
        access_log=False,
    )
