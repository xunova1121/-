from pathlib import Path
import sqlite3
import time
import pytest

from fastapi.testclient import TestClient

from app import database
from app.config import settings
from app.main import app


@pytest.fixture(autouse=True)
def isolated_test_database(tmp_path: Path):
    """Tests may use a sample project, but production startup never seeds one."""
    original = settings.database_path
    path = tmp_path / "isolated.db"
    object.__setattr__(settings, "database_path", path)
    database.initialize_database(path)
    with sqlite3.connect(path) as db:
        db.execute("INSERT INTO projects(id,name,genre,episode_count) VALUES('demo','自动化测试项目','测试',1)")
        db.executemany(
            "INSERT INTO shots(project_id,episode,number,title,description,duration,status,color) VALUES('demo',1,?,?,?,?,?,?)",
            [(f"{i:03}", f"测试镜头 {i}", "", "3.0s", "已生成", "#1C2027") for i in range(1, 7)],
        )
    try:
        yield
    finally:
        object.__setattr__(settings, "database_path", original)


def wait_for_status(client: TestClient, project_id: str, task_id: int, expected: set[str], timeout: float = 4) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        task = next(item for item in client.get(f"/api/v1/projects/{project_id}/tasks").json() if item["id"] == task_id)
        if task["status"] in expected:
            return task
        time.sleep(0.05)
    raise AssertionError(f"task {task_id} did not reach {expected}")


def test_health_starts_without_seeded_demo_and_creates_real_project(tmp_path: Path):
    original = settings.database_path
    object.__setattr__(settings, "database_path", tmp_path / "test.db")
    try:
        with TestClient(app) as client:
            assert client.get("/api/v1/health").json()["status"] == "ok"
            assert client.get("/api/v1/projects").json() == []
            project = client.post("/api/v1/projects", json={"name": "真实项目", "genre": "悬疑", "episode_count": 8}).json()
            assert project["id"] != "demo"
            assert client.get(f"/api/v1/projects/{project['id']}/shots").json() == []
    finally:
        object.__setattr__(settings, "database_path", original)


def test_gateway_mock():
    with TestClient(app) as client:
        response = client.post("/api/v1/gateway/llm", json={"prompt": "分析剧本", "provider": "mock"})
        assert response.status_code == 200
        assert response.json()["status"] == "completed"


def test_real_openai_compatible_gateway_uses_configured_model(monkeypatch, tmp_path: Path):
    class FakeResponse:
        status_code = 200
        def raise_for_status(self): return None
        def json(self): return {"choices": [{"message": {"content": "真实适配器返回"}}], "usage": {"total_tokens": 12}}

    class FakeClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def post(self, url, headers, json):
            assert url == "https://gateway.example/v1/chat/completions"
            assert headers["Authorization"] == "Bearer secret-for-test"
            assert json["model"] == "production-model"
            return FakeResponse()

    original = settings.database_path
    object.__setattr__(settings, "database_path", tmp_path / "provider.db")
    monkeypatch.setenv("OPENAI_API_KEY", "secret-for-test")
    monkeypatch.setenv("AI_STUDIO_OPENAI_BASE_URL", "https://gateway.example/v1")
    monkeypatch.setenv("AI_STUDIO_OPENAI_MODEL", "production-model")
    monkeypatch.setattr("app.adapters.openai_compatible.httpx.AsyncClient", FakeClient)
    try:
        with TestClient(app) as client:
            status = next(item for item in client.get("/api/v1/provider-configs").json() if item["provider_id"] == "openai")
            assert status["configured"] is True
            assert "secret" not in str(status)
            result = client.post("/api/v1/gateway/llm", json={"provider": "openai", "prompt": "生成分镜"})
            assert result.status_code == 200
            assert result.json()["result"] == "真实适配器返回"
    finally:
        object.__setattr__(settings, "database_path", original)


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


