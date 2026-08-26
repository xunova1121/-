"""镜间连续性规则：区分换场、剪辑切换和连续动作。"""
from typing import Any

LINKS = {"new-scene", "cut", "continuous"}


def same_scene(left: str | None, right: str | None) -> bool:
    a, b = (left or "").strip(), (right or "").strip()
    return bool(a and b and (a == b or a in b or b in a))


def derive_link(shot: dict[str, Any], previous: dict[str, Any] | None) -> str:
    if shot.get("link") in LINKS:
        return shot["link"]
    if not previous or not same_scene(previous.get("scene"), shot.get("scene")):
        return "new-scene"
    return "cut"


def continuity_constraints(shot: dict[str, Any], previous: dict[str, Any] | None, next_shot: dict[str, Any] | None = None) -> list[str]:
    link = derive_link(shot, previous)
    lines: list[str] = []
    if link == "continuous" and previous:
        lines += ["从上一镜结束状态继续，不要重新起势", "运动速度与上一镜一致，不要突然加快或放慢"]
    elif link == "cut" and previous:
        lines += ["保持运动方向与视线方向，不要越轴", "光线、天气、时间和环境陈设保持一致"]
    if next_shot and link != "new-scene":
        lines.append("结尾停在能够承接下一镜动作的状态")
    return lines


def analyze_pair(previous: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    link = derive_link(current, previous)
    findings: list[dict[str, str]] = []
    if link != "new-scene" and previous.get("screen_direction") and current.get("screen_direction") and previous["screen_direction"] != current["screen_direction"]:
        findings.append({"type": "axis", "severity": "warning", "message": "人物运动方向发生反转，可能越轴"})
    if link != "new-scene" and previous.get("lighting") and current.get("lighting") and previous["lighting"] != current["lighting"]:
        findings.append({"type": "lighting", "severity": "warning", "message": "相邻镜头光照状态不一致"})
    return {"link": link, "constraints": continuity_constraints(current, previous), "findings": findings, "score": max(0, 100 - len(findings) * 15)}

