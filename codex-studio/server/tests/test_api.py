from pathlib import Path
import sqlite3
import time
import pytest

from fastapi.testclient import TestClient

from app import database
from app.config import settings
from app.main import app
from app.adapters import registry
from app.adapters.base import AIAdapter, MockAdapter
from app.adapters.anthropic import AnthropicAdapter
from app.adapters.openai_compatible import OpenAICompatibleAdapter
from app import media, production
from app.task_runner import TaskRunner


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


def test_anthropic_director_adapter_uses_messages_protocol(monkeypatch):
    class FakeResponse:
        status_code = 200
        is_error = False
        text = ""
        def json(self): return {"content": [{"type": "text", "text": "导演分析结果"}], "usage": {"input_tokens": 9, "output_tokens": 5}}

    class FakeClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def post(self, url, headers, json):
            assert url == "https://api.anthropic.com/v1/messages"
            assert headers["anthropic-version"] == "2023-06-01"
            assert headers["x-api-key"] == "anthropic-secret"
            assert json["messages"][0]["content"] == "分析镜头"
            return FakeResponse()

    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-secret")
    monkeypatch.setenv("AI_STUDIO_ANTHROPIC_MODEL", "claude-test")
    monkeypatch.setattr("app.adapters.anthropic.httpx.AsyncClient", FakeClient)
    result = __import__("asyncio").run(AnthropicAdapter().invoke("分析镜头", {"task_type": "llm"}))
    assert result["result"] == "导演分析结果"
    assert result["model"] == "claude-test"


def test_openai_image_uses_reference_edit_for_story_bible(monkeypatch, tmp_path: Path):
    import base64
    reference = tmp_path / "character.png"
    reference.write_bytes(b"reference-image")
    output_png = base64.b64encode(b"generated-image").decode()

    class FakeResponse:
        status_code = 200
        is_error = False
        text = ""
        def json(self): return {"data": [{"b64_json": output_png}]}

    class FakeClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def post(self, url, headers, data=None, files=None, json=None):
            assert url.endswith("/images/edits")
            assert data["input_fidelity"] == "high"
            assert files and files[0][0] == "image"
            return FakeResponse()

    monkeypatch.setenv("OPENAI_API_KEY", "openai-secret")
    monkeypatch.setattr("app.adapters.openai_compatible.httpx.AsyncClient", FakeClient)
    monkeypatch.setattr("app.adapters.openai_compatible.project_media_dir", lambda _: tmp_path / "media")
    result = __import__("asyncio").run(OpenAICompatibleAdapter("openai").invoke("保持人物一致", {
        "task_type": "image", "project_id": "demo", "shot_id": 1, "reference_paths": [str(reference)], "options": {"input_fidelity": "high"}
    }))
    assert Path(result["output_path"]).read_bytes() == b"generated-image"


def test_vision_review_is_persisted_as_repair_record():
    with sqlite3.connect(settings.database_path) as db:
        cursor = db.execute("INSERT INTO tasks(project_id,task_type,provider,payload_json) VALUES('demo','vision_review','openai',?)", ('{"episode":1,"shot_number":"001","options":{"threshold":85}}',))
        task_id = cursor.lastrowid
        row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        columns = [item[1] for item in db.execute("PRAGMA table_info(tasks)")]
        task = dict(zip(columns, row))
    TaskRunner()._complete(task, {"score": 61, "dimensions": {"character": 55}, "findings": ["脸型漂移"]})
    with sqlite3.connect(settings.database_path) as db:
        review = db.execute("SELECT score,status,repair_plan_json FROM quality_reviews WHERE project_id='demo' ORDER BY id DESC LIMIT 1").fetchone()
    assert review[0] == 61
    assert review[1] == "repair_required"
    assert "regenerate_keyframe" in review[2]


def test_claude_borrowed_architecture_endpoints():
    with TestClient(app) as client:
        assert len(client.get("/api/v1/pipeline/stages").json()) == 6
        assert client.get("/api/v1/providers?capability=r2v").json() == []
        dashscope = next(item for item in client.get("/api/v1/providers").json() if item["id"] == "dashscope")
        assert dashscope["capabilities"] == ["i2v"]
        openai = next(item for item in client.get("/api/v1/providers").json() if item["id"] == "openai")
        assert "i2v" not in openai["capabilities"]
        rejected = client.post("/api/v1/projects/demo/shots/generate", json={"shot_id": 1, "task_type": "video", "provider": "openai", "prompt": "测试"})
        assert rejected.status_code == 422
        assert all(item["id"] not in {"vidu", "kling", "minimax"} for item in client.get("/api/v1/providers").json())
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


