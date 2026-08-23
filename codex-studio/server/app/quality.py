from typing import Any

WEIGHTS = {"character": 0.28, "scene": 0.18, "prop": 0.14, "motion": 0.20, "lighting": 0.08, "image": 0.07, "audio": 0.05}


def weighted_score(dimensions: dict[str, int]) -> int:
    supplied = {key: max(0, min(100, int(value))) for key, value in dimensions.items() if key in WEIGHTS}
    total_weight = sum(WEIGHTS[key] for key in supplied)
    return round(sum(supplied[key] * WEIGHTS[key] for key in supplied) / total_weight) if total_weight else 0


def repair_plan(dimensions: dict[str, int], findings: list[dict[str, Any]]) -> dict[str, Any]:
    actions = []
    mapping = {
        "character": ("regenerate_image", "重新注入角色设定图、Face ID 与冻结外貌字段"),
        "scene": ("regenerate_image", "重新注入场景基准图和空间布局"),
        "prop": ("patch_prompt", "锁定道具版本与前后状态"),
        "motion": ("regenerate_video", "使用动作首尾状态和运动速度约束重生成"),
        "lighting": ("relight", "沿用场景光位和色温锚点"),
        "image": ("upscale_or_regenerate", "修复画面质量与构图"),
        "audio": ("retime_audio", "重新对齐台词、口型和字幕时间码"),
    }
    for key, score in dimensions.items():
        if key in mapping and score < 80:
            action, instruction = mapping[key]
            actions.append({"dimension": key, "action": action, "instruction": instruction, "priority": "high" if score < 65 else "medium"})
    for finding in findings:
        if finding.get("severity") == "blocking":
            actions.insert(0, {"dimension": finding.get("type", "unknown"), "action": "manual_gate", "instruction": finding.get("message", "需要人工确认"), "priority": "blocking"})
    return {"required": bool(actions), "actions": actions, "strategy": "只重做失败环节，保留已通过资产与生成结果"}

