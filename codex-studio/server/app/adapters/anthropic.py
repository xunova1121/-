from __future__ import annotations

import json
import time
from typing import Any

import httpx

from ..database import connect
from ..provider_config import resolve_provider_config
from .base import AIAdapter


class AnthropicAdapter(AIAdapter):
    """Anthropic Messages API adapter used by the director/script stages."""

    provider = "anthropic"

    async def invoke(self, prompt: str, context: dict[str, Any]) -> dict[str, Any]:
        task_type = str(context.get("task_type", "llm"))
        if task_type not in {"llm", "proofread"}:
            raise RuntimeError(f"Anthropic Claude 不支持 {task_type} 媒体任务")
        config = resolve_provider_config(self.provider, "chat")
        if not config.api_key:
            raise RuntimeError("Anthropic Claude 尚未配置 API 密钥")
        if not config.model:
            raise RuntimeError("Anthropic Claude 尚未配置模型")
        endpoint = f"{config.base_url.rstrip('/')}/messages"
        body = {
            "model": config.model,
            "max_tokens": int(context.get("max_tokens", 4096)),
            "temperature": float(context.get("temperature", 0.4)),
            "system": str(context.get("system_prompt") or "你是影视制作导演助手，输出可直接执行、具体且结构化的结果。"),
            "messages": [{"role": "user", "content": prompt}],
        }
        started = time.perf_counter()
        status_code = 0
        error = ""
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=20.0)) as client:
                response = await client.post(endpoint, headers={
                    "x-api-key": config.api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                }, json=body)
                status_code = response.status_code
                if response.is_error:
                    detail = response.text[:1200]
                    raise RuntimeError(f"Anthropic HTTP {status_code} · {endpoint} · {detail}")
                payload = response.json()
            content = "\n".join(str(item.get("text") or "") for item in payload.get("content", []) if item.get("type") == "text").strip()
            if not content:
                raise RuntimeError("Anthropic 未返回文本内容")
            return {"provider": self.provider, "model": config.model, "status": "completed", "result": content, "usage": payload.get("usage", {})}
        except (httpx.HTTPError, KeyError, TypeError, json.JSONDecodeError) as exc:
            error = str(exc)
            raise RuntimeError(f"Anthropic 请求失败：{error}") from exc
        except RuntimeError as exc:
            error = str(exc)
            raise
        finally:
            latency = int((time.perf_counter() - started) * 1000)
            with connect() as db:
                db.execute(
                    "INSERT INTO request_logs(provider,capability,status_code,latency_ms,success,error_message) VALUES(?,?,?,?,?,?)",
                    (self.provider, "chat", status_code, latency, int(200 <= status_code < 300 and not error), error[:1000]),
                )
