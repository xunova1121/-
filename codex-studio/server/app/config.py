from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    app_name: str = "AI影视Studio Local Service"
    api_prefix: str = "/api/v1"
    database_path: Path = Path(__file__).resolve().parent.parent / "data" / "studio.db"


settings = Settings()

