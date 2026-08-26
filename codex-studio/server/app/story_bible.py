import hashlib
import json
from typing import Any


def fingerprint(data: dict[str, Any], reference_assets: list[str]) -> str:
    canonical = json.dumps({"data": data, "refs": sorted(reference_assets)}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def continuity_contract(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, str]], int]:
    contract = {
        "action": payload.get("action_state", {}),
        "props": payload.get("prop_state", {}),
        "environment": payload.get("environment_state", {}),
        "camera": payload.get("camera_state", {}),
    }
    findings: list[dict[str, str]] = []
    action = contract["action"]
    if payload.get("relation") == "continuous" and not action.get("end_pose"):
        findings.append({"type": "action", "severity": "blocking", "message": "连续动作缺少上一镜结束姿态"})
    props = contract["props"]
    if props.get("before") is not None and props.get("after") is not None and props["before"] != props["after"] and not props.get("change_reason"):
        findings.append({"type": "prop", "severity": "warning", "message": "道具状态变化但没有剧情原因"})
    camera = contract["camera"]
    if camera.get("from_direction") and camera.get("to_direction") and camera["from_direction"] != camera["to_direction"] and not camera.get("axis_break_intentional"):
        findings.append({"type": "axis", "severity": "warning", "message": "运动方向反转，可能越轴"})
    score = max(0, 100 - sum(25 if item["severity"] == "blocking" else 12 for item in findings))
    return contract, findings, score


def episode_snapshot(shots: list[dict[str, Any]], bible: list[dict[str, Any]], contracts: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "shots": shots,
        "bible_fingerprints": {f"{item['entity_type']}:{item['entity_key']}": item["fingerprint"] for item in bible},
        "contracts": contracts,
        "shot_count": len(shots),
        "ready": bool(shots) and all(item.get("status") != "draft" for item in bible),
    }

