import hashlib
import json
import math
from typing import Any


def normalize_angle(value: float) -> float:
    return (float(value) + 180.0) % 360.0 - 180.0


def bearing(start: dict[str, float], end: dict[str, float]) -> float:
    dx, dy = end["x"] - start["x"], end["y"] - start["y"]
    return math.degrees(math.atan2(dx, -dy))


def stage_fingerprint(layout: dict[str, Any]) -> str:
    canonical = json.dumps(layout, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def project_to_screen(camera: dict[str, Any], point: dict[str, float]) -> float | None:
    aim = bearing(camera["position"], camera["target"])
    target_bearing = bearing(camera["position"], point)
    offset = normalize_angle(target_bearing - aim)
    if abs(offset) >= 89:
        return None
    half_fov = math.atan(36.0 / 2.0 / float(camera.get("lens_mm", 35)))
    return round(math.tan(math.radians(offset)) / math.tan(half_fov), 4)


def analyze_stage(layout: dict[str, Any], previous: dict[str, Any] | None = None) -> dict[str, Any]:
    camera = layout["camera"]
    aim = bearing(camera["position"], camera["target"])
    subjects = []
    findings = []
    for subject in layout.get("subjects", []):
        screen_x = project_to_screen(camera, subject["position"])
        subjects.append({"entity_key": subject["entity_key"], "screen_x": screen_x, "visible": screen_x is not None and abs(screen_x) <= 1.2})
        if screen_x is None or abs(screen_x) > 1.2:
            findings.append({"type": "framing", "severity": "warning", "message": f"{subject['entity_key']} 位于画外"})
    if previous:
        prev_cam = previous["camera"]
        prev_aim = bearing(prev_cam["position"], prev_cam["target"])
        if abs(normalize_angle(aim - prev_aim)) > 150 and layout.get("scene_key") == previous.get("scene_key"):
            findings.append({"type": "axis", "severity": "warning", "message": "相邻机位可能跨越180度轴线"})
    light = None
    if layout.get("sun_bearing_deg") is not None:
        relative = normalize_angle(float(layout["sun_bearing_deg"]) - aim)
        kind = "逆光" if abs(relative) <= 35 else "顺光" if abs(relative) >= 145 else "侧光"
        light = {"kind": kind, "relative_deg": round(relative, 1), "elevation": layout.get("sun_elevation", "mid")}
    return {"camera_bearing": round(aim, 2), "subjects": subjects, "light": light, "findings": findings, "score": max(0, 100 - len(findings) * 15)}

