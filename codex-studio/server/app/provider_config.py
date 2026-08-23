"""Provider configuration with Windows DPAPI protected credentials.

API keys are never returned by the HTTP API and are never stored as plaintext.
Environment variables remain supported for unattended/CI deployments.
"""
from __future__ import annotations

import ctypes
import os
import sys
from ctypes import wintypes
from dataclasses import dataclass

from .database import connect
from .providers import PROVIDERS, Provider


@dataclass(frozen=True)
class ResolvedProviderConfig:
    provider: Provider
    base_url: str
    model: str
    api_key: str
    source: str


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _blob(data: bytes) -> tuple[_DataBlob, ctypes.Array]:
    buffer = ctypes.create_string_buffer(data)
    return _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))), buffer


def _protect(secret: str) -> bytes:
    if sys.platform != "win32":
        raise RuntimeError("API 密钥只能在 Windows 正式版中加密保存；开发环境请使用环境变量")
    incoming, keepalive = _blob(secret.encode("utf-8"))
    outgoing = _DataBlob()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    if not crypt32.CryptProtectData(ctypes.byref(incoming), "AI-Film-Studio", None, None, None, 0, ctypes.byref(outgoing)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(outgoing.pbData, outgoing.cbData)
    finally:
        kernel32.LocalFree(outgoing.pbData)


def _unprotect(ciphertext: bytes) -> str:
    if sys.platform != "win32":
        return ""
    incoming, keepalive = _blob(ciphertext)
    outgoing = _DataBlob()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    if not crypt32.CryptUnprotectData(ctypes.byref(incoming), None, None, None, None, 0, ctypes.byref(outgoing)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(outgoing.pbData, outgoing.cbData).decode("utf-8")
    finally:
        kernel32.LocalFree(outgoing.pbData)


def _provider(provider_id: str) -> Provider:
    try:
        return next(item for item in PROVIDERS if item.id == provider_id and item.id != "mock")
    except StopIteration as exc:
        raise KeyError(f"Unknown provider: {provider_id}") from exc


def resolve_provider_config(provider_id: str, capability: str = "chat") -> ResolvedProviderConfig:
    provider = _provider(provider_id)
    env_prefix = provider_id.upper().replace("-", "_")
    env_secret = next((os.getenv(name, "").strip() for name in provider.secret_names if os.getenv(name, "").strip()), "")
    env_url = os.getenv(f"AI_STUDIO_{env_prefix}_BASE_URL", "").strip()
    env_model = os.getenv(f"AI_STUDIO_{env_prefix}_MODEL", "").strip()
    with connect() as db:
        row = db.execute("SELECT base_url,model,secret_blob FROM provider_configs WHERE provider_id=?", (provider_id,)).fetchone()
    stored_secret = _unprotect(bytes(row["secret_blob"])) if row and row["secret_blob"] else ""
    models = provider.models.get(capability, ())
    return ResolvedProviderConfig(
        provider=provider,
        base_url=env_url or (row["base_url"] if row and row["base_url"] else provider.base_url),
        model=env_model or (row["model"] if row and row["model"] else (models[0] if models else "")),
        api_key=env_secret or stored_secret,
        source="environment" if env_secret else ("windows_dpapi" if stored_secret else "none"),
    )


def save_provider_config(provider_id: str, base_url: str, model: str, api_key: str | None) -> dict:
    provider = _provider(provider_id)
    cipher = _protect(api_key.strip()) if api_key and api_key.strip() else None
    with connect() as db:
        current = db.execute("SELECT secret_blob FROM provider_configs WHERE provider_id=?", (provider_id,)).fetchone()
        secret_blob = cipher if cipher is not None else (current["secret_blob"] if current else None)
        db.execute(
            "INSERT INTO provider_configs(provider_id,base_url,model,secret_blob) VALUES(?,?,?,?) "
            "ON CONFLICT(provider_id) DO UPDATE SET base_url=excluded.base_url,model=excluded.model,"
            "secret_blob=excluded.secret_blob,updated_at=CURRENT_TIMESTAMP",
            (provider_id, base_url.strip() or provider.base_url, model.strip(), secret_blob),
        )
    return public_provider_status(provider_id)


def delete_provider_config(provider_id: str) -> None:
    _provider(provider_id)
    with connect() as db:
        db.execute("DELETE FROM provider_configs WHERE provider_id=?", (provider_id,))


def public_provider_status(provider_id: str) -> dict:
    config = resolve_provider_config(provider_id)
    return {
        "provider_id": provider_id,
        "name": config.provider.name,
        "base_url": config.base_url,
        "model": config.model,
        "configured": bool(config.api_key and config.base_url and config.model),
        "credential_source": config.source,
        "capabilities": list(config.provider.capabilities),
    }


def all_provider_statuses() -> list[dict]:
    return [public_provider_status(item.id) for item in PROVIDERS if item.id != "mock"]
