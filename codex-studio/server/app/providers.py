"""声明式模型目录与能力路由。

借鉴 Claude 版本的核心原则：一家服务商可以有多种能力，但每种能力独立选路由，
业务层不直接写死供应商名称。
"""
from dataclasses import asdict, dataclass, field


@dataclass(frozen=True)
class Provider:
    id: str
    name: str
    family: str
    base_url: str
    capabilities: tuple[str, ...]
    secret_names: tuple[str, ...] = ()
    models: dict[str, tuple[str, ...]] = field(default_factory=dict)
    async_task: bool = False
    max_reference_images: int | None = None
    supports_end_frame: bool = False
    max_duration_seconds: int | None = None
    long_video_strategy: str = "shot_sequence"


CAPABILITIES = {
    "chat": "剧本与分镜",
    "vision": "视觉一致性复核",
    "t2i": "文生图",
    "i2i": "参考图生图",
    "i2v": "图生视频",
    "r2v": "参考图生视频",
    "tts": "语音合成",
    "sfx": "音效生成",
}

PROVIDERS = (
    Provider("mock", "内部自动化测试", "mock", "", tuple(CAPABILITIES), models={"chat": ("mock-chat",)}),
    Provider("openai", "OpenAI 标准接口", "openai", "https://api.openai.com/v1",
             ("chat", "vision", "t2i", "i2i", "i2v", "tts"), ("OPENAI_API_KEY",),
             {"chat": ("gpt-4.1-mini",), "vision": ("gpt-4o",), "t2i": ("gpt-image-1",), "i2v": ("sora-2",), "tts": ("gpt-4o-mini-tts",)}, True, 1, False, 12, "extend_or_shot_sequence"),
    Provider("anthropic", "Anthropic Claude", "anthropic", "https://api.anthropic.com/v1",
             ("chat",), ("ANTHROPIC_API_KEY",), {"chat": ("claude-sonnet-4-5",)}),
    Provider("deepseek", "DeepSeek", "openai", "https://api.deepseek.com",
             ("chat",), ("DEEPSEEK_API_KEY",), {"chat": ("deepseek-chat",)}),
    Provider("qwen", "阿里云百炼 · Qwen", "openai", "https://dashscope.aliyuncs.com/compatible-mode/v1",
             ("chat", "vision"), ("DASHSCOPE_API_KEY",), {"chat": ("qwen-plus",), "vision": ("qwen-vl-max",)}),
    Provider("ark", "火山引擎方舟", "openai", "https://ark.cn-beijing.volces.com/api/v3",
             ("chat", "vision", "t2i", "i2i", "i2v", "r2v"), ("ARK_API_KEY",), {}, True, 1, True, None, "shot_sequence"),
    Provider("dashscope", "阿里云百炼", "dashscope", "https://dashscope.aliyuncs.com/api/v1",
             ("chat", "vision", "t2i", "i2v", "tts"), ("DASHSCOPE_API_KEY",), {}, True),
    Provider("kling", "可灵 Kling", "kling", "https://api.klingai.com/v1",
             ("i2v",), ("KLING_ACCESS_KEY", "KLING_SECRET_KEY"), {}, True, 4, True, None, "extend_then_bridge"),
    Provider("vidu", "Vidu", "vidu", "https://api.vidu.cn/ent/v2",
             ("i2v", "r2v"), ("VIDU_API_KEY",), {}, True, 7, False, None, "reference_consistent_sequence"),
    Provider("minimax", "MiniMax 海螺", "minimax", "https://api.minimaxi.com/v1",
             ("chat", "t2i", "i2v", "r2v", "tts"), ("MINIMAX_API_KEY",), {}, True, 9, False, None, "reference_consistent_sequence"),
)


def public_catalog() -> list[dict]:
    return [asdict(provider) for provider in PROVIDERS if provider.id != "mock"]


def providers_for(capability: str) -> list[Provider]:
    return [provider for provider in PROVIDERS if provider.id != "mock" and capability in provider.capabilities]
