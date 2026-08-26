"""Central model-role routing for the whole production workflow."""
from __future__ import annotations

from dataclasses import asdict, dataclass

from .database import connect
from .provider_config import public_provider_status
from .providers import supports


@dataclass(frozen=True)
class ModelRole:
    id: str
    name: str
    stage: str
    capability: str
    description: str


MODEL_ROLES = (
    ModelRole("script_analysis", "剧本诊断", "剧本", "chat", "通读全剧，分析钩子、节拍、人物弧光和逻辑风险"),
    ModelRole("script_rewrite", "剧本改写", "剧本", "chat", "按诊断结果改写对白、节奏、场次和情节"),
    ModelRole("scene_breakdown", "拆场与要素提取", "剧本", "chat", "拆分集、场，提取人物、场景、道具和状态变化"),
    ModelRole("shot_breakdown", "拆镜头", "分镜", "chat", "将场景拆成覆盖充分、可拍摄的镜头序列"),
    ModelRole("storyboard_design", "全量分镜导演", "分镜", "chat", "一次生成全剧分镜、Story Bible 与逐镜连续性状态"),
    ModelRole("prompt_engineering", "生成提示词优化", "制作", "chat", "把导演意图和冻结设定转换为模型专用提示词"),
    ModelRole("continuity_review", "人物场景一致性审核", "质检", "vision", "比对参考图和相邻镜头的人物、服装、场景、道具与光线"),
    ModelRole("keyframe_image", "分镜关键帧", "制作", "t2i", "生成每个镜头的首帧或构图关键帧"),
    ModelRole("reference_image", "参考图高保真编辑", "制作", "i2i", "带人物/场景参考图生成，保持身份与美术一致"),
    ModelRole("shot_video", "正式镜头视频", "制作", "i2v", "从确认关键帧生成正式视频镜头"),
    ModelRole("transition_video", "首尾帧桥接", "制作", "i2v", "根据上一镜尾帧与下一镜首帧生成连续过渡"),
    ModelRole("dialogue_voice", "角色对白配音", "声音", "tts", "按角色固定音色生成对白并进入音轨"),
    ModelRole("final_review", "成片终检", "质检", "vision", "检查成片画面、连续性、字幕和音画同步风险"),
)


def role_by_id(role_id: str) -> ModelRole:
    try:
        return next(role for role in MODEL_ROLES if role.id == role_id)
    except StopIteration as exc:
        raise KeyError(f"Unknown model role: {role_id}") from exc


def list_model_roles() -> list[dict]:
    with connect() as db:
        rows = {row["role_id"]: dict(row) for row in db.execute("SELECT role_id,provider_id,model,updated_at FROM model_role_bindings")}
    result: list[dict] = []
    for role in MODEL_ROLES:
        item = asdict(role)
        binding = rows.get(role.id)
        item.update({
            "provider_id": binding["provider_id"] if binding else "",
            "model": binding["model"] if binding else "",
            "updated_at": binding["updated_at"] if binding else "",
            "available": bool(binding and public_provider_status(binding["provider_id"])["configured"]),
        })
        result.append(item)
    return result


def save_model_binding(role_id: str, provider_id: str, model: str) -> dict:
    role = role_by_id(role_id)
    if not supports(provider_id, role.capability):
        raise ValueError(f"{provider_id} 不支持岗位所需能力 {role.capability}")
    model = model.strip()
    if not model:
        raise ValueError("模型不能为空")
    with connect() as db:
        db.execute(
            "INSERT INTO model_role_bindings(role_id,provider_id,model) VALUES(?,?,?) "
            "ON CONFLICT(role_id) DO UPDATE SET provider_id=excluded.provider_id,model=excluded.model,updated_at=CURRENT_TIMESTAMP",
            (role_id, provider_id, model),
        )
    return next(item for item in list_model_roles() if item["id"] == role_id)


def resolve_model_role(role_id: str) -> dict | None:
    role = role_by_id(role_id)
    with connect() as db:
        row = db.execute("SELECT provider_id,model FROM model_role_bindings WHERE role_id=?", (role_id,)).fetchone()
    if not row:
        return None
    return {"role_id": role.id, "capability": role.capability, "provider_id": row["provider_id"], "model": row["model"]}


def delete_model_binding(role_id: str) -> None:
    role_by_id(role_id)
    with connect() as db:
        db.execute("DELETE FROM model_role_bindings WHERE role_id=?", (role_id,))
