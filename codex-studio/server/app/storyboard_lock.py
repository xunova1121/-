from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from typing import Any


def _json(value: str | None, fallback: Any) -> Any:
    try:
        return json.loads(value or "")
    except (TypeError, json.JSONDecodeError):
        return fallback


def _duration_seconds(value: str) -> float:
    match = re.search(r"\d+(?:\.\d+)?", value or "")
    return float(match.group(0)) if match else 0.0


def build_snapshot(db: sqlite3.Connection, project_id: str, episode: int) -> tuple[dict[str, Any], list[str]]:
    """Build the canonical, billable-production contract for one episode."""
    script = db.execute(
        "SELECT checksum,parse_status FROM episode_scripts WHERE project_id=? AND episode=?",
        (project_id, episode),
    ).fetchone()
    shot_rows = db.execute(
        "SELECT id,number,sequence,title,description,duration,prompt,shot_type,camera,action,dialogue,characters_json,continuity_json,value_score,model_requirement_json "
        "FROM shots WHERE project_id=? AND episode=? ORDER BY sequence,id",
        (project_id, episode),
    ).fetchall()
    bible_rows = db.execute(
        "SELECT entity_type,entity_key,name,version,state,data_json,reference_assets_json,fingerprint FROM bible_entities b WHERE project_id=? "
        "AND version=(SELECT MAX(version) FROM bible_entities x WHERE x.project_id=b.project_id AND x.entity_type=b.entity_type AND x.entity_key=b.entity_key) "
        "ORDER BY entity_type,entity_key",
        (project_id,),
    ).fetchall()
    contract_rows = db.execute(
        "SELECT from_shot,to_shot,relation,score,contract_json,findings_json FROM continuity_contracts "
        "WHERE project_id=? AND episode=? ORDER BY from_shot,to_shot",
        (project_id, episode),
    ).fetchall()
    conflict_count = int(db.execute(
        "SELECT COUNT(*) FROM shot_state_snapshots WHERE project_id=? AND episode=? AND conflicts_json<>'[]'",
        (project_id, episode),
    ).fetchone()[0])

    shots = [{
        "id": int(row["id"]), "number": row["number"], "sequence": int(row["sequence"]),
        "title": row["title"], "description": row["description"], "duration": row["duration"],
        "prompt": row["prompt"], "shot_type": row["shot_type"], "camera": row["camera"],
        "action": row["action"], "dialogue": row["dialogue"],
        "characters": _json(row["characters_json"], []), "continuity": _json(row["continuity_json"], {}),
        "value_score": int(row["value_score"] or 0), "model_requirement": _json(row["model_requirement_json"], {}),
    } for row in shot_rows]
    bible = [{
        "entity_type": row["entity_type"], "entity_key": row["entity_key"], "name": row["name"],
        "version": int(row["version"]), "state": row["state"], "data": _json(row["data_json"], {}),
        "reference_assets": _json(row["reference_assets_json"], []), "fingerprint": row["fingerprint"],
    } for row in bible_rows]
    contracts = [{
        "from_shot": row["from_shot"], "to_shot": row["to_shot"], "relation": row["relation"],
        "score": int(row["score"]), "contract": _json(row["contract_json"], {}),
        "findings": _json(row["findings_json"], []),
    } for row in contract_rows]

    issues: list[str] = []
    if not shots:
        issues.append("本集尚无分镜")
    numbers = [str(item["number"]).strip() for item in shots]
    if len(numbers) != len(set(numbers)):
        issues.append("存在重复镜号")
    for shot in shots:
        label = f"镜头 {shot['number']}"
        if not str(shot["title"]).strip():
            issues.append(f"{label}缺少标题")
        if not any(str(shot[key]).strip() for key in ("description", "action", "dialogue")):
            issues.append(f"{label}缺少画面、动作或对白")
        if _duration_seconds(str(shot["duration"])) <= 0:
            issues.append(f"{label}时长无效")
    draft_bible = [row["name"] for row in bible if row["state"] != "frozen"]
    if draft_bible:
        issues.append("设定集尚未冻结：" + "、".join(draft_bible[:8]))
    incomplete_characters = [row["name"] for row in bible if row["entity_type"] == "character" and not row["data"] and not row["reference_assets"]]
    if incomplete_characters:
        issues.append("人物设定尚未完善：" + "、".join(incomplete_characters[:8]))
    blocking_contracts = [row for row in contracts if row["score"] < 70 or any(item.get("severity") == "blocking" for item in row["findings"])]
    if blocking_contracts:
        issues.append(f"存在 {len(blocking_contracts)} 个镜间连续性阻断")
    if conflict_count:
        issues.append(f"存在 {conflict_count} 个故事状态冲突")

    core = {
        "schema_version": "1.0", "project_id": project_id, "episode": episode,
        "script_checksum": script["checksum"] if script else "",
        "script_parse_status": script["parse_status"] if script else "empty",
        "shots": shots, "bible": bible, "contracts": contracts,
        "shot_count": len(shots), "state_conflicts": conflict_count,
    }
    canonical = json.dumps(core, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    core["fingerprint"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return core, issues


def status(db: sqlite3.Connection, project_id: str, episode: int) -> dict[str, Any]:
    current, issues = build_snapshot(db, project_id, episode)
    # The lock action itself freezes the latest complete Bible versions. Draft
    # state alone is therefore advisory; incomplete content remains blocking.
    ready_to_lock = not [item for item in issues if not item.startswith("设定集尚未冻结：")]
    row = db.execute(
        "SELECT revision,status,snapshot_json,locked_at FROM episode_locks WHERE project_id=? AND episode=?",
        (project_id, episode),
    ).fetchone()
    if not row or row["status"] != "locked":
        return {
            "project_id": project_id, "episode": episode, "status": "draft", "revision": int(row["revision"]) if row else 0,
            "locked_at": None, "shot_count": current["shot_count"], "ready_to_lock": ready_to_lock,
            "issues": issues, "fingerprint": current["fingerprint"],
        }
    saved = _json(row["snapshot_json"], {})
    stale = saved.get("fingerprint") != current["fingerprint"]
    return {
        "project_id": project_id, "episode": episode, "status": "stale" if stale else "locked",
        "revision": int(row["revision"]), "locked_at": row["locked_at"], "shot_count": current["shot_count"],
        "ready_to_lock": ready_to_lock, "issues": issues + (["剧本、设定、连续性或分镜已在锁定后修改"] if stale else []),
        "fingerprint": current["fingerprint"], "locked_fingerprint": saved.get("fingerprint", ""),
    }
