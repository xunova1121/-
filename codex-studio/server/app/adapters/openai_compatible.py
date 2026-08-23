from __future__ import annotations

import json
import base64
import asyncio
import mimetypes
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

from ..database import connect
from ..config import project_media_dir
from ..provider_config import resolve_provider_config
from .base import AIAdapter


class OpenAICompatibleAdapter(AIAdapter):
    """Real chat-completions adapter for OpenAI-compatible providers."""

    def __init__(self, provider: str) -> None:
        self.provider = provider

    @staticmethod
    def _ensure(response: httpx.Response, label: str, endpoint: str) -> None:
        if response.status_code >= 400:
            raise RuntimeError(f"{label} HTTP {response.status_code} · {endpoint} · {response.text[:1200]}")

    async def invoke(self, prompt: str, context: dict[str, Any]) -> dict[str, Any]:
        task_type = str(context.get("task_type", "llm"))
        if task_type == "image" and self.provider == "openai":
            return await self._image(prompt, context)
        if task_type == "voice" and self.provider == "openai":
            return await self._voice(prompt, context)
        if task_type == "video" and self.provider == "openai":
            return await self._video(prompt, context)
        if task_type == "vision_review" and self.provider == "openai":
            return await self._vision_review(prompt, context)
        if task_type not in {"llm", "proofread"}:
            raise RuntimeError(f"{self.provider} 尚未实现 {task_type} 协议；任务不会伪造成功")
        config = resolve_provider_config(self.provider, "chat")
        if not config.api_key:
            raise RuntimeError(f"{config.provider.name} 尚未配置 API 密钥")
        if not config.model:
            raise RuntimeError(f"{config.provider.name} 尚未配置模型")
        endpoint = f"{config.base_url.rstrip('/')}/chat/completions"
        system = str(context.get("system_prompt") or "你是影视制作助手。输出可直接用于制作的结构化、具体结果。")
        body = {
            "model": config.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            "temperature": float(context.get("temperature", 0.4)),
        }
        started = time.perf_counter()
        status_code = 0
        error = ""
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=20.0)) as client:
                response = await client.post(endpoint, headers={"Authorization": f"Bearer {config.api_key}", "Content-Type": "application/json"}, json=body)
                status_code = response.status_code
                self._ensure(response, config.provider.name, endpoint)
                payload = response.json()
            content = payload["choices"][0]["message"]["content"]
            return {"provider": self.provider, "model": config.model, "status": "completed", "result": content, "usage": payload.get("usage", {})}
        except RuntimeError as exc:
            error = str(exc)
            raise
        except (httpx.HTTPError, KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
            error = str(exc)
            raise RuntimeError(f"{config.provider.name} 请求失败：{error}") from exc
        finally:
            latency = int((time.perf_counter() - started) * 1000)
            with connect() as db:
                db.execute(
                    "INSERT INTO request_logs(provider,capability,status_code,latency_ms,success,error_message) VALUES(?,?,?,?,?,?)",
                    (self.provider, "chat", status_code, latency, int(200 <= status_code < 300 and not error), error[:1000]),
                )

    def _destination(self, context: dict[str, Any], suffix: str) -> Path:
        project_id = str(context.get("project_id") or "unassigned")
        target = project_media_dir(project_id) / "generated"
        target.mkdir(parents=True, exist_ok=True)
        return target / f"{context.get('task_type', 'media')}-{uuid.uuid4().hex[:12]}{suffix}"

    async def _image(self, prompt: str, context: dict[str, Any]) -> dict[str, Any]:
        config = resolve_provider_config(self.provider, "t2i")
        if not config.api_key:
            raise RuntimeError("OpenAI 尚未配置 API 密钥")
        options = dict(context.get("options") or {})
        model = str(context.get("model") or options.get("model") or "gpt-image-2")
        body = {"model": model, "prompt": prompt, "size": options.get("size", "1536x1024"), "quality": options.get("quality", "medium"), "output_format": "png"}
        references = [Path(item) for item in list(context.get("reference_paths") or [])[:4] if Path(item).is_file()]
        async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=30.0)) as client:
            if references:
                endpoint = f"{config.base_url.rstrip('/')}/images/edits"
                files = [("image", (path.name, path.read_bytes(), mimetypes.guess_type(path.name)[0] or "image/png")) for path in references]
                form = {key: str(value) for key, value in body.items()}
                form["input_fidelity"] = str(options.get("input_fidelity", "high"))
                response = await client.post(endpoint, headers={"Authorization": f"Bearer {config.api_key}"}, data=form, files=files)
            else:
                endpoint = f"{config.base_url.rstrip('/')}/images/generations"
                response = await client.post(endpoint, headers={"Authorization": f"Bearer {config.api_key}", "Content-Type": "application/json"}, json=body)
            self._ensure(response, "OpenAI 图片", endpoint)
            payload = response.json()
            item = payload["data"][0]
            if item.get("b64_json"):
                data = base64.b64decode(item["b64_json"])
            elif item.get("url"):
                download = await client.get(item["url"])
                download.raise_for_status()
                data = download.content
            else:
                raise RuntimeError("OpenAI 图片接口未返回图像数据")
        output = self._destination(context, ".png")
        output.write_bytes(data)
        return {"provider": self.provider, "model": model, "status": "completed", "output_path": str(output), "output_name": output.name, "asset_type": "image", "shot_id": context.get("shot_id"), "revised_prompt": item.get("revised_prompt", "")}

    async def _voice(self, prompt: str, context: dict[str, Any]) -> dict[str, Any]:
        config = resolve_provider_config(self.provider, "tts")
        if not config.api_key:
            raise RuntimeError("OpenAI 尚未配置 API 密钥")
        options = dict(context.get("options") or {})
        model = str(context.get("model") or options.get("model") or "gpt-4o-mini-tts")
        body = {"model": model, "voice": options.get("voice", "alloy"), "input": prompt, "response_format": "mp3"}
        if options.get("instructions"):
            body["instructions"] = options["instructions"]
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=30.0)) as client:
            response = await client.post(f"{config.base_url.rstrip('/')}/audio/speech", headers={"Authorization": f"Bearer {config.api_key}", "Content-Type": "application/json"}, json=body)
            self._ensure(response, "OpenAI 语音", f"{config.base_url.rstrip('/')}/audio/speech")
            data = response.content
        output = self._destination(context, ".mp3")
        output.write_bytes(data)
        return {"provider": self.provider, "model": model, "status": "completed", "output_path": str(output), "output_name": output.name, "asset_type": "voice", "shot_id": context.get("shot_id")}

    @staticmethod
    def _data_url(path: str) -> str:
        source = Path(path)
        if not source.is_file() or source.stat().st_size > 20 * 1024 * 1024:
            raise RuntimeError("视频参考图不存在或超过 20MB")
        mime = mimetypes.guess_type(source.name)[0] or "image/png"
        return f"data:{mime};base64,{base64.b64encode(source.read_bytes()).decode('ascii')}"

    async def _video(self, prompt: str, context: dict[str, Any]) -> dict[str, Any]:
        config = resolve_provider_config(self.provider, "i2v")
        if not config.api_key:
            raise RuntimeError("OpenAI 尚未配置 API 密钥")
        options = dict(context.get("options") or {})
        model = str(context.get("model") or options.get("model") or "sora-2")
        body: dict[str, Any] = {"model": model, "prompt": prompt, "seconds": str(options.get("seconds", 8)), "size": options.get("size", "1280x720")}
        reference = str(options.get("reference_path") or next(iter(context.get("reference_paths") or []), ""))
        if reference:
            body["input_reference"] = {"image_url": self._data_url(reference)}
        headers = {"Authorization": f"Bearer {config.api_key}", "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=30.0)) as client:
            created = await client.post(f"{config.base_url.rstrip('/')}/videos", headers=headers, json=body)
            self._ensure(created, "OpenAI 视频创建", f"{config.base_url.rstrip('/')}/videos")
            job = created.json()
            video_id = job["id"]
            deadline = time.monotonic() + float(options.get("poll_timeout", 1200))
            while time.monotonic() < deadline:
                status_response = await client.get(f"{config.base_url.rstrip('/')}/videos/{video_id}", headers=headers)
                self._ensure(status_response, "OpenAI 视频状态", f"{config.base_url.rstrip('/')}/videos/{video_id}")
                job = status_response.json()
                status = str(job.get("status") or "").lower()
                if status in {"completed", "succeeded"}:
                    break
                if status in {"failed", "cancelled", "canceled"}:
                    raise RuntimeError(f"OpenAI 视频生成失败：{job.get('error') or status}")
                await asyncio.sleep(10)
            else:
                raise RuntimeError("OpenAI 视频生成轮询超时")
            download = await client.get(f"{config.base_url.rstrip('/')}/videos/{video_id}/content", headers={"Authorization": f"Bearer {config.api_key}"})
            self._ensure(download, "OpenAI 视频下载", f"{config.base_url.rstrip('/')}/videos/{video_id}/content")
            data = download.content
        output = self._destination(context, ".mp4")
        output.write_bytes(data)
        return {"provider": self.provider, "model": model, "provider_task_id": video_id, "status": "completed", "output_path": str(output), "output_name": output.name, "asset_type": "video", "shot_id": context.get("shot_id"), "deprecation_notice": "OpenAI Videos API is scheduled to shut down on 2026-09-24"}

    async def _vision_review(self, prompt: str, context: dict[str, Any]) -> dict[str, Any]:
        config = resolve_provider_config(self.provider, "vision")
        if not config.api_key:
            raise RuntimeError("OpenAI 尚未配置 API 密钥")
        references = list(context.get("reference_paths") or [])
        if not references:
            raise RuntimeError("视觉质检缺少关键帧")
        model = str(context.get("model") or "gpt-4.1-mini")
        content: list[dict[str, Any]] = [{"type": "text", "text": prompt + "\n只输出JSON对象：score(0-100)、dimensions(character,scene,prop,lighting,image)、findings数组。不得输出Markdown。"}]
        for path in references[:3]:
            content.append({"type": "image_url", "image_url": {"url": self._data_url(path), "detail": "high"}})
        body = {"model": model, "messages": [{"role": "user", "content": content}], "temperature": 0.1, "response_format": {"type": "json_object"}}
        async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=30.0)) as client:
            response = await client.post(f"{config.base_url.rstrip('/')}/chat/completions", headers={"Authorization": f"Bearer {config.api_key}", "Content-Type": "application/json"}, json=body)
            self._ensure(response, "OpenAI 视觉质检", f"{config.base_url.rstrip('/')}/chat/completions")
            raw = response.json()["choices"][0]["message"]["content"]
        try:
            review = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError("视觉质检未返回有效 JSON") from exc
        dimensions = {key: max(0, min(100, int(value))) for key, value in dict(review.get("dimensions") or {}).items()}
        score = int(review.get("score") or (sum(dimensions.values()) / len(dimensions) if dimensions else 0))
        return {"provider": self.provider, "model": model, "status": "completed", "score": max(0, min(100, score)), "dimensions": dimensions,
                "findings": list(review.get("findings") or []), "shot_id": context.get("shot_id"), "reviewed_path": references[0]}
