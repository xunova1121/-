from .base import AIAdapter, AdapterRegistry, MockAdapter, registry
from .openai_compatible import OpenAICompatibleAdapter
from .dashscope import DashScopeAdapter

for _provider in ("openai", "ark"):
    registry.register(OpenAICompatibleAdapter(_provider))
registry.register(DashScopeAdapter())

__all__ = ["AIAdapter", "AdapterRegistry", "MockAdapter", "OpenAICompatibleAdapter", "DashScopeAdapter", "registry"]
