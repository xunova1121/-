from dataclasses import dataclass
import os
import sys
from pathlib import Path


def app_data_dir() -> Path:
    if getattr(sys, "frozen", False):
        base = Path(os.getenv("LOCALAPPDATA") or Path.home())
        return base / "AI-Film-Studio"
    return Path(__file__).resolve().parent.parent / "data"


@dataclass(frozen=True)
class Settings:
    app_name: str = "AI影视Studio Local Service"
    api_prefix: str = "/api/v1"
    database_path: Path = app_data_dir() / "studio.db"


settings = Settings()
