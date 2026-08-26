from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from ..config import app_data_dir
from ..provider_config import resolve_provider_config
from .base import AIAdapter


class MetasoVideoAdapter(AIAdapter):
    """秘塔 MiniMax H3 异步视频任务适配器。"""

    provider = "metaso"
    _success = {"success", "succeeded", "completed", "complete", "done", "finished"}
    _failed = {"failed", "failure", "error", "canceled", "cancelled"}

    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        poll_interval: float = 3.0,
        poll_timeout: float = 1200.0,
        output_root: Path | None = None,
    ) -> None:
        self.transport = transport
        self.poll_interval = poll_interval
        self.poll_timeout = poll_timeout
        self.output_root = output_root

    async def invoke(self, prompt: str, context: dict[str, Any]) -> dict[str, Any]:
        if str(context.get("task_type")) != "video":
            raise RuntimeError("秘塔 MiniMax H3 适配器只执行视频生成任务")
        config = resolve_provider_config(self.provider, "i2v")
        if not config.api_key:
            raise RuntimeError("秘塔 metaso 尚未配置 API 密钥")
        model = str(context.get("model_override") or config.model or "MiniMax-H3")
        duration = int(context.get("duration_seconds") or 5)
        if not 4 <= duration <= 15:
            raise RuntimeError("秘塔视频时长必须在 4–15 秒之间")
        resolution = str(context.get("resolution") or "768P")
        if resolution not in {"480p", "512p", "768P", "2K"}:
            raise RuntimeError("秘塔视频分辨率仅支持 480p、512p、768P 或 2K")

        first = str(context.get("first_frame") or "").strip()
        last = str(context.get("last_frame") or "").strip()
        references = [str(item).strip() for item in context.get("reference_images", []) if str(item).strip()]
        ordered = [item for item in [first, *references] if item]
        if len(ordered) + int(bool(last)) > 9:
            raise RuntimeError("秘塔 MiniMax H3 最多接收 9 张参考图（含首尾帧）")

        content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        for image in ordered:
            content.append({"type": "image_url", "image_url": {"url": self._image_value(image)}})
        body: dict[str, Any] = {
            "model": model,
            "content": content,
            "duration": duration,
            "resolution": resolution,
        }
        aspect_ratio = str(context.get("aspect_ratio") or "auto")
        if aspect_ratio != "auto":
            body["aspect_ratio"] = aspect_ratio
        if last:
            body["last_frame_image"] = self._image_value(last)

        base = config.base_url.rstrip("/")
        headers = {"Authorization": f"Bearer {config.api_key}", "Content-Type": "application/json"}
        timeout = httpx.Timeout(120.0, connect=20.0)
        async with httpx.AsyncClient(transport=self.transport, timeout=timeout, follow_redirects=True) as client:
            created = await self._json_request(client, "POST", f"{base}/video_generation", headers, body)
            provider_task_id = self._task_id(created)
            if not provider_task_id:
                raise RuntimeError("秘塔返回成功但缺少视频任务 ID")
            result = await self._poll(client, base, provider_task_id, headers)
            media_url = self._media_url(result)
            if not media_url:
                raise RuntimeError("秘塔任务已完成但未返回视频下载地址")
            output_path = await self._download(client, media_url, headers, base, int(context.get("task_id") or 0))
        return {
            "provider": self.provider,
            "model": model,
            "provider_task_id": provider_task_id,
            "status": "completed",
            "output_path": str(output_path),
            "source_url": media_url,
            "duration_seconds": duration,
            "resolution": resolution,
            "aspect_ratio": aspect_ratio,
        }

    @staticmethod
    def _image_value(value: str) -> str:
        if value.startswith(("http://", "https://", "data:")):
            return value
        path = Path(value).expanduser()
        if not path.is_file():
            raise RuntimeError(f"参考图不存在：{value}")
        if path.stat().st_size > 12 * 1024 * 1024:
            raise RuntimeError(f"参考图超过 12 MB：{path.name}")
        mime = mimetypes.guess_type(path.name)[0] or "image/png"
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        return f"data:{mime};base64,{encoded}"

    async def _json_request(self, client: httpx.AsyncClient, method: str, url: str, headers: dict[str, str], body: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            response = await client.request(method, url, headers=headers, json=body)
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"秘塔请求失败：{exc}") from exc
        if not isinstance(payload, dict):
            raise RuntimeError("秘塔返回了无法识别的数据格式")
        message = self._api_error(payload)
        if message:
            raise RuntimeError(f"秘塔接口返回错误：{message}")
        return payload

    async def _poll(self, client: httpx.AsyncClient, base: str, task_id: str, headers: dict[str, str]) -> dict[str, Any]:
        origin = f"{urlparse(base).scheme}://{urlparse(base).netloc}"
        candidates = [
            f"{base}/query/video_generation/{task_id}",
            f"{origin}/api/video-generation/{task_id}",
            f"{origin}/api/video-generation/{task_id}/status",
        ]
        deadline = asyncio.get_running_loop().time() + self.poll_timeout
        selected: str | None = None
        latest: dict[str, Any] = {}
        while asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(self.poll_interval)
            urls = [selected] if selected else candidates
            for url in urls:
                if not url:
                    continue
                try:
                    response = await client.get(url, headers=headers)
                    if response.status_code in {404, 405} and selected is None:
                        continue
                    response.raise_for_status()
                    payload = response.json()
                except (httpx.HTTPError, json.JSONDecodeError) as exc:
                    if selected:
                        raise RuntimeError(f"秘塔任务查询失败：{exc}") from exc
                    continue
                if not isinstance(payload, dict):
                    continue
                message = self._api_error(payload)
                if message:
                    raise RuntimeError(f"秘塔任务失败：{message}")
                selected, latest = url, payload
                break
            if not selected:
                raise RuntimeError("秘塔没有可用的任务查询接口")
            status = self._status(latest)
            if status in self._failed:
                raise RuntimeError(f"秘塔视频任务失败：{self._api_error(latest) or status}")
            if status in self._success or self._media_url(latest):
                return latest
        raise RuntimeError(f"秘塔视频任务轮询超时（{int(self.poll_timeout)} 秒）")

    async def _download(self, client: httpx.AsyncClient, url: str, headers: dict[str, str], api_base: str, local_task_id: int) -> Path:
        download_headers = headers if urlparse(url).netloc == urlparse(api_base).netloc else {}
        try:
            response = await client.get(url, headers=download_headers)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise RuntimeError(f"秘塔视频下载失败：{exc}") from exc
        content_type = response.headers.get("content-type", "").lower()
        if not response.content or "json" in content_type:
            raise RuntimeError("秘塔视频下载地址未返回有效媒体文件")
        output = (self.output_root or app_data_dir() / "provider-downloads" / "metaso") / f"task-{local_task_id or 'unknown'}.mp4"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(response.content)
        return output

    @classmethod
    def _task_id(cls, payload: dict[str, Any]) -> str:
        for node in cls._dicts(payload):
            for key in ("task_id", "taskId", "id"):
                value = node.get(key)
                if value is not None and str(value).strip():
                    return str(value)
        return ""

    @classmethod
    def _status(cls, payload: dict[str, Any]) -> str:
        for node in cls._dicts(payload):
            for key in ("status", "state", "task_status"):
                value = node.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip().lower()
        return ""

    @classmethod
    def _media_url(cls, payload: dict[str, Any]) -> str:
        for node in cls._dicts(payload):
            for key in ("video_url", "download_url", "file_url", "url"):
                value = node.get(key)
                if isinstance(value, str) and value.startswith(("http://", "https://")):
                    return value
        return ""

    @classmethod
    def _api_error(cls, payload: dict[str, Any]) -> str:
        if str(payload.get("type", "")).lower() == "error":
            error = payload.get("error")
            return str(error.get("message") if isinstance(error, dict) else error or "unknown error")
        base = payload.get("base_resp") or payload.get("baseResp")
        if isinstance(base, dict) and int(base.get("status_code", base.get("statusCode", 0)) or 0) != 0:
            return str(base.get("status_msg") or base.get("statusMsg") or "unknown error")
        return ""

    @classmethod
    def _dicts(cls, value: Any):
        if isinstance(value, dict):
            yield value
            for child in value.values():
                yield from cls._dicts(child)
        elif isinstance(value, list):
            for child in value:
                yield from cls._dicts(child)
