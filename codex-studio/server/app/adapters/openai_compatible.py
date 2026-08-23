from __future__ import annotations

import json
import time
from typing import Any

import httpx

from ..database import connect
from ..provider_config import resolve_provider_config
from .base import AIAdapter


class OpenAICompatibleAdapter(AIAdapter):
    """Real chat-completions adapter for OpenAI-compatible providers."""

    def __init__(self, provider: str) -> None:
        self.provider = provider

    async def invoke(self, prompt: str, context: dict[str, Any]) -> dict[str, Any]:
        task_type = str(context.get("task_type", "llm"))
        if task_type not in {"llm", "proofread"}:
            raise RuntimeError(f"{self.provider} 当前真实适配器仅支持剧本/校对任务，不会伪造 {task_type} 结果")
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
                response.raise_for_status()
                payload = response.json()
            content = payload["choices"][0]["message"]["content"]
            return {"provider": self.provider, "model": config.model, "status": "completed", "result": content, "usage": payload.get("usage", {})}
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
