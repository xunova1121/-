import asyncio
import json
from pathlib import Path

import httpx

from app import database
from app.adapters.metaso import MetasoVideoAdapter
from app.config import settings


def test_metaso_h3_submit_poll_download_and_reference_frames(monkeypatch, tmp_path: Path):
    original = settings.database_path
    object.__setattr__(settings, "database_path", tmp_path / "metaso.db")
    database.initialize_database(settings.database_path)
    monkeypatch.setenv("METASO_API_KEY", "metaso-test-secret")
    monkeypatch.setenv("AI_STUDIO_METASO_BASE_URL", "https://metaso.example/api/minimax/v2")
    first = tmp_path / "first.png"
    last = tmp_path / "last.png"
    reference = tmp_path / "character.jpg"
    first.write_bytes(b"first-frame")
    last.write_bytes(b"last-frame")
    reference.write_bytes(b"character-reference")
    polls = 0
    submitted: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal polls, submitted
        if request.url.host == "metaso.example":
            assert request.headers["Authorization"] == "Bearer metaso-test-secret"
        if request.method == "POST":
            submitted = json.loads(request.content)
            return httpx.Response(200, json={"task": {"task_id": "h3-provider-42", "status": "submitted"}})
        if request.url.path.endswith("/query/video_generation/h3-provider-42"):
            polls += 1
            if polls == 1:
                return httpx.Response(200, json={"task": {"status": "processing"}})
            return httpx.Response(200, json={"task": {"status": "completed", "video_url": "https://files.example/generated.mp4"}})
        if request.url.host == "files.example":
            assert "Authorization" not in request.headers
            return httpx.Response(200, headers={"content-type": "video/mp4"}, content=b"real-video-bytes")
        return httpx.Response(404)

    adapter = MetasoVideoAdapter(
        transport=httpx.MockTransport(handler), poll_interval=0, poll_timeout=2, output_root=tmp_path / "downloads"
    )
    try:
        result = asyncio.run(adapter.invoke("雪夜中主角缓慢推门，保持人物身份", {
            "task_type": "video", "task_id": 77,
            "first_frame": str(first), "last_frame": str(last), "reference_images": [str(reference)],
            "duration_seconds": 10, "resolution": "2K", "aspect_ratio": "16:9",
        }))
    finally:
        object.__setattr__(settings, "database_path", original)

    assert submitted["model"] == "MiniMax-H3"
    assert submitted["duration"] == 10 and submitted["resolution"] == "2K" and submitted["aspect_ratio"] == "16:9"
    assert submitted["content"][0]["text"].startswith("雪夜")
    assert len([item for item in submitted["content"] if item["type"] == "image_url"]) == 2
    assert submitted["last_frame_image"].startswith("data:image/png;base64,")
    assert result["provider_task_id"] == "h3-provider-42"
    assert Path(result["output_path"]).read_bytes() == b"real-video-bytes"


def test_metaso_surfaces_http_200_api_error_without_leaking_key(monkeypatch, tmp_path: Path):
    original = settings.database_path
    object.__setattr__(settings, "database_path", tmp_path / "metaso-error.db")
    database.initialize_database(settings.database_path)
    monkeypatch.setenv("METASO_API_KEY", "never-expose-this")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"type": "error", "error": {"message": "quota exhausted"}})

    adapter = MetasoVideoAdapter(transport=httpx.MockTransport(handler), poll_interval=0, output_root=tmp_path)
    try:
        try:
            asyncio.run(adapter.invoke("生成视频", {"task_type": "video", "task_id": 1}))
            raise AssertionError("expected provider error")
        except RuntimeError as exc:
            assert "quota exhausted" in str(exc)
            assert "never-expose-this" not in str(exc)
    finally:
        object.__setattr__(settings, "database_path", original)
