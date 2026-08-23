from pathlib import Path
import sqlite3
import time

from fastapi.testclient import TestClient

from app import database
from app.config import settings
from app.main import app


def wait_for_status(client: TestClient, project_id: str, task_id: int, expected: set[str], timeout: float = 4) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        task = next(item for item in client.get(f"/api/v1/projects/{project_id}/tasks").json() if item["id"] == task_id)
        if task["status"] in expected:
            return task
        time.sleep(0.05)
    raise AssertionError(f"task {task_id} did not reach {expected}")


def test_health_and_demo_data(tmp_path: Path):
    original = settings.database_path
    object.__setattr__(settings, "database_path", tmp_path / "test.db")
    try:
        with TestClient(app) as client:
            assert client.get("/api/v1/health").json()["status"] == "ok"
            shots = client.get("/api/v1/projects/demo/shots").json()
            assert len(shots) == 6
            assert shots[0]["number"] == "001"
    finally:
        object.__setattr__(settings, "database_path", original)


def test_gateway_mock():
    with TestClient(app) as client:
        response = client.post("/api/v1/gateway/llm", json={"prompt": "分析剧本", "provider": "mock"})
        assert response.status_code == 200
        assert response.json()["status"] == "completed"


def test_claude_borrowed_architecture_endpoints():
    with TestClient(app) as client:
        assert len(client.get("/api/v1/pipeline/stages").json()) == 6
        assert any(item["id"] == "vidu" for item in client.get("/api/v1/providers?capability=r2v").json())
        result = client.post("/api/v1/continuity/analyze", json={
            "previous": {"scene": "古寺", "screen_direction": "right", "lighting": "night"},
            "current": {"scene": "古寺大殿", "screen_direction": "left", "lighting": "day"},
        }).json()
        assert result["link"] == "cut"
        assert len(result["findings"]) == 2


def test_pipeline_checkpoint():
    with TestClient(app) as client:
        saved = client.put("/api/v1/projects/demo/pipeline/images", json={"status": "paused", "progress": 42, "checkpoint": {"last_shot": "006"}})
        assert saved.status_code == 200
        stages = client.get("/api/v1/projects/demo/pipeline").json()
        images = next(item for item in stages if item["id"] == "images")
        assert images["progress"] == 42
        assert images["checkpoint"]["last_shot"] == "006"


def test_project_shot_task_crud_and_preflight():
    with TestClient(app) as client:
        project = client.post("/api/v1/projects", json={"name": "测试长篇", "genre": "科幻", "episode_count": 24}).json()
        shot = client.post(f"/api/v1/projects/{project['id']}/shots", json={"number": "001", "title": "开场"}).json()
        assert client.patch(f"/api/v1/shots/{shot['id']}", json={"description": "城市夜景"}).status_code == 200
        assert client.post(f"/api/v1/projects/{project['id']}/tasks", json={"task_type": "image", "payload": {"shot": "001"}}).status_code == 202
        assert len(client.get(f"/api/v1/projects/{project['id']}/tasks").json()) == 1
        checks = client.post("/api/v1/preflight", json={"checks": ["database", "routes"]}).json()
        assert all(item["status"] == "pass" for item in checks)
        assert client.delete(f"/api/v1/projects/{project['id']}").status_code == 204


def test_story_bible_episode_lock_and_quality_repair():
    with TestClient(app) as client:
        entity = client.post("/api/v1/projects/demo/bible", json={
            "entity_type": "character", "entity_key": "li-goudan", "name": "李狗蛋",
            "state": "frozen", "data": {"face": "国字脸", "costume": "青衫"}, "reference_assets": ["asset://li/front"]
        }).json()
        assert len(entity["fingerprint"]) == 64
        contract = client.put("/api/v1/projects/demo/continuity-contracts", json={
            "episode": 1, "from_shot": "005", "to_shot": "006", "relation": "continuous",
            "action_state": {"end_pose": "斧头脱手", "next_start_pose": "斧头下落"},
            "prop_state": {"before": "握在右手", "after": "空中", "change_reason": "脱手"},
            "camera_state": {"from_direction": "right", "to_direction": "right"}
        }).json()
        assert contract["score"] == 100
        lock = client.post("/api/v1/projects/demo/episode-locks", json={"episode": 1}).json()
        assert lock["status"] == "locked"
        review = client.post("/api/v1/projects/demo/quality-reviews", json={
            "episode": 1, "shot_number": "006", "dimensions": {"character": 94, "scene": 90, "prop": 96, "motion": 58, "lighting": 88, "image": 85, "audio": 91}
        }).json()
        assert review["status"] == "repair_required"
        assert review["repair_plan"]["actions"][0]["action"] == "regenerate_video"