def test_proofread_is_computed_from_project_shots():
    with sqlite3.connect(settings.database_path) as db:
        db.execute("UPDATE shots SET scene_id=1,continuity_json=? WHERE project_id='demo' AND number='001'", ('{"screen_direction":"right","lighting":"night"}',))
        db.execute("UPDATE shots SET scene_id=1,continuity_json=? WHERE project_id='demo' AND number='002'", ('{"screen_direction":"left","lighting":"day"}',))
    with TestClient(app) as client:
        result = client.get("/api/v1/projects/demo/proofread").json()
        assert result["shot_count"] == 6
        assert result["score"] < 100
        assert {item["action"] for item in result["findings"]} == {"adjust_axis", "adjust_lighting"}


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


def test_real_script_parse_storyboard_edit_and_persistence(tmp_path: Path):
    original = settings.database_path
    object.__setattr__(settings, "database_path", tmp_path / "story.db")
    script = """第1场 木屋外—雪夜
李狗蛋抡起劈柴斧劈向木桩，木桩裂开一道缝。
李狗蛋：谁在那里？

第2场 古寺大门—深夜
黑衣人从门后出现，缓慢拔刀。
黑衣人：你终于来了。
"""
    try:
        with TestClient(app) as client:
            project = client.post("/api/v1/projects", json={"name": "雪夜杀局", "genre": "武侠", "episode_count": 2}).json()
            project_id = project["id"]
            saved = client.put(f"/api/v1/projects/{project_id}/episodes/1/script", json={
                "title": "第一集", "source_name": "雪夜杀局.txt", "source_text": script,
            })
            assert saved.status_code == 200
            parsed = client.post(f"/api/v1/projects/{project_id}/episodes/1/script/parse").json()
            assert parsed["scene_count"] == 2
            assert parsed["characters"] == ["李狗蛋", "黑衣人"]
            generated = client.post(f"/api/v1/projects/{project_id}/episodes/1/storyboard/generate", json={"replace_existing": True}).json()
            assert generated["shot_count"] == 4
            summary = client.get(f"/api/v1/projects/{project_id}/summary").json()
            assert summary == {"scripts": 1, "scenes": 2, "shots": 4, "characters": 2, "locations": 2, "props": 0}
            shots = client.get(f"/api/v1/projects/{project_id}/shots").json()
            assert shots[0]["scene_id"] is not None
            assert shots[0]["action"].startswith("李狗蛋抡起")
            assert shots[1]["dialogue"] == "谁在那里？"
            assert "李狗蛋" in shots[1]["characters"]
            assert client.patch(f"/api/v1/shots/{shots[0]['id']}", json={"shot_type": "近景", "duration": "4.5s"}).status_code == 200

        # A fresh application lifespan must read the same SQLite state.
        with TestClient(app) as reopened:
            stored_script = reopened.get(f"/api/v1/projects/{project_id}/episodes/1/script").json()
            stored_shots = reopened.get(f"/api/v1/projects/{project_id}/shots").json()
            assert stored_script["source_text"] == script
            assert stored_script["parse_status"] == "storyboard"
            assert stored_shots[0]["shot_type"] == "近景"
            assert stored_shots[0]["duration"] == "4.5s"
    finally:
        object.__setattr__(settings, "database_path", original)


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
            project_id = client.post("/api/v1/projects", json={"name": "任务测试", "episode_count": 1}).json()["id"]
            completed_id = client.post(f"/api/v1/projects/{project_id}/tasks", json={
                "task_type": "video", "provider": "mock", "priority": 20,
                "payload": {"prompt": "生成连续动作镜头"}
            }).json()["id"]
            completed = wait_for_status(client, project_id, completed_id, {"completed"})
            assert completed["progress"] == 100
            assert completed["attempts"] == 1
            assert completed["result"]["status"] == "completed"

            failed_id = client.post(f"/api/v1/projects/{project_id}/tasks", json={
                "task_type": "image", "provider": "not-configured", "max_attempts": 1
            }).json()["id"]
            failed = wait_for_status(client, project_id, failed_id, {"failed"})
            assert "not configured" in failed["error_message"]
            retried = client.post(f"/api/v1/tasks/{failed_id}/retry")
            assert retried.status_code == 202
            assert wait_for_status(client, project_id, failed_id, {"failed"})["attempts"] == 1

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
