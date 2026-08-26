from typing import Any

METHODS = {
    "cut": {"engine": "ffmpeg", "cost": "free"},
    "match_cut": {"engine": "ffmpeg", "cost": "free"},
    "dissolve": {"engine": "ffmpeg", "cost": "free"},
    "fade_black": {"engine": "ffmpeg", "cost": "free"},
    "tail_frame_dependency": {"engine": "production_scheduler", "cost": "api"},
}


def _multiple_of_four(value: int) -> int:
    return max(4, int(round(value / 4)) * 4)


def plan_transition(data: dict[str, Any]) -> dict[str, Any]:
    left, right = data["left"], data["right"]
    relation = data["narrative_relation"]
    same_scene = left["scene_key"] == right["scene_key"]
    direction_match = left.get("screen_direction") == right.get("screen_direction") or "unknown" in {left.get("screen_direction"), right.get("screen_direction")}
    light_match = not left.get("lighting") or not right.get("lighting") or left["lighting"] == right["lighting"]
    findings = []
    if same_scene and not direction_match:
        findings.append({"type": "axis", "severity": "warning", "message": "运动方向不一致，直接硬切可能形成越轴"})
    if same_scene and not light_match:
        findings.append({"type": "lighting", "severity": "warning", "message": "相邻镜头光照不一致，需先做颜色/光影匹配"})

    if relation == "same_action":
        if data.get("allow_ai_bridge"):
            method = "tail_frame_dependency"
        else:
            method = "match_cut"
    elif relation == "time_passage":
        method = "dissolve"
    elif relation == "new_scene":
        method = "fade_black" if left.get("lighting") != right.get("lighting") else "cut"
    elif relation == "parallel":
        method = "match_cut"
    else:
        method = "cut" if direction_match and light_match else "tail_frame_dependency" if data.get("allow_ai_bridge") else "dissolve"

    fps = data.get("target_fps", 24)
    context_frames = _multiple_of_four(round(fps * 0.33))
    replace_frames = _multiple_of_four(round(fps * 0.33))
    bridge_frames = _multiple_of_four(round(fps * 0.5)) + 1
    fallbacks = {
        "tail_frame_dependency": ["match_cut", "dissolve", "cut"],
    }.get(method, ["cut"])
    score = max(0, 100 - len(findings) * 15)
    return {
        "method": method,
        "engine": METHODS[method]["engine"],
        "score": score,
        "findings": findings,
        "parameters": {
            "context_frames_each_side": context_frames,
            "replace_frames_each_side": replace_frames,
            "generated_bridge_frames": bridge_frames,
            "target_fps": fps,
            "color_match": not light_match,
            "preserve_audio": True,
            "audio_transition": "j_cut" if relation == "same_action" else "crossfade" if method == "dissolve" else "cut",
        },
        "fallback_chain": fallbacks,
        "reason": {
            "tail_frame_dependency": "下一镜直接以上一镜真实尾帧为生成条件，不插入额外桥接时长",
            "match_cut": "按动作形态和运动方向寻找最佳切点",
            "cut": "镜头关系允许专业硬切，不额外制造视觉噪声",
            "dissolve": "时间流逝使用短叠化并同步修正时间线",
            "fade_black": "时间或空间明显变化，用黑场向观众发出段落信号",
        }[method],
    }
