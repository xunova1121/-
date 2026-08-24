from __future__ import annotations

import json
import re
from typing import Any


DIRECTOR_SYSTEM = """你是工业级短剧导演、分镜师和连续性总监。你的输出会直接进入生产数据库，必须只输出一个 JSON 对象，不得输出 Markdown 或解释。

先通读完整剧本，再按以下顺序工作：
1. 先按时间或地点变化划分场次；
2. 建立冻结 Story Bible；
3. 在每个场次内拆镜头；
4. 为相邻镜头标注 new-scene、cut 或 continuous；
5. 检查人物、服装、道具、光照、运动方向和动作阶段。

JSON 结构：
{
  "logline": "一句话梗概",
  "bible": {
    "world": {"name":"世界观","era":"","rules":"","visual_rules":""},
    "style": {"name":"全片风格","anchor":"","palette":"","negative":""},
    "characters": [{"name":"","appearance":"","face":"","hair":"","body":"","costume":"","voice":"alloy","voice_prompt":"","negative":""}],
    "locations": [{"name":"","appearance":"","layout":"","lighting":"","negative":""}],
    "props": [{"name":"","appearance":"","initial_state":"","negative":""}]
  },
  "scenes": [{"index":1,"heading":"","location":"","time_of_day":"","summary":"","enter":"cut"}],
  "shots": [{
    "scene_index":1,"title":"","description":"只写当前画面可见状态","shot_type":"中景","camera":"固定",
    "action":"一个镜头只包含一个主要动作","dialogue":"","speaker":"","line_kind":"speech",
    "sound":"","duration":4,"characters":[],"props":[],"link":"new-scene",
    "screen_direction":"unknown","action_id":"","action_phase":"static","momentum":"still","lighting":"","end_state":"",
    "state_before":{"characters":{},"props":{},"environment":{}},
    "state_after":{"characters":{},"props":{},"environment":{}},
    "state_change_reason":"仅在状态发生变化时说明镜头内可见原因",
    "value_score":60,"model_requirement":{"tier":"standard","reference_strength":"high","motion":"low"},
    "prompt":"可直接用于图像和视频生成的中文提示词"
  }]
}

硬性规则：
- 每个场次第一镜必须 link=new-scene；跨场次禁止 continuous；同场换机位默认 cut；只有同一动作的下一瞬间才用 continuous。
- 一镜只做一个主要动作；首帧描述必须是动作正在开始或进行中，不能把整段动作写完。
- 连续动作必须使用相同 action_id；action_phase 只能按 anticipation→start→middle→impact→follow_through→end→settle 前进，不得倒退或跨越两个以上阶段；momentum 标记 left/right/up/down/forward/back/still。
- 动作量必须与时长匹配；单镜 2-12 秒；对白时长按每秒约4个汉字估算，不得念不完。
- 人物、场景、道具名称只能使用 Bible 中的名称；不得在不同镜头随意改名。
- 同场人物运动方向、视线、光向和色温必须连续；需要越轴时在 end_state 中说明动机。
- dialogue 只放台词；sound 只放真正传递信息的画外声音；环境底噪不逐镜重复。
- speech、inner、voiceover、offscreen 四类台词必须区分；没有台词时 speaker 和 dialogue 为空。
- 每个角色必须有可冻结的脸型、发型、体型和服装；每个场景必须有空间结构与光位。
- state_before 必须继承上一镜 state_after；任何服装、伤势、道具归属或环境变化都必须在当前镜头 action 中有可见原因。
- value_score 为 0-100，叙事关键镜头、特效镜头和身份建立镜头应更高；model_requirement 必须说明质量档、参考图强度和运动强度。
- 先输出全量镜头，不能只输出示例镜头。
"""


def director_prompt(script: str, episode: int) -> str:
    return f"第 {episode} 集剧本如下。请生成完整生产设计。\n\n{script.strip()}"


