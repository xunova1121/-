from .base import AIAdapter, AdapterRegistry, MockAdapter, registry
from .openai_compatible import OpenAICompatibleAdapter

for _provider in ("openai", "ark"):
    registry.register(OpenAICompatibleAdapter(_provider))

__all__ = ["AIAdapter", "AdapterRegistry", "MockAdapter", "OpenAICompatibleAdapter", "registry"]
