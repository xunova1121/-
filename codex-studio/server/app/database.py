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
CREATE TABLE IF NOT EXISTS episode_scripts (
    project_id TEXT NOT NULL, episode INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '',
    source_name TEXT NOT NULL DEFAULT '', source_text TEXT NOT NULL DEFAULT '',
    checksum TEXT NOT NULL DEFAULT '', parse_status TEXT NOT NULL DEFAULT 'draft',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(project_id, episode), FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, episode INTEGER NOT NULL,
    sequence INTEGER NOT NULL, heading TEXT NOT NULL, location TEXT NOT NULL DEFAULT '',
    time_of_day TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
    source_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id), UNIQUE(project_id, episode, sequence)
);
CREATE TABLE IF NOT EXISTS shots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, episode INTEGER NOT NULL DEFAULT 1,
    scene_id INTEGER, sequence INTEGER NOT NULL DEFAULT 0,
    number TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', duration TEXT NOT NULL DEFAULT '3.0s',
    status TEXT NOT NULL DEFAULT '待生成', color TEXT NOT NULL DEFAULT '#1C2027', prompt TEXT NOT NULL DEFAULT '',
    shot_type TEXT NOT NULL DEFAULT '中景', camera TEXT NOT NULL DEFAULT '固定',
    action TEXT NOT NULL DEFAULT '', dialogue TEXT NOT NULL DEFAULT '',
    characters_json TEXT NOT NULL DEFAULT '[]', continuity_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, asset_type TEXT NOT NULL,
    name TEXT NOT NULL, memory_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, task_type TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'mock', status TEXT NOT NULL DEFAULT 'queued', progress INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL DEFAULT '{}', result_json TEXT NOT NULL DEFAULT '{}',
    priority INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
    available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, lease_until TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
    error_message TEXT NOT NULL DEFAULT '', started_at TEXT, completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
CREATE TABLE IF NOT EXISTS provider_configs (
    provider_id TEXT PRIMARY KEY, base_url TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
    secret_blob BLOB, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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


TASK_MIGRATIONS: dict[str, str] = {
    "result_json": "TEXT NOT NULL DEFAULT '{}'",
    "priority": "INTEGER NOT NULL DEFAULT 0",
    "attempts": "INTEGER NOT NULL DEFAULT 0",
    "max_attempts": "INTEGER NOT NULL DEFAULT 3",
    "available_at": "TEXT",
    "lease_until": "TEXT",
    "cancel_requested": "INTEGER NOT NULL DEFAULT 0",
    "error_message": "TEXT NOT NULL DEFAULT ''",
    "started_at": "TEXT",
    "completed_at": "TEXT",
    "updated_at": "TEXT",
}

SHOT_MIGRATIONS: dict[str, str] = {
    "scene_id": "INTEGER",
    "sequence": "INTEGER NOT NULL DEFAULT 0",
    "shot_type": "TEXT NOT NULL DEFAULT '中景'",
    "camera": "TEXT NOT NULL DEFAULT '固定'",
    "action": "TEXT NOT NULL DEFAULT ''",
    "dialogue": "TEXT NOT NULL DEFAULT ''",
    "characters_json": "TEXT NOT NULL DEFAULT '[]'",
    "continuity_json": "TEXT NOT NULL DEFAULT '{}'",
}


def _migrate(connection: sqlite3.Connection) -> None:
    columns = {row[1] for row in connection.execute("PRAGMA table_info(tasks)")}
    for name, definition in TASK_MIGRATIONS.items():
        if name not in columns:
            connection.execute(f"ALTER TABLE tasks ADD COLUMN {name} {definition}")
    connection.execute("UPDATE tasks SET available_at=COALESCE(available_at,created_at,CURRENT_TIMESTAMP), updated_at=COALESCE(updated_at,created_at,CURRENT_TIMESTAMP)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_tasks_dispatch ON tasks(status, available_at, priority DESC, id)")
    shot_columns = {row[1] for row in connection.execute("PRAGMA table_info(shots)")}
    for name, definition in SHOT_MIGRATIONS.items():
        if name not in shot_columns:
            connection.execute(f"ALTER TABLE shots ADD COLUMN {name} {definition}")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_shots_episode ON shots(project_id, episode, sequence, id)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_scenes_episode ON scenes(project_id, episode, sequence)")


def initialize_database(path: Path | None = None) -> None:
    target = path or settings.database_path
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(target) as connection:
        connection.executescript(SCHEMA)
        _migrate(connection)


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(settings.database_path)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()
