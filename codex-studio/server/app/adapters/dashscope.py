from __future__ import annotations

import asyncio
import base64
import mimetypes
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

from ..config import project_media_dir
from ..provider_config import resolve_provider_config
from .base import AIAdapter


class DashScopeAdapter(AIAdapter):
    provider = "dashscope"

    async def invoke(self, prompt: str, context: dict[str, Any]) -> dict[str, Any]:
        if str(context.get("task_type")) != "video":
            raise RuntimeError("阿里云百炼适配器当前用于万相视频生成；其他能力请选择相应提供方")
        config = resolve_provider_config(self.provider, "i2v")
        if not config.api_key:
            raise RuntimeError("阿里云百炼尚未配置 API 密钥")
        options = dict(context.get("options") or {})
        references = list(context.get("reference_paths") or [])
        model = str(context.get("model") or options.get("model") or ("wan2.7-i2v-2026-04-25" if references else "wan2.7-t2v-2026-06-12"))
        input_data: dict[str, Any] = {"prompt": prompt}
        if options.get("negative_prompt"):
            input_data["negative_prompt"] = options["negative_prompt"]
        if references:
            media = []
            for index, path in enumerate(references[:2]):
                media.append({"type": "first_frame" if index == 0 else "last_frame", "url": self._data_url(path)})
            input_data["media"] = media
        body = {
            "model": model,
            "input": input_data,
            "parameters": {
                "resolution": options.get("resolution", "720P"), "duration": int(options.get("duration", 5)),
                "prompt_extend": bool(options.get("prompt_extend", True)), "watermark": bool(options.get("watermark", False)),
            },
        }
        base = config.base_url.rstrip("/")
        endpoint = f"{base}/services/aigc/video-generation/video-synthesis"
        headers = {"Authorization": f"Bearer {config.api_key}", "Content-Type": "application/json", "X-DashScope-Async": "enable"}
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=30.0)) as client:
            created = await client.post(endpoint, headers=headers, json=body)
            created.raise_for_status()
            created_json = created.json()
            task_id = created_json.get("output", {}).get("task_id")
            if not task_id:
                raise RuntimeError(f"百炼未返回任务 ID：{created_json.get('message') or created_json}")
            deadline = time.monotonic() + float(options.get("poll_timeout", 1800))
            video_url = ""
            while time.monotonic() < deadline:
                status_response = await client.get(f"{base}/tasks/{task_id}", headers={"Authorization": f"Bearer {config.api_key}"})
                status_response.raise_for_status()
                payload = status_response.json()
                output = payload.get("output", {})
                status = str(output.get("task_status") or "UNKNOWN").upper()
                if status == "SUCCEEDED":
                    video_url = str(output.get("video_url") or "")
                    break
                if status in {"FAILED", "CANCELED", "UNKNOWN"}:
                    raise RuntimeError(f"百炼视频生成失败：{output.get('message') or payload.get('message') or status}")
                await asyncio.sleep(15)
            if not video_url:
                raise RuntimeError("百炼视频生成轮询超时")
            download = await client.get(video_url)
            download.raise_for_status()
            data = download.content
        target = project_media_dir(str(context.get("project_id") or "unassigned")) / "generated"
        target.mkdir(parents=True, exist_ok=True)
        path = target / f"video-{uuid.uuid4().hex[:12]}.mp4"
        path.write_bytes(data)
        return {"provider": self.provider, "model": model, "provider_task_id": task_id, "status": "completed", "output_path": str(path), "output_name": path.name, "asset_type": "video", "shot_id": context.get("shot_id")}

    @staticmethod
    def _data_url(path: str) -> str:
        source = Path(path)
        if not source.is_file() or source.stat().st_size > 20 * 1024 * 1024:
            raise RuntimeError("万相参考图不存在或超过20MB")
        mime = mimetypes.guess_type(source.name)[0] or "image/png"
        return f"data:{mime};base64,{base64.b64encode(source.read_bytes()).decode('ascii')}"