def test_automation_start_freezes_bible_and_injects_memory():
    with sqlite3.connect(settings.database_path) as db:
        db.execute("INSERT INTO bible_entities(project_id,entity_type,entity_key,name,state,data_json) VALUES('demo','character','hero','主角','draft',?)", ('{"face":"国字脸","costume":"青衫"}',))
    started = production.start_automation("demo", {"episode": 1, "mode": "balanced", "image_provider": "mock", "video_provider": "mock", "voice_provider": None, "auto_freeze_bible": True, "generate_images": True, "output_name": "automation-test.mp4", "width": 1280, "height": 720})
    run_id = started["id"]
    with sqlite3.connect(settings.database_path) as db:
        assert db.execute("SELECT state FROM bible_entities WHERE entity_key='hero' ORDER BY version DESC LIMIT 1").fetchone()[0] == "frozen"
        payload = db.execute("SELECT payload_json FROM tasks WHERE automation_run_id=? AND stage='keyframes' ORDER BY id LIMIT 1", (run_id,)).fetchone()[0]
    assert "国字脸" in payload
    assert "禁止" not in payload or "强制连续性设定" in payload


@pytest.mark.skipif(not __import__("shutil").which("ffmpeg") or not __import__("shutil").which("ffprobe"), reason="FFmpeg not installed")
def test_one_click_automation_reaches_real_export(tmp_path: Path, monkeypatch):
    import base64
    import subprocess
    import shutil

    video = tmp_path / "generated.mp4"
    subprocess.run([shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=navy:s=320x240:d=0.8:r=24", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.8", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(video)], check=True, timeout=30)
    image = tmp_path / "keyframe.png"
    image.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))

    class FakeProductionAdapter(AIAdapter):
        provider = "fakeprod"
        async def invoke(self, prompt, context):
            kind = context.get("task_type")
            path = image if kind == "image" else video
            asset_type = "image" if kind == "image" else "voice" if kind == "voice" else "video"
            return {"provider": self.provider, "status": "completed", "output_path": str(path), "output_name": path.name, "asset_type": asset_type, "shot_id": context.get("shot_id")}

    registry.register(FakeProductionAdapter())
    monkeypatch.setattr(media, "render_dir", lambda: tmp_path / "renders")
    monkeypatch.setattr(production, "project_media_dir", lambda _: tmp_path / "project-media")
    with sqlite3.connect(settings.database_path) as db:
        db.execute("DELETE FROM shots WHERE project_id='demo' AND number NOT IN ('001','002')")
        db.execute("UPDATE shots SET prompt='电影关键帧',description='人物在雪夜前行',dialogue='继续前进。',duration='0.7s' WHERE project_id='demo'")
    try:
        with TestClient(app) as client:
            response = client.post("/api/v1/projects/demo/automation/start", json={"episode": 1, "image_provider": "fakeprod", "video_provider": "fakeprod", "voice_provider": "fakeprod", "quality_provider": None, "width": 640, "height": 360, "output_name": "一键成片.mp4"})
            assert response.status_code == 202
            run_id = response.json()["id"]
            deadline = time.time() + 20
            run = None
            while time.time() < deadline:
                run = next(item for item in client.get("/api/v1/projects/demo/automation/runs").json() if item["id"] == run_id)
                if run["status"] in {"completed", "failed"}: break
                time.sleep(0.1)
            assert run and run["status"] == "completed", run
            assert Path(run["checkpoint"]["output_path"]).is_file()
            tasks = client.get("/api/v1/projects/demo/tasks").json()
            assert {item["stage"] for item in tasks if item["automation_run_id"] == run_id} == {"keyframes", "videos", "voice", "export"}
    finally:
        registry.register(MockAdapter())


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
        renamed = client.patch(f"/api/v1/projects/{project['id']}", json={"name": "测试长篇·修订", "episode_count": 30}).json()
        assert renamed["name"] == "测试长篇·修订"
        assert renamed["episode_count"] == 30
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


def test_ai_director_atomically_builds_bible_storyboard_and_state_graph():
    director_json = {
        "logline": "沈岚带伤追查失窃的玉佩。",
        "bible": {
            "world": {"name": "现代悬疑世界", "rules": "现实主义"},
            "style": {"name": "冷峻蓝灰", "palette": "蓝灰"},
            "characters": [{"name": "沈岚", "face": "窄脸", "hair": "黑色短发", "body": "高挑", "costume": "黑色风衣"}],
            "locations": [{"name": "雨夜仓库", "layout": "门在西侧，货架南北排列", "lighting": "顶部冷光"}],
            "props": [{"name": "玉佩", "initial_state": "在沈岚手中"}],
        },
        "scenes": [{"index": 1, "heading": "雨夜仓库", "location": "雨夜仓库", "time_of_day": "夜", "summary": "追查"}],
        "shots": [
            {"scene_index": 1, "title": "入场", "description": "沈岚推门", "action": "沈岚推门进入", "duration": 3, "characters": ["沈岚"], "props": ["玉佩"], "link": "new-scene", "state_before": {"characters": {"沈岚": {"costume": "黑色风衣"}}, "props": {"玉佩": "手中"}}, "state_after": {"characters": {"沈岚": {"costume": "黑色风衣"}}, "props": {"玉佩": "手中"}}, "value_score": 82},
            {"scene_index": 1, "title": "转身", "description": "沈岚闻声转身", "action": "沈岚向右转身", "duration": 3, "characters": ["沈岚"], "props": ["玉佩"], "link": "continuous", "state_before": {}, "state_after": {}, "value_score": 70},
        ],
    }

    class FakeDirector(AIAdapter):
        provider = "directorfake"
        async def invoke(self, prompt, context):
            assert "完整生产设计" in prompt
            assert context["temperature"] == 0.15
            return {"provider": self.provider, "model": "director-test", "result": __import__("json").dumps(director_json, ensure_ascii=False)}

    registry.register(FakeDirector())
    with TestClient(app) as client:
        client.put("/api/v1/projects/demo/episodes/1/script", json={"title": "第一集", "source_name": "", "source_text": "雨夜仓库，沈岚推门进入。"})
        response = client.post("/api/v1/projects/demo/episodes/1/director/generate", json={"provider": "directorfake", "replace_existing": True, "freeze_bible": True})
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["shot_count"] == 2
        assert result["bible_count"] == 5
        assert result["blocking_state_conflicts"] == 0
    with sqlite3.connect(settings.database_path) as db:
        assert db.execute("SELECT COUNT(*) FROM bible_entities WHERE project_id='demo' AND state='frozen'").fetchone()[0] == 5
        assert db.execute("SELECT COUNT(*) FROM shot_state_snapshots WHERE project_id='demo'").fetchone()[0] == 2
        second = db.execute("SELECT state_before_json FROM shot_state_snapshots ORDER BY shot_id DESC LIMIT 1").fetchone()[0]
        assert "黑色风衣" in second and "手中" in second
        assert db.execute("SELECT parse_status FROM episode_scripts WHERE project_id='demo' AND episode=1").fetchone()[0] == "director_storyboard"