def extract_json_object(text: str) -> dict[str, Any]:
    raw = str(text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
        raw = re.sub(r"\s*```$", "", raw)
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        start, end = raw.find("{"), raw.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("导演模型没有返回 JSON 对象")
        try:
            value = json.loads(raw[start : end + 1])
        except json.JSONDecodeError as exc:
            raise ValueError(f"导演模型 JSON 无法解析：{exc.msg}") from exc
    if not isinstance(value, dict):
        raise ValueError("导演模型返回的根节点必须是 JSON 对象")
    return value


def _text(value: Any, default: str = "") -> str:
    return str(value if value is not None else default).strip()


def _names(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        name = _text(item)
        if name and name not in result:
            result.append(name)
    return result


def _integer(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def normalize_design(raw: dict[str, Any]) -> dict[str, Any]:
    bible_raw = raw.get("bible") if isinstance(raw.get("bible"), dict) else {}
    groups: dict[str, list[dict[str, Any]]] = {}
    for key in ("characters", "locations", "props"):
        values = bible_raw.get(key) if isinstance(bible_raw, dict) else []
        groups[key] = [dict(item) for item in values or [] if isinstance(item, dict) and _text(item.get("name"))]
    for key, fallback in (("world", "世界观"), ("style", "全片风格")):
        value = bible_raw.get(key) if isinstance(bible_raw, dict) else None
        groups[key] = [dict(value)] if isinstance(value, dict) else []
        if groups[key] and not _text(groups[key][0].get("name")):
            groups[key][0]["name"] = fallback

    character_names = {_text(item.get("name")) for item in groups["characters"]}
    location_names = {_text(item.get("name")) for item in groups["locations"]}
    prop_names = {_text(item.get("name")) for item in groups["props"]}

    scenes: list[dict[str, Any]] = []
    for fallback_index, item in enumerate(raw.get("scenes") or [], 1):
        if not isinstance(item, dict):
            continue
        location = _text(item.get("location"), _text(item.get("heading"), f"场景{fallback_index}"))
        scene = {
            "index": fallback_index,
            "heading": _text(item.get("heading"), location),
            "location": location,
            "time_of_day": _text(item.get("time_of_day")),
            "summary": _text(item.get("summary")),
            "enter": _text(item.get("enter"), "cut") if _text(item.get("enter"), "cut") in {"cut", "fade", "dissolve"} else "cut",
        }
        scenes.append(scene)
        if location and location not in location_names:
            groups["locations"].append({"name": location, "appearance": "", "layout": "", "lighting": scene["time_of_day"], "negative": ""})
            location_names.add(location)
    if not scenes:
        raise ValueError("导演模型没有生成任何场次")

    scene_map = {scene["index"]: scene for scene in scenes}
    shots: list[dict[str, Any]] = []
    warnings: list[str] = []
    previous_scene = 0
    for index, item in enumerate(raw.get("shots") or [], 1):
        if not isinstance(item, dict):
            continue
        try:
            scene_index = int(item.get("scene_index") or 1)
        except (TypeError, ValueError):
            scene_index = 1
        if scene_index not in scene_map:
            warnings.append(f"第{index}镜引用了不存在的场次，已归入第1场")
            scene_index = 1
        scene = scene_map[scene_index]
        link = _text(item.get("link"), "cut")
        if link not in {"new-scene", "cut", "continuous"}:
            link = "cut"
        if not shots or scene_index != previous_scene:
            link = "new-scene"
        try:
            duration = max(2.0, min(12.0, float(item.get("duration") or 4)))
        except (TypeError, ValueError):
            duration = 4.0
        dialogue = _text(item.get("dialogue"))
        minimum_dialogue = len(re.sub(r"\s+", "", dialogue)) / 4.0 + (0.7 if dialogue else 0)
        if minimum_dialogue > duration:
            duration = min(12.0, round(minimum_dialogue, 1))
            warnings.append(f"第{index}镜已为台词自动延长到 {duration:g} 秒")
        characters = [name for name in _names(item.get("characters")) if not character_names or name in character_names]
        props = [name for name in _names(item.get("props")) if not prop_names or name in prop_names]
        direction = _text(item.get("screen_direction"), "unknown")
        if direction not in {"left", "right", "center", "unknown"}:
            direction = "unknown"
        phase = _text(item.get("action_phase"), "static")
        if phase not in {"anticipation", "start", "middle", "impact", "follow_through", "end", "settle", "static"}:
            phase = "static"
        action_id = _text(item.get("action_id"))
        if link == "continuous" and not action_id and shots:
            action_id = _text(shots[-1].get("continuity", {}).get("action_id"))
        momentum = _text(item.get("momentum"), "still").lower()
        if momentum not in {"left", "right", "up", "down", "forward", "back", "still"}:
            momentum = "still"
        line_kind = _text(item.get("line_kind"), "speech")
        if line_kind not in {"speech", "inner", "voiceover", "offscreen"}:
            line_kind = "speech"
        description = _text(item.get("description"), _text(item.get("action"), f"{scene['location']}镜头"))
        prompt = _text(item.get("prompt")) or "，".join(filter(None, [scene["location"], scene["time_of_day"], _text(item.get("shot_type"), "中景"), description, "电影级构图，保持冻结人物与场景设定"]))
        shots.append({
            "number": f"{index:03d}", "sequence": index, "scene_index": scene_index,
            "title": _text(item.get("title"), description[:24]), "description": description,
            "duration": f"{duration:.1f}s", "status": "待生成", "color": "#1C2027",
            "prompt": prompt, "shot_type": _text(item.get("shot_type"), "中景"),
            "camera": _text(item.get("camera"), "固定"), "action": _text(item.get("action")),
            "dialogue": dialogue, "characters": characters,
            "value_score": max(0, min(100, _integer(item.get("value_score"), 50))),
            "model_requirement": dict(item.get("model_requirement") or {}) if isinstance(item.get("model_requirement"), dict) else {},
            "continuity": {
                "scene": scene["location"], "time_of_day": scene["time_of_day"], "link": link,
                "speaker": _text(item.get("speaker")), "line_kind": line_kind, "sound": _text(item.get("sound")),
                "props": props, "screen_direction": direction, "action_id": action_id, "action_phase": phase, "momentum": momentum,
                "lighting": _text(item.get("lighting")), "end_state": _text(item.get("end_state")),
                "state_before": dict(item.get("state_before") or {}) if isinstance(item.get("state_before"), dict) else {},
                "state_after": dict(item.get("state_after") or {}) if isinstance(item.get("state_after"), dict) else {},
                "state_change_reason": _text(item.get("state_change_reason")),
            },
        })
        previous_scene = scene_index
    if not shots:
        raise ValueError("导演模型没有生成任何镜头")
    return {"logline": _text(raw.get("logline")), "bible": groups, "scenes": scenes, "shots": shots, "warnings": warnings}
