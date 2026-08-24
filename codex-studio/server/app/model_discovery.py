"""Live provider model discovery with honest catalog fallbacks."""
from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from .provider_config import resolve_provider_config


CAPABILITY_FILTERS = {
    "chat": "TG", "vision": "VU", "t2i": "IG", "i2i": "IG",
    "i2v": "VG", "r2v": "VG", "tts": "TTS", "sfx": "TTS",
}


def _model_capabilities(model_id: str) -> list[str]:
    value = model_id.lower()
    if any(token in value for token in ("image", "dall-e")):
        return ["t2i", "i2i"]
    if any(token in value for token in ("tts", "speech")):
        return ["tts"]
    if any(token in value for token in ("video", "wan", "sora", "minimax-h3")):
        return ["i2v", "r2v"]
    return ["chat", "vision"]


def _catalog(config, capability: str | None, warning: str) -> dict:
    ids: list[str] = []
    for cap, models in config.provider.models.items():
        if capability and cap != capability:
            continue
        ids.extend(models)
    models = [{"id": item, "name": item, "capabilities": _model_capabilities(item), "context_window": None} for item in dict.fromkeys(ids)]
    return {"provider_id": config.provider.id, "source": "declared_catalog", "capability": capability or "", "models": models, "warning": warning}


def _aliyun_models_url(base_url: str) -> str:
    parts = urlsplit(base_url)
    return urlunsplit((parts.scheme, parts.netloc, "/api/v1/models", "", ""))


async def discover_provider_models(provider_id: str, capability: str | None = None, transport: httpx.AsyncBaseTransport | None = None) -> dict:
    config = resolve_provider_config(provider_id, capability or "chat")
    if capability and capability not in config.provider.capabilities:
        raise ValueError(f"{config.provider.name} 不支持 {capability}")
    if provider_id in {"metaso", "ark"}:
        label = "秘塔当前接口未提供稳定的账户模型枚举，请使用官方接入目录中的模型/Endpoint" if provider_id == "metaso" else "方舟调用使用 Endpoint ID；基础、定制模型需在方舟控制台管理"
        return _catalog(config, capability, label)
    if not config.api_key:
        return _catalog(config, capability, "尚未配置密钥，当前显示内置兼容目录；保存密钥后可实时拉取")

    headers = {"Authorization": f"Bearer {config.api_key}", "Accept": "application/json"}
    params: dict[str, Any] = {}
    if config.provider.family == "anthropic":
        endpoint = f"{config.base_url.rstrip('/')}/models"
        headers = {"x-api-key": config.api_key, "anthropic-version": "2023-06-01", "Accept": "application/json"}
    elif provider_id in {"qwen", "dashscope"}:
        endpoint = _aliyun_models_url(config.base_url)
        params = {"page_no": 1, "page_size": 100, "language": "zh-CN"}
        if provider_id == "qwen":
            params["providers"] = "qwen"
        elif provider_id == "dashscope":
            params["providers"] = "wan"
        if capability in CAPABILITY_FILTERS:
            params["capabilities"] = CAPABILITY_FILTERS[capability]
    else:
        endpoint = f"{config.base_url.rstrip('/')}/models"

    raw_models: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0), transport=transport) as client:
            if provider_id in {"qwen", "dashscope"}:
                for page_no in range(1, 21):
                    params["page_no"] = page_no
                    response = await client.get(endpoint, headers=headers, params=params)
                    if response.status_code >= 400:
                        raise RuntimeError(f"HTTP {response.status_code} · {response.text[:500]}")
                    payload = response.json()
                    output = payload.get("output", {})
                    page = list(output.get("models") or [])
                    raw_models.extend(page)
                    total = int(output.get("total") or len(raw_models))
                    if not page or len(raw_models) >= total or len(page) < int(params["page_size"]):
                        break
            elif config.provider.family == "anthropic":
                cursor = ""
                for _ in range(20):
                    query: dict[str, Any] = {"limit": 100}
                    if cursor:
                        query["after_id"] = cursor
                    response = await client.get(endpoint, headers=headers, params=query)
                    if response.status_code >= 400:
                        raise RuntimeError(f"HTTP {response.status_code} · {response.text[:500]}")
                    payload = response.json()
                    raw_models.extend(list(payload.get("data") or []))
                    if not payload.get("has_more"):
                        break
                    cursor = str(payload.get("last_id") or "")
                    if not cursor:
                        break
            else:
                response = await client.get(endpoint, headers=headers, params=params)
                if response.status_code >= 400:
                    raise RuntimeError(f"HTTP {response.status_code} · {response.text[:500]}")
                payload = response.json()
                raw_models = list(payload.get("data") or [])
    except (httpx.HTTPError, ValueError, RuntimeError) as exc:
        fallback = _catalog(config, capability, f"实时拉取失败：{exc}；已回退到内置兼容目录")
        fallback["endpoint"] = endpoint
        return fallback

    models: list[dict] = []
    for raw in raw_models:
        model_id = str(raw.get("model") or raw.get("id") or "").strip()
        if not model_id:
            continue
        caps = list(raw.get("capabilities") or _model_capabilities(model_id))
        internal_caps = [key for key, value in CAPABILITY_FILTERS.items() if value in caps] or _model_capabilities(model_id)
        if capability and capability not in internal_caps and provider_id not in {"anthropic", "deepseek"}:
            continue
        info = raw.get("model_info") or {}
        models.append({"id": model_id, "name": str(raw.get("name") or raw.get("display_name") or model_id), "capabilities": list(dict.fromkeys(internal_caps)), "context_window": info.get("context_window") or raw.get("context_window")})
    models.sort(key=lambda item: item["id"].lower())
    return {"provider_id": provider_id, "source": "remote", "capability": capability or "", "models": models, "warning": "", "endpoint": endpoint}
