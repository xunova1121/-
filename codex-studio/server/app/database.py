import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .config import settings


SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, genre TEXT NOT NULL DEFAULT '',
    episode_count INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS shots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, episode INTEGER NOT NULL DEFAULT 1,
    number TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', duration TEXT NOT NULL DEFAULT '3.0s',
    status TEXT NOT NULL DEFAULT '待生成', color TEXT NOT NULL DEFAULT '#1C2027', prompt TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, asset_type TEXT NOT NULL,
    name TEXT NOT NULL, memory_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, task_type TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'mock', status TEXT NOT NULL DEFAULT 'queued', progress INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pipeline_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, stage TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', progress INTEGER NOT NULL DEFAULT 0,
    checkpoint_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, stage)
);
CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, capability TEXT NOT NULL,
    status_code INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 0, error_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bible_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
    entity_type TEXT NOT NULL, entity_key TEXT NOT NULL, name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'draft',
    data_json TEXT NOT NULL DEFAULT '{}', reference_assets_json TEXT NOT NULL DEFAULT '[]',
    fingerprint TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, entity_type, entity_key, version)
);
CREATE TABLE IF NOT EXISTS episode_locks (
    project_id TEXT NOT NULL, episode INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft', snapshot_json TEXT NOT NULL DEFAULT '{}',
    locked_at TEXT, PRIMARY KEY(project_id, episode)
);
CREATE TABLE IF NOT EXISTS continuity_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, episode INTEGER NOT NULL,
    from_shot TEXT NOT NULL, to_shot TEXT NOT NULL, relation TEXT NOT NULL DEFAULT 'cut',
    contract_json TEXT NOT NULL DEFAULT '{}', score INTEGER NOT NULL DEFAULT 100,
    findings_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, episode, from_shot, to_shot)
);
CREATE TABLE IF NOT EXISTS quality_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, episode INTEGER NOT NULL,
    shot_number TEXT NOT NULL, score INTEGER NOT NULL, status TEXT NOT NULL,
    dimensions_json TEXT NOT NULL DEFAULT '{}', findings_json TEXT NOT NULL DEFAULT '[]',
    repair_plan_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS scene_layouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, scene_key TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, layout_json TEXT NOT NULL DEFAULT '{}',
    fingerprint TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, scene_key, version)
);
CREATE TABLE IF NOT EXISTS transition_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, episode INTEGER NOT NULL,
    from_shot TEXT NOT NULL, to_shot TEXT NOT NULL, method TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0, plan_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'planned', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, episode, from_shot, to_shot)
);
"""


def initialize_database(path: Path | None = None) -> None:
    target = path or settings.database_path
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(target) as connection:
        connection.executescript(SCHEMA)
        connection.execute("INSERT OR IGNORE INTO projects(id,name,genre,episode_count) VALUES(?,?,?,?)", ("demo", "雪山剑客 第一季", "武侠 / 剧情", 12))
        count = connection.execute("SELECT COUNT(*) FROM shots WHERE project_id='demo'").fetchone()[0]
        if count == 0:
            connection.executemany(
                "INSERT INTO shots(project_id,episode,number,title,description,duration,status,color) VALUES(?,?,?,?,?,?,?,?)",
                [("demo", 1, f"{i:03}", title, desc, duration, status, color) for i, title, desc, duration, status, color in [
                    (1, "远景｜固定", "雪山全景，风雪飘扬", "3.2s", "已生成", "#1C2027"),
                    (2, "中景｜推镜", "李狗蛋出现，步履坚定", "2.8s", "已生成", "#1C2027"),
                    (3, "特写｜固定", "人物面部与情绪特写", "2.6s", "已生成", "#1C2027"),
                    (4, "大全景｜平移", "古寺大门，灯火摇曳", "2.4s", "生成中 65%", "#252019"),
                    (5, "中景｜跟随", "李狗蛋进入古寺", "1.8s", "待生成", "#1C2027"),
                    (6, "近景｜固定", "黑衣人出现，深邃", "1.8s", "待生成", "#1C2027")]])


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(settings.database_path)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()