def test_continuous_video_waits_for_previous_tail_frame(tmp_path: Path, monkeypatch):
    previous_video = tmp_path / "previous.mp4"
    previous_video.write_bytes(b"video")
    tail = tmp_path / "tail.png"
    tail.write_bytes(b"tail")
    with sqlite3.connect(settings.database_path) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute("SELECT id FROM shots WHERE project_id='demo' ORDER BY id LIMIT 2").fetchall()
        first, second = int(rows[0]["id"]), int(rows[1]["id"])
        db.execute("UPDATE shots SET continuity_json=? WHERE id=?", ('{"link":"new-scene"}', first))
        db.execute("UPDATE shots SET continuity_json=? WHERE id=?", ('{"link":"continuous"}', second))
        run_id = db.execute("INSERT INTO automation_runs(project_id,episode,status,stage,config_json) VALUES('demo',1,'running','videos','{}')").lastrowid
        shots = db.execute("SELECT * FROM shots WHERE id IN (?,?) ORDER BY id", (first, second)).fetchall()
        queued = production._queue_video_wave(db, run_id, "demo", shots, {"video_provider": "mock", "width": 1280, "height": 720})
        assert queued == 1
        asset_id = db.execute("INSERT INTO assets(project_id,asset_type,name,episode,shot_id,local_path,status) VALUES('demo','video','previous',1,?,?,'ready')", (first, str(previous_video))).lastrowid
        db.execute("INSERT INTO shot_assets(shot_id,asset_id,role) VALUES(?,?,'video')", (first, asset_id))
        monkeypatch.setattr(production, "extract_boundary_frames", lambda *args: (str(tail), str(tail)))
        queued = production._queue_video_wave(db, run_id, "demo", shots, {"video_provider": "mock", "width": 1280, "height": 720})
        assert queued == 1
        payload = db.execute("SELECT payload_json FROM tasks WHERE automation_run_id=? AND stage='videos' ORDER BY id DESC LIMIT 1", (run_id,)).fetchone()[0]
    decoded = __import__("json").loads(payload)
    assert decoded["reference_paths"] == [str(tail)]
    assert decoded["dependency"]["from_shot_id"] == first


def test_story_state_recomputes_after_edit_and_blocks_production():
    with TestClient(app) as client:
        shots = client.get("/api/v1/projects/demo/shots").json()[:2]
        first, second = shots[0], shots[1]
        first_continuity = {"link": "new-scene", "state_before": {"characters": {"主角": {"costume": "黑衣"}}}, "state_after": {"characters": {"主角": {"costume": "黑衣"}}}}
        second_continuity = {"link": "continuous", "state_before": {"characters": {"主角": {"costume": "白衣"}}}, "state_after": {"characters": {"主角": {"costume": "白衣"}}}}
        assert client.patch(f"/api/v1/shots/{first['id']}", json={"continuity": first_continuity}).status_code == 200
        assert client.patch(f"/api/v1/shots/{second['id']}", json={"continuity": second_continuity}).status_code == 200
        proofread = client.get("/api/v1/projects/demo/proofread").json()
        assert proofread["state_conflicts"] >= 1
        assert any(item["action"] == "fix_story_state" and item["severity"] == "blocking" for item in proofread["findings"])
        blocked = client.post("/api/v1/projects/demo/automation/start", json={"episode": 1, "image_provider": "mock", "video_provider": "mock"})
        assert blocked.status_code == 409
        assert "故事状态图" in blocked.json()["detail"]
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
        assert transition["method"] == "tail_frame_dependency"
        assert "不插入额外桥接时长" in transition["reason"]
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
