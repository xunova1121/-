from abc import ABC, abstractmethod
from typing import Any


class AIAdapter(ABC):
    provider: str

    @abstractmethod
    async def invoke(self, prompt: str, context: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError


class MockAdapter(AIAdapter):
    provider = "mock"

    async def invoke(self, prompt: str, context: dict[str, Any]) -> dict[str, Any]:
        return {"provider": self.provider, "status": "completed", "result": f"[TestAdapter] {prompt}", "context": context}


class AdapterRegistry:
    def __init__(self) -> None:
        self._adapters: dict[str, AIAdapter] = {"mock": MockAdapter()}

    def register(self, adapter: AIAdapter) -> None:
        self._adapters[adapter.provider] = adapter

    def resolve(self, provider: str) -> AIAdapter:
        if provider not in self._adapters:
            raise KeyError(f"AI provider not configured: {provider}")
        return self._adapters[provider]


registry = AdapterRegistry()
