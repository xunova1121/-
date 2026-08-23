import os
import shutil
import subprocess
import time
from pathlib import Path

from .config import settings
from .providers import CAPABILITIES, PROVIDERS


def locate_ffmpeg() -> str | None:
    configured = os.getenv("AI_STUDIO_FFMPEG", "").strip()
    candidates = [configured, str(Path(os.getenv("APPDATA", "")) / "AI-Film-Studio" / "bin" / "ffmpeg.exe"), shutil.which("ffmpeg") or ""]
    return next((item for item in candidates if item and Path(item).exists()), None)


def run_preflight(checks: list[str]) -> list[dict]:
    results: list[dict] = []
    started = time.perf_counter()
    if "database" in checks:
        ok = settings.database_path.parent.exists()
        results.append({"id": "database", "status": "pass" if ok else "fail", "message": str(settings.database_path)})
    if "ffmpeg" in checks:
        binary = locate_ffmpeg()
        if not binary:
            results.append({"id": "ffmpeg", "status": "skip", "message": "未找到 FFmpeg；生成视频前需安装"})
        else:
            completed = subprocess.run([binary, "-version"], capture_output=True, text=True, timeout=5, check=False)
            results.append({"id": "ffmpeg", "status": "pass" if completed.returncode == 0 else "fail", "message": binary})
    if "routes" in checks:
        provider_ids = {provider.id for provider in PROVIDERS}
        results.append({"id": "routes", "status": "pass" if "mock" in provider_ids and CAPABILITIES else "fail", "message": f"{len(provider_ids)} 个服务商 / {len(CAPABILITIES)} 类能力"})
    elapsed = int((time.perf_counter() - started) * 1000)
    return [{**item, "latency_ms": elapsed} for item in results]

