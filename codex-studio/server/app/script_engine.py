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
MARKUP_SEPARATOR = re.compile(r"^\s*(?:-{3,}|_{3,}|\*{3,})\s*$")
TIMECODE = re.compile(
    r"[\[\(（]?\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*[-–—~至]\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*[\]\)）]?"
)
PRODUCTION_LABEL = re.compile(r"^(?:画面|细节|动作|环境|人物|镜头|说明|对白|音效|声音)\s*[:：]\s*(.*)$", re.IGNORECASE)
NON_CHARACTER_LABELS = {"画面", "细节", "动作", "环境", "人物", "镜头", "说明", "对白", "音效", "声音", "旁白", "字幕", "场景"}


@dataclass(frozen=True)
class ParsedScene:
    sequence: int
    heading: str
    location: str
    time_of_day: str
    source_text: str
    summary: str


def _clean_line(line: str) -> str:
    value = line.strip().lstrip("\ufeff")
    if not value or MARKUP_SEPARATOR.match(value) or value.startswith("```"):
        return ""
    value = value.replace("**", "").replace("__", "").replace("`", "")
    value = re.sub(r"^\s*[#>]+\s*", "", value)
    value = re.sub(r"^\s*[-*+]\s+", "", value)
    value = TIMECODE.sub("", value, count=1)
    return re.sub(r"\s+", " ", value).strip(" —-")


def _clean_lines(text: str) -> list[str]:
    return [_clean_line(line) for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]


def _shot_blocks(text: str) -> list[str]:
    raw_lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    production_mode = any(TIMECODE.search(line) or PRODUCTION_LABEL.match(_clean_line(line)) for line in raw_lines)
    if not production_mode:
        return [line for line in _clean_lines(text) if line]
    blocks: list[str] = []
    for raw in raw_lines:
        has_timecode = bool(TIMECODE.search(raw))
        line = _clean_line(raw)
        if not line:
            continue
        label = PRODUCTION_LABEL.match(line)
        content = (label.group(1) if label else line).strip()
        if not content:
            continue
        starts_shot = has_timecode or bool(label and line.startswith("画面")) or not blocks
        if starts_shot:
            blocks.append(content)
        else:
            blocks[-1] = f"{blocks[-1]}；{content}"
    return blocks


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
        if match:
            name = match.group(1).strip()
            if name not in NON_CHARACTER_LABELS and name not in ordered:
                ordered.append(name)
    return ordered


def _shot_type(text: str, index: int) -> str:
    for hint, value in CAMERA_HINTS.items():
        if hint in text:
            return value
    return "全景" if index == 0 else ("近景" if DIALOGUE.match(text) else "中景")


def scene_to_shots(scene: ParsedScene, global_start: int) -> list[dict]:
    blocks = _shot_blocks(scene.source_text)
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