def test_previz_transition_and_episode_automation():
    with TestClient(app) as client:
        layout = {
            "scene_key": "temple", "camera": {"position": {"x": 0, "y": -5}, "target": {"x": 0, "y": 0}, "lens_mm": 35},
            "subjects": [{"entity_key": "li-goudan", "position": {"x": 0, "y": 0}, "facing_deg": 180}],
            "landmarks": [{"name": "古寺大门", "position": {"x": 3, "y": 2}}, {"name": "雪山", "far_bearing_deg": -30}],
            "sun_bearing_deg": -45, "sun_elevation": "low"
        }
        previz = client.post("/api/v1/projects/demo/previz/layouts", json=layout).json()
        assert previz["analysis"]["subjects"][0]["visible"] is True
        transition = client.post("/api/v1/projects/demo/transition-plans", json={
            "episode": 1,
            "left": {"shot_number": "005", "scene_key": "temple", "action": "斧头脱手", "action_phase": "middle", "screen_direction": "right", "lighting": "night"},
            "right": {"shot_number": "006", "scene_key": "temple", "action": "斧头下落", "action_phase": "middle", "screen_direction": "right", "lighting": "night"},
            "narrative_relation": "same_action", "preferred_engine": "auto", "target_fps": 24
        }).json()
        assert transition["method"] == "vace_context_bridge"
        assert transition["parameters"]["context_frames_each_side"] % 4 == 0
        assert transition["parameters"]["generated_bridge_frames"] % 4 == 1
        plan = client.post("/api/v1/projects/demo/automation/plan", json={"episode": 1, "mode": "quality"}).json()
        assert len(plan["stages"]) == 8
        assert next(stage for stage in plan["stages"] if stage["id"] == "seams")["items"] == 5


def test_durable_task_completion_failure_retry_and_stats(tmp_path: Path):
    original = settings.database_path
    object.__setattr__(settings, "database_path", tmp_path / "tasks.db")
    try:
        with TestClient(app) as client:
            completed_id = client.post("/api/v1/projects/demo/tasks", json={
                "task_type": "video", "provider": "mock", "priority": 20,
                "payload": {"prompt": "生成连续动作镜头"}
            }).json()["id"]
            completed = wait_for_status(client, "demo", completed_id, {"completed"})
            assert completed["progress"] == 100
            assert completed["attempts"] == 1
            assert completed["result"]["status"] == "completed"

            failed_id = client.post("/api/v1/projects/demo/tasks", json={
                "task_type": "image", "provider": "not-configured", "max_attempts": 1
            }).json()["id"]
            failed = wait_for_status(client, "demo", failed_id, {"failed"})
            assert "not configured" in failed["error_message"]
            retried = client.post(f"/api/v1/tasks/{failed_id}/retry")
            assert retried.status_code == 202
            assert wait_for_status(client, "demo", failed_id, {"failed"})["attempts"] == 1

            stats = client.get("/api/v1/tasks/stats").json()
            assert stats["total"] == 2
            assert stats["by_status"]["completed"] == 1
            assert stats["by_status"]["failed"] == 1
    finally:
        object.__setattr__(settings, "database_path", original)


def test_task_schema_migrates_and_recovers_expired_lease(tmp_path: Path):
    path = tmp_path / "legacy.db"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id TEXT, task_type TEXT, provider TEXT, status TEXT, progress INTEGER, payload_json TEXT, created_at TEXT)")
        db.execute("INSERT INTO tasks VALUES(1,'demo','video','mock','running',25,'{}',CURRENT_TIMESTAMP)")
    database.initialize_database(path)
    columns = {row[1] for row in sqlite3.connect(path).execute("PRAGMA table_info(tasks)")}
    assert {"lease_until", "attempts", "result_json", "updated_at"}.issubset(columns)

    original = settings.database_path
    object.__setattr__(settings, "database_path", path)
    try:
        with TestClient(app) as client:
            recovered = wait_for_status(client, "demo", 1, {"completed"})
            assert recovered["attempts"] == 1
    finally:
        object.__setattr__(settings, "database_path", original)
