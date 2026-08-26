from .base import AIAdapter, AdapterRegistry, MockAdapter, registry
from .openai_compatible import OpenAICompatibleAdapter
from .dashscope import DashScopeAdapter
from .anthropic import AnthropicAdapter
from .metaso import MetasoAdapter

for _provider in ("openai", "ark", "deepseek", "qwen"):
    registry.register(OpenAICompatibleAdapter(_provider))
registry.register(DashScopeAdapter())
registry.register(AnthropicAdapter())
registry.register(MetasoAdapter())

__all__ = ["AIAdapter", "AdapterRegistry", "MockAdapter", "OpenAICompatibleAdapter", "DashScopeAdapter", "AnthropicAdapter", "MetasoAdapter", "registry"]
