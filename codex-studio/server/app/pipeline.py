from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Stage:
    id: str
    order: int
    name: str
    requires: tuple[str, ...] = ()


STAGES = (
    Stage("bible", 1, "设定集"),
    Stage("storyboard", 2, "分镜", ("bible",)),
    Stage("images", 3, "镜头出图", ("storyboard",)),
    Stage("videos", 4, "视频生成", ("images",)),
    Stage("voice", 5, "配音与音效", ("storyboard",)),
    Stage("compose", 6, "剪辑合成", ("videos", "voice")),
)


def stage_catalog() -> list[dict]:
    return [asdict(stage) for stage in STAGES]

