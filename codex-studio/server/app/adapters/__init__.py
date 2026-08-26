from .base import AIAdapter, AdapterRegistry, MockAdapter, registry
from .openai_compatible import OpenAICompatibleAdapter
from .metaso import MetasoVideoAdapter

for _provider in ("openai", "ark"):
    registry.register(OpenAICompatibleAdapter(_provider))
registry.register(MetasoVideoAdapter())

__all__ = ["AIAdapter", "AdapterRegistry", "MetasoVideoAdapter", "MockAdapter", "OpenAICompatibleAdapter", "registry"]
