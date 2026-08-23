from __future__ import annotations

import re
from dataclasses import dataclass


SCENE_HEADING = re.compile(
    r"^(?:第\s*[一二三四五六七八九十百零〇0-9]+\s*场|场景\s*[一二三四五六七八九十百零〇0-9]*|(?:INT|EXT|内景|外景)[.．\s])",
    re.IGNORECASE,
)
DIALOGUE = re.compile(r"^([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9·]{0,11})\s*[：:]\s*(.+)$")
TIME_WORDS = ("清晨", "早晨", "上午", "中午", "下午", "傍晚", "黄昏", "夜", "深夜", "凌晨", "白天")
CAMERA_HINTS = {
    "特写": "特写", "近景": "近景", "中景": "中景", "全景": "全景", "远景": "远景",
    "俯拍": "俯拍", "仰拍": "仰拍", "航拍": "航拍",
}


@dataclass(frozen=True)
class ParsedScene:
    sequence: int
    heading: str
    location: str
    time_of_day: str
    source_text: str
    summary: str


def _clean_lines(text: str) -> list[str]:
    return [re.sub(r"\s+", " ", line).strip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]


def parse_scenes(text: str) -> list[ParsedScene]:
    lines = _clean_lines(text)
    groups: list[tuple[str, list[str]]] = []
    heading = "场景 1"
    body: list[str] = []
    for line in lines:
        if not line:
            continue
        if SCENE_HEADING.match(line):
            if body or groups:
                groups.append((heading, body))
            heading, body = line, []
        else:
            body.append(line)
    if body or not groups:
        groups.append((heading, body))

    scenes: list[ParsedScene] = []
    for index, (scene_heading, scene_lines) in enumerate(groups, 1):
        time_of_day = next((word for word in TIME_WORDS if word in scene_heading), "")
        location = re.sub(r"^(第\s*\S+\s*场|场景\s*\S*|INT[.．\s]*|EXT[.．\s]*|内景[.．\s]*|外景[.．\s]*)", "", scene_heading, flags=re.IGNORECASE)
        location = re.split(r"[-—－/]", location)[0].strip(" ：:.-") or scene_heading
        source = "\n".join(scene_lines).strip()
        summary = next((line for line in scene_lines if not DIALOGUE.match(line)), source[:80])[:120]
        scenes.append(ParsedScene(index, scene_heading, location, time_of_day, source, summary))
    return scenes


def extract_characters(text: str) -> list[str]:
    ordered: list[str] = []
    for line in _clean_lines(text):
        match = DIALOGUE.match(line)
        if match and match.group(1) not in ordered:
            ordered.append(match.group(1))
    return ordered


def _shot_type(text: str, index: int) -> str:
    for hint, value in CAMERA_HINTS.items():
        if hint in text:
            return value
    return "全景" if index == 0 else ("近景" if DIALOGUE.match(text) else "中景")


def scene_to_shots(scene: ParsedScene, global_start: int) -> list[dict]:
    blocks = [line for line in _clean_lines(scene.source_text) if line]
    if not blocks:
        blocks = [f"建立{scene.location}的环境与空间关系"]
    result: list[dict] = []
    for index, block in enumerate(blocks):
        dialogue_match = DIALOGUE.match(block)
        characters = [dialogue_match.group(1)] if dialogue_match else []
        dialogue = dialogue_match.group(2) if dialogue_match else ""
        action = "" if dialogue_match else block
        shot_type = _shot_type(block, index)
        number = f"{global_start + index:03d}"
        description = dialogue and f"{characters[0]}说：{dialogue}" or action
        prompt = "，".join(part for part in [scene.location, scene.time_of_day, shot_type, description, "电影级构图，角色与场景保持一致"] if part)
        result.append({
            "number": number, "title": description[:24] or scene.heading, "description": description,
            "duration": "3.0s" if not dialogue else f"{max(3.0, min(8.0, len(dialogue) / 4.0)):.1f}s",
            "status": "待生成", "color": "#1C2027", "prompt": prompt,
            "shot_type": shot_type, "camera": "固定", "action": action, "dialogue": dialogue,
            "characters": characters,
            "continuity": {"scene": scene.location, "time_of_day": scene.time_of_day, "action_phase": "static"},
        })
    return result
