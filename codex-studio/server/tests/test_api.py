from pathlib import Path

from fastapi.testclient import TestClient

from app import database
from app.config import settings
from app.main import app


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
