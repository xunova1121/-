from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from ..config import project_media_dir
from ..database import connect
from ..provider_config import resolve_provider_config
from .base import AIAdapter


class MetasoAdapter(AIAdapter):
    """秘塔 MiniMax H3 中转适配器。

    秘塔当前与 MiniMax H3 v2 协议兼容，但查询路径和成品域名有中转差异。
    本适配器保留 Claude 分支经过实测的多路径查询与同域鉴权下载，并把
    provider task id 持久化到 SQLite，服务重启后继续轮询而不是重复提交扣费。
    """

    provider = "metaso"
    _terminal_failures = {"failed", "cancelled", "canceled", "error"}

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._transport = transport
        self._query_cache: dict[str, str] = {}

    async def invoke(self, prompt: str, context: dict[str, Any]) -> dict[str, Any]:
        if str(context.get("task_type")) != "video":
            raise RuntimeError("秘塔适配器当前用于 MiniMax H3 视频生成")
        config = resolve_provider_config(self.provider, "i2v")
        if not config.api_key:
            raise RuntimeError("秘塔尚未配置 API 密钥（控制台 mk- 开头的 Key）")

        options = dict(context.get("options") or {})
        references = [str(item) for item in context.get("reference_paths") or [] if item]
        model = str(context.get("model") or options.get("model") or config.model or "MiniMax-H3")
        duration = max(4, min(15, int(round(float(options.get("duration") or options.get("seconds") or 5)))))
        resolution = self._resolution(str(options.get("resolution") or "768P"))
        ratio = self._ratio(str(options.get("ratio") or self._ratio_from_size(str(options.get("size") or ""))))
        reference_mode = str(options.get("reference_mode") or "frames").lower()
        content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        if reference_mode == "reference":
            if len(references) > 9:
                raise RuntimeError("秘塔 H3 最多接收 9 张参考图，请减少选择后重试")
            for reference in references:
                content.append({"type": "image_url", "image_url": {"url": self._image_url(reference)}, "role": "reference_image"})
        else:
            if len(references) > 2:
                raise RuntimeError("秘塔首尾帧模式最多选择 2 张图；更多素材请切换为“参考图模式”")
            if references:
                content.append({"type": "image_url", "image_url": {"url": self._image_url(references[0])}, "role": "first_frame"})
            if len(references) > 1:
                content.append({"type": "image_url", "image_url": {"url": self._image_url(references[1])}, "role": "last_frame"})
        if len(json.dumps(content, ensure_ascii=False).encode("utf-8")) > 64 * 1024 * 1024:
            raise RuntimeError("秘塔 H3 请求体超过 64MB，请减少参考素材或改用公网 URL")
        body: dict[str, Any] = {
            "model": model,
            "content": content,
            "resolution": resolution,
            "duration": duration,
            "ratio": "adaptive" if references and reference_mode != "reference" else ratio,
            "aigc_watermark": bool(options.get("watermark", False)),
        }
        base = config.base_url.rstrip("/")
        headers = {"Authorization": f"Bearer {config.api_key}", "Content-Type": "application/json"}
        local_task_id = int(context.get("task_id") or 0)
        provider_task_id = self._saved_provider_task_id(local_task_id)

        timeout = httpx.Timeout(120.0, connect=30.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, transport=self._transport) as client:
            if not provider_task_id:
                endpoint = f"{base}/video_generation"
                response = await client.post(endpoint, headers=headers, json=body)
                payload = self._payload(response, "秘塔视频创建", endpoint)
                provider_task_id = str(payload.get("task_id") or (payload.get("task") or {}).get("id") or "")
                if not provider_task_id:
                    raise RuntimeError(f"秘塔未返回 task_id：{json.dumps(payload, ensure_ascii=False)[:1000]}")
                self._save_provider_state(local_task_id, provider_task_id, {"status": "submitted", "model": model})

            query_url = await self._resolve_query_url(client, base, provider_task_id, headers)
            deadline = time.monotonic() + float(options.get("poll_timeout", 1800))
            video_url = ""
            final_task: dict[str, Any] = {}
            while time.monotonic() < deadline:
                response = await client.get(query_url, headers=headers)
                payload = self._payload(response, "秘塔视频状态", query_url)
                task = payload.get("task") if isinstance(payload.get("task"), dict) else payload
                status = str(task.get("status") or task.get("state") or "").lower()
                self._save_provider_state(local_task_id, provider_task_id, {"status": status or "unknown", "query_url": self._redact_task(query_url, provider_task_id)})
                if status == "succeeded":
                    content_result = task.get("content") if isinstance(task.get("content"), dict) else {}
                    video_url = str(content_result.get("url") or task.get("url") or "")
                    final_task = task
                    break
                if status in self._terminal_failures:
                    self._clear_provider_task(local_task_id)
                    message = task.get("message") or task.get("error") or payload.get("message") or status
                    raise RuntimeError(f"秘塔视频生成失败：{message}")
                await asyncio.sleep(float(options.get("poll_interval", 15)))
            if not video_url:
                raise RuntimeError(f"秘塔视频生成排队超时；任务 {provider_task_id} 已保留，下次会继续查询，不会重复提交")

            download_headers = headers if self._needs_download_auth(video_url, base) else {}
            response = await client.get(video_url, headers=download_headers)
            self._ensure_http(response, "秘塔视频下载", video_url)
            content_type = str(response.headers.get("content-type") or "").lower()
            if "json" in content_type:
                try:
                    message = self._body_error(response.json())
                except Exception:
                    message = response.text[:500]
                raise RuntimeError(f"秘塔视频下载返回错误内容：{message or response.text[:500]}")
            data = response.content
            if not data:
                raise RuntimeError("秘塔视频下载结果为空")

        target = project_media_dir(str(context.get("project_id") or "unassigned")) / "generated"
        target.mkdir(parents=True, exist_ok=True)
        path = target / f"video-metaso-{uuid.uuid4().hex[:12]}.mp4"
        path.write_bytes(data)
        self._save_provider_state(local_task_id, provider_task_id, {"status": "downloaded", "bytes": len(data)})
        return {
            "provider": self.provider,
            "model": model,
            "provider_task_id": provider_task_id,
            "status": "completed",
            "output_path": str(path),
            "output_name": path.name,
            "asset_type": "video",
            "shot_id": context.get("shot_id"),
            "duration": final_task.get("duration", duration),
            "resolution": final_task.get("resolution", resolution),
            "ratio": final_task.get("ratio", "adaptive" if references and reference_mode != "reference" else ratio),
            "first_frame_sent": bool(references) and reference_mode != "reference",
            "last_frame_sent": len(references) > 1 and reference_mode != "reference",
            "reference_count_sent": len(references) if reference_mode == "reference" else 0,
            "native_audio": True,
            "native_audio_policy": str(options.get("native_audio_policy") or "model_default"),
        }

    async def _resolve_query_url(self, client: httpx.AsyncClient, base: str, task_id: str, headers: dict[str, str]) -> str:
        if base in self._query_cache:
            return self._query_cache[base].format(task_id=task_id)
        origin = f"{urlparse(base).scheme}://{urlparse(base).netloc}"
        templates = [
            f"{base}/query/video_generation/{{task_id}}",
            f"{origin}/api/video-generation/{{task_id}}",
            f"{origin}/api/video-generation/{{task_id}}/status",
            f"{base}/video_generation/{{task_id}}",
        ]
        failures: list[str] = []
        for template in templates:
            url = template.format(task_id=task_id)
            try:
                response = await client.get(url, headers=headers)
                payload = self._payload(response, "秘塔查询路径探测", url)
                if self._looks_like_task(payload, task_id):
                    self._query_cache[base] = template
                    return url
                failures.append(f"{self._redact_task(url, task_id)}：响应不是任务记录")
            except Exception as exc:
                failures.append(f"{self._redact_task(url, task_id)}：{exc}")
        raise RuntimeError("秘塔任务已提交，但查询路径均不可用：" + "；".join(failures))

    @classmethod
    def _payload(cls, response: httpx.Response, label: str, endpoint: str) -> dict[str, Any]:
        cls._ensure_http(response, label, endpoint)
        try:
            payload = response.json()
        except Exception as exc:
            raise RuntimeError(f"{label} 返回的不是 JSON：{response.text[:500]}") from exc
        if not isinstance(payload, dict):
            raise RuntimeError(f"{label} 返回结构无效")
        error = cls._body_error(payload)
        if error:
            raise RuntimeError(f"{label}失败：{error}")
        return payload

    @staticmethod
    def _ensure_http(response: httpx.Response, label: str, endpoint: str) -> None:
        if response.status_code >= 400:
            raise RuntimeError(f"{label} HTTP {response.status_code} · {endpoint} · {response.text[:800]}")

    @staticmethod
    def _body_error(payload: dict[str, Any]) -> str:
        base_resp = payload.get("base_resp")
        if isinstance(base_resp, dict) and base_resp.get("status_code") not in (None, 0, "0"):
            return f"{base_resp.get('status_msg') or '业务错误'}（code {base_resp.get('status_code')}）"
        error = payload.get("error")
        if payload.get("type") == "error" or isinstance(error, dict):
            error = error if isinstance(error, dict) else {}
            return f"{error.get('message') or payload.get('message') or '未知错误'}（{error.get('http_code') or error.get('code') or error.get('type') or 'error'}）"
        code = payload.get("code", payload.get("errCode", payload.get("err_code")))
        if code not in (None, 0, "0", "ok"):
            return f"{payload.get('msg') or payload.get('message') or '未知错误'}（code {code}）"
        return ""

    @staticmethod
    def _looks_like_task(payload: dict[str, Any], task_id: str) -> bool:
        task = payload.get("task") if isinstance(payload.get("task"), dict) else payload
        identity = str(task.get("id") or task.get("task_id") or "")
        status = str(task.get("status") or task.get("state") or "")
        content = task.get("content") if isinstance(task.get("content"), dict) else {}
        return identity == task_id or bool(status) or bool(content.get("url"))

    @staticmethod
    def _resolution(value: str) -> str:
        return "2K" if value.strip().upper() in {"2K", "1080P", "1440P", "2160P", "4K"} else "768P"

    @staticmethod
    def _ratio(value: str) -> str:
        normalized = value.strip()
        return normalized if normalized in {"21:9", "16:9", "4:3", "1:1", "3:4", "9:16"} else "16:9"

    @staticmethod
    def _ratio_from_size(value: str) -> str:
        try:
            width, height = (int(part) for part in value.lower().split("x", 1))
        except Exception:
            return "16:9"
        if height > width:
            return "9:16"
        if width == height:
            return "1:1"
        return "16:9"

    @staticmethod
    def _image_url(value: str) -> str:
        if value.startswith(("http://", "https://", "data:")):
            return value
        source = Path(value)
        if not source.is_file():
            raise RuntimeError(f"秘塔参考图不存在：{source}")
        if source.stat().st_size > 30 * 1024 * 1024:
            raise RuntimeError("秘塔参考图超过 30MB，请压缩后重试")
        mime = mimetypes.guess_type(source.name)[0] or "image/png"
        return f"data:{mime};base64,{base64.b64encode(source.read_bytes()).decode('ascii')}"

    @staticmethod
    def _needs_download_auth(url: str, base: str) -> bool:
        host = (urlparse(url).hostname or "").lower()
        base_host = (urlparse(base).hostname or "").lower()
        return host == base_host or host.endswith(".metaso.cn")

    @staticmethod
    def _redact_task(url: str, task_id: str) -> str:
        return url.replace(task_id, "…")

    @staticmethod
    def _saved_provider_task_id(local_task_id: int) -> str:
        if not local_task_id:
            return ""
        with connect() as db:
            row = db.execute("SELECT provider_task_id FROM tasks WHERE id=?", (local_task_id,)).fetchone()
        return str(row["provider_task_id"] or "") if row else ""

    @staticmethod
    def _save_provider_state(local_task_id: int, provider_task_id: str, state: dict[str, Any]) -> None:
        if not local_task_id:
            return
        with connect() as db:
            db.execute(
                "UPDATE tasks SET provider_task_id=?,provider_state_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
                (provider_task_id, json.dumps(state, ensure_ascii=False), local_task_id),
            )

    @staticmethod
    def _clear_provider_task(local_task_id: int) -> None:
        if not local_task_id:
            return
        with connect() as db:
            db.execute("UPDATE tasks SET provider_task_id='',provider_state_json='{}',updated_at=CURRENT_TIMESTAMP WHERE id=?", (local_task_id,))
