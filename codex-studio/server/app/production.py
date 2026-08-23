from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from .automation import STAGE_POLICIES
from .config import project_media_dir, settings
from .media import MediaError, extract_boundary_frames, probe_media


def _db() -> sqlite3.Connection:
    connection = sqlite3.connect(settings.database_path, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def _latest_bible(db: sqlite3.Connection, project_id: str) -> list[sqlite3.Row]:
    return db.execute(
        "SELECT * FROM bible_entities b WHERE project_id=? AND version=(SELECT MAX(version) FROM bible_entities x WHERE x.project_id=b.project_id AND x.entity_type=b.entity_type AND x.entity_key=b.entity_key) ORDER BY entity_type,name",
        (project_id,),
    ).fetchall()


def bible_context(db: sqlite3.Connection, project_id: str, shot: sqlite3.Row) -> tuple[str, list[str]]:
    names = set(json.loads(shot["characters_json"] or "[]"))
    scene = db.execute("SELECT heading,location,time_of_day FROM scenes WHERE id=?", (shot["scene_id"],)).fetchone() if shot["scene_id"] else None
    selected: list[dict[str, Any]] = []
    references: list[str] = []
    for row in _latest_bible(db, project_id):
        if row["entity_type"] == "character" and names and row["name"] not in names:
            continue
        if row["entity_type"] == "location" and scene and row["name"] not in {scene["location"], ""}:
            continue
        data = json.loads(row["data_json"] or "{}")
        selected.append({"type": row["entity_type"], "name": row["name"], "version": row["version"], "state": row["state"], "data": data})
        for value in json.loads(row["reference_assets_json"] or "[]"):
            path = str(value)
            if Path(path).is_file() and path not in references:
                references.append(path)
    scene_contract = {"heading": scene["heading"], "location": scene["location"], "time_of_day": scene["time_of_day"]} if scene else {}
    stage_layout: dict[str, Any] = {}
    if scene:
        layout = db.execute(
            "SELECT scene_key,version,layout_json,fingerprint FROM scene_layouts WHERE project_id=? AND scene_key IN (?,?) ORDER BY version DESC,id DESC LIMIT 1",
            (project_id, scene["heading"], scene["location"]),
        ).fetchone()
        if layout:
            stage_layout = {"scene_key": layout["scene_key"], "version": layout["version"], "layout": json.loads(layout["layout_json"] or "{}"), "fingerprint": layout["fingerprint"]}
    block = json.dumps({"scene": scene_contract, "frozen_bible": selected, "stage_layout": stage_layout}, ensure_ascii=False, separators=(",", ":"))
    return f"\n\n【强制连续性设定】{block}\n必须严格保持人物脸型、发型、服装、体型、场景结构、道具位置、光向和色温；不得自行改变版本。", references


def _queue(db: sqlite3.Connection, run_id: int, project_id: str, task_type: str, provider: str, stage: str, payload: dict[str, Any], priority: int = 50) -> int:
    cursor = db.execute(
        "INSERT INTO tasks(project_id,task_type,provider,payload_json,priority,max_attempts,automation_run_id,stage) VALUES(?,?,?,?,?,3,?,?)",
        (project_id, task_type, provider, json.dumps(payload, ensure_ascii=False), priority, run_id, stage),
    )
    return int(cursor.lastrowid)


def _shot_rows(db: sqlite3.Connection, project_id: str, episode: int) -> list[sqlite3.Row]:
    return db.execute("SELECT * FROM shots WHERE project_id=? AND episode=? ORDER BY sequence,id", (project_id, episode)).fetchall()


def start_automation(project_id: str, config: dict[str, Any]) -> dict[str, Any]:
    episode = int(config.get("episode", 1))
    with _db() as db:
        if db.execute("SELECT 1 FROM automation_runs WHERE project_id=? AND status IN ('queued','running')", (project_id,)).fetchone():
            raise RuntimeError("当前项目已有自动生产任务在执行")
        shots = _shot_rows(db, project_id, episode)
        if not shots:
            raise RuntimeError("请先完成剧本解析并生成全量分镜")
        if config.get("auto_freeze_bible", True):
            latest_ids = [row["id"] for row in _latest_bible(db, project_id)]
            if latest_ids:
                marks = ",".join("?" for _ in latest_ids)
                db.execute(f"UPDATE bible_entities SET state='frozen' WHERE id IN ({marks})", latest_ids)
        cursor = db.execute(
            "INSERT INTO automation_runs(project_id,episode,mode,status,stage,progress,config_json,checkpoint_json) VALUES(?,?,?,'running','prepare',1,?,'{}')",
            (project_id, episode, config.get("mode", "balanced"), json.dumps(config, ensure_ascii=False)),
        )
        run_id = int(cursor.lastrowid)
        if config.get("generate_images", True):
            _queue_keyframes(db, run_id, project_id, shots, config, "keyframes")
            stage = "keyframes"
        else:
            _queue_videos(db, run_id, project_id, shots, config)
            stage = "videos"
        db.execute("UPDATE automation_runs SET stage=?,progress=5,updated_at=CURRENT_TIMESTAMP WHERE id=?", (stage, run_id))
    return {"id": run_id, "project_id": project_id, "episode": episode, "status": "running", "stage": stage, "shot_count": len(shots)}


def _queue_keyframes(db: sqlite3.Connection, run_id: int, project_id: str, shots: list[sqlite3.Row], config: dict[str, Any], stage: str, only_ids: set[int] | None = None, repair_notes: dict[int, list[Any]] | None = None) -> None:
    for shot in shots:
        if only_ids is not None and int(shot["id"]) not in only_ids:
            continue
        memory, references = bible_context(db, project_id, shot)
        notes = list((repair_notes or {}).get(int(shot["id"]), []))
        repair = f"\n\n【上一版质检失败，必须逐项修复】{json.dumps(notes, ensure_ascii=False)}" if notes else ""
        payload = {"project_id": project_id, "episode": shot["episode"], "shot_id": shot["id"], "shot_number": shot["number"],
                   "prompt": (shot["prompt"] or shot["description"]) + memory + repair, "model": config.get("image_model"), "reference_paths": references,
                   "options": {"size": "1024x1536" if int(config.get("height", 1080)) > int(config.get("width", 1920)) else "1536x1024", "quality": "high"}}
        _queue(db, run_id, project_id, "image", config["image_provider"], stage, payload, 80)


def _latest_shot_asset(db: sqlite3.Connection, shot_id: int, role: str) -> sqlite3.Row | None:
    return db.execute("SELECT a.* FROM assets a JOIN shot_assets sa ON sa.asset_id=a.id WHERE sa.shot_id=? AND sa.role=? AND a.status='ready' ORDER BY a.id DESC LIMIT 1", (shot_id, role)).fetchone()


def _queue_reviews(db: sqlite3.Connection, run_id: int, project_id: str, shots: list[sqlite3.Row], config: dict[str, Any]) -> int:
    provider = config.get("quality_provider")
    if not provider:
        return 0
    count = 0
    for shot in shots:
        asset = _latest_shot_asset(db, int(shot["id"]), "image")
        if not asset:
            continue
        memory, bible_references = bible_context(db, project_id, shot)
        payload = {"project_id": project_id, "episode": shot["episode"], "shot_id": shot["id"], "shot_number": shot["number"],
                   "prompt": f"审核此分镜关键帧与分镜描述、冻结设定的一致性。分镜：{shot['description']} {memory}",
                   "reference_paths": [asset["local_path"], *bible_references[:2]], "options": {"threshold": STAGE_POLICIES[config.get('mode', 'balanced')]["consistency_threshold"]}}
        _queue(db, run_id, project_id, "vision_review", provider, "keyframe_review", payload, 70)
        count += 1
    return count


def _queue_videos(db: sqlite3.Connection, run_id: int, project_id: str, shots: list[sqlite3.Row], config: dict[str, Any]) -> None:
    for shot in shots:
        memory, references = bible_context(db, project_id, shot)
        keyframe = _latest_shot_asset(db, int(shot["id"]), "image")
        if keyframe and keyframe["local_path"]:
            references = [keyframe["local_path"]]
        duration = max(3, min(12, round(_duration_seconds(shot["duration"]))))
        payload = {"project_id": project_id, "episode": shot["episode"], "shot_id": shot["id"], "shot_number": shot["number"],
                   "prompt": (shot["prompt"] or shot["description"]) + memory + f"\n动作连续要求：{shot['action']}", "model": config.get("video_model"),
                   "reference_paths": references[:1], "options": {"duration": duration, "seconds": duration, "resolution": "1080P" if int(config.get("height", 1080)) >= 1080 else "720P", "size": f"{config.get('width',1920)}x{config.get('height',1080)}", "prompt_extend": True, "watermark": False}}
        _queue(db, run_id, project_id, "video", config["video_provider"], "videos", payload, 60)


def _queue_voices(db: sqlite3.Connection, run_id: int, project_id: str, shots: list[sqlite3.Row], config: dict[str, Any]) -> int:
    provider = config.get("voice_provider")
    if not provider or not config.get("generate_voice", True):
        return 0
    count = 0
    for shot in shots:
        if not str(shot["dialogue"] or "").strip():
            continue
        voice, instructions = "alloy", "自然影视对白，情绪符合剧情，避免播音腔"
        character_names = list(json.loads(shot["characters_json"] or "[]"))
        if character_names:
            entity = next((item for item in _latest_bible(db, project_id) if item["entity_type"] == "character" and item["name"] == character_names[0]), None)
            if entity:
                profile = json.loads(entity["data_json"] or "{}")
                voice = str(profile.get("voice") or voice)
                instructions = str(profile.get("voice_prompt") or instructions)
        payload = {"project_id": project_id, "episode": shot["episode"], "shot_id": shot["id"], "shot_number": shot["number"],
                   "prompt": shot["dialogue"], "model": config.get("voice_model"), "options": {"voice": voice, "instructions": instructions}}
        _queue(db, run_id, project_id, "voice", provider, "voice", payload, 45)
        count += 1
    return count


def _queue_bridges(db: sqlite3.Connection, run_id: int, project_id: str, shots: list[sqlite3.Row], config: dict[str, Any]) -> int:
    if not config.get("generate_bridges", True) or config.get("video_provider") != "dashscope":
        return 0
    count = 0
    for left, right in zip(shots, shots[1:]):
        if not left["scene_id"] or left["scene_id"] != right["scene_id"]:
            continue
        left_asset = _latest_shot_asset(db, int(left["id"]), "video")
        right_asset = _latest_shot_asset(db, int(right["id"]), "video")
        if not left_asset or not right_asset:
            continue
        try:
            first, last = extract_boundary_frames(left_asset["local_path"], right_asset["local_path"], project_id, f"{left['number']}-{right['number']}")
        except MediaError:
            continue
        prompt = f"生成连接镜头 {left['number']} 与 {right['number']} 的短转场。上一镜结束动作：{left['action']}。下一镜开始动作：{right['action']}。保持同一人物、服装、场景、光照和运动方向，禁止新增人物或改变构图关系。"
        payload = {"project_id": project_id, "episode": left["episode"], "shot_number": f"{left['number']}→{right['number']}", "bridge_after_shot_id": left["id"], "bridge_before_shot_id": right["id"],
                   "prompt": prompt, "model": config.get("video_model"), "reference_paths": [first, last], "options": {"duration": 5, "resolution": "720P", "prompt_extend": True, "watermark": False}}
        _queue(db, run_id, project_id, "video", config["video_provider"], "bridges", payload, 55)
        count += 1
    return count


def _duration_seconds(value: str) -> float:
    try:
        return float(str(value).lower().replace("seconds", "").replace("second", "").replace("s", "").strip())
    except ValueError:
        return 3.0


def _srt_time(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"


def _assemble(db: sqlite3.Connection, run_id: int, project_id: str, shots: list[sqlite3.Row], config: dict[str, Any]) -> None:
    episode = int(config.get("episode", 1))
    db.execute("DELETE FROM timeline_clips WHERE project_id=? AND episode=?", (project_id, episode))
    elapsed = 0.0
    subtitles: list[str] = []
    bridge_rows = db.execute("SELECT result_json,payload_json FROM tasks WHERE automation_run_id=? AND stage='bridges' AND status='completed' ORDER BY id", (run_id,)).fetchall()
    bridges: dict[int, dict[str, Any]] = {}
    for row in bridge_rows:
        result, payload = json.loads(row["result_json"] or "{}"), json.loads(row["payload_json"] or "{}")
        if result.get("output_path") and payload.get("bridge_after_shot_id"):
            bridges[int(payload["bridge_after_shot_id"])] = {"path": result["output_path"], "asset_id": result.get("asset_id"), "title": payload.get("shot_number", "AI转场")}
    position = 0
    for shot_index, shot in enumerate(shots):
        video = _latest_shot_asset(db, int(shot["id"]), "video")
        if not video:
            continue
        try:
            duration = float(probe_media(video["local_path"])["duration"])
        except (MediaError, OSError, ValueError):
            duration = _duration_seconds(shot["duration"])
        transition = "dissolve" if shot_index > 0 and shot["scene_id"] == shots[shot_index - 1]["scene_id"] and int(shots[shot_index - 1]["id"]) not in bridges else "cut"
        db.execute("INSERT INTO timeline_clips(project_id,episode,track,position,asset_id,source_path,title,duration,transition,transition_duration,metadata_json) VALUES(?,?,'V1',?,?,?,?,?,?,0.35,?)",
                   (project_id, episode, position, video["id"], video["local_path"], f"{shot['number']} · {shot['title']}", duration, transition, json.dumps({"shot_id": shot["id"], "start_seconds": elapsed})))
        voice = _latest_shot_asset(db, int(shot["id"]), "voice")
        if voice:
            db.execute("INSERT INTO timeline_clips(project_id,episode,track,position,asset_id,source_path,title,duration,volume,metadata_json) VALUES(?,?,'A1',?,?,?,?,?,1,?)",
                       (project_id, episode, position, voice["id"], voice["local_path"], f"对白 {shot['number']}", duration, json.dumps({"shot_id": shot["id"], "start_seconds": elapsed})))
        dialogue = str(shot["dialogue"] or "").strip()
        if dialogue:
            subtitles.extend([str(len(subtitles) // 4 + 1), f"{_srt_time(elapsed)} --> {_srt_time(elapsed + duration)}", dialogue, ""])
        elapsed += duration - (0.35 if transition == "dissolve" else 0)
        position += 1
        bridge = bridges.get(int(shot["id"]))
        if bridge:
            try: bridge_duration = float(probe_media(bridge["path"])["duration"])
            except (MediaError, OSError, ValueError): bridge_duration = 5.0
            db.execute("INSERT INTO timeline_clips(project_id,episode,track,position,asset_id,source_path,title,duration,transition,transition_duration,metadata_json) VALUES(?,?,'V1',?,?,?,?,?,'cut',0,?)",
                       (project_id, episode, position, bridge["asset_id"], bridge["path"], f"AI首尾帧桥接 {bridge['title']}", bridge_duration, json.dumps({"bridge_after_shot_id": shot["id"], "start_seconds": elapsed})))
            elapsed += bridge_duration
            position += 1
    if subtitles:
        folder = project_media_dir(project_id) / "generated"
        folder.mkdir(parents=True, exist_ok=True)
        subtitle_path = folder / f"episode-{episode}-auto.srt"
        subtitle_path.write_text("\n".join(subtitles), encoding="utf-8-sig")
        cursor = db.execute("INSERT INTO assets(project_id,asset_type,name,episode,local_path,mime_type,source_kind,status) VALUES(?,'subtitle',?,?,?,'application/x-subrip','generated','ready')", (project_id, f"第{episode}集自动字幕", episode, str(subtitle_path)))
        db.execute("INSERT INTO timeline_clips(project_id,episode,track,position,asset_id,source_path,title,duration,metadata_json) VALUES(?,?,'T1',0,?,?,?,?,'{}')", (project_id, episode, cursor.lastrowid, str(subtitle_path), f"第{episode}集字幕", elapsed))
    export_payload = {"episode": episode, "width": config.get("width", 1920), "height": config.get("height", 1080), "fps": config.get("fps", 24), "quality": config.get("quality", "high"), "burn_subtitles": True, "output_name": config.get("output_name", f"第{episode}集-自动成片.mp4")}
    _queue(db, run_id, project_id, "timeline_export", "ffmpeg", "export", export_payload, 100)


def advance_automation(run_id: int) -> None:
    with _db() as db:
        run = db.execute("SELECT * FROM automation_runs WHERE id=?", (run_id,)).fetchone()
        if not run or run["status"] not in {"queued", "running"} or run["cancel_requested"]:
            return
        stage = run["stage"]
        tasks = db.execute("SELECT status,result_json,payload_json,error_message FROM tasks WHERE automation_run_id=? AND stage=?", (run_id, stage)).fetchall()
        if tasks and any(row["status"] in {"queued", "running", "retry_wait"} for row in tasks):
            return
        if any(row["status"] in {"failed", "canceled"} for row in tasks):
            errors = [row["status"] for row in tasks].count("failed")
            details = "；".join(dict.fromkeys(str(row["error_message"] or "") for row in tasks if row["status"] == "failed" and row["error_message"]))[:1800]
            message = f"{stage} 阶段有 {errors} 个任务失败" + (f"：{details}" if details else "")
            db.execute("UPDATE automation_runs SET status='failed',error_message=?,updated_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP WHERE id=?", (message, run_id))
            return
        config = json.loads(run["config_json"] or "{}")
        shots = _shot_rows(db, run["project_id"], run["episode"])
        next_stage = stage
        progress = run["progress"]
        if stage == "keyframes":
            if _queue_reviews(db, run_id, run["project_id"], shots, config):
                next_stage, progress = "keyframe_review", 25
            else:
                _queue_videos(db, run_id, run["project_id"], shots, config); next_stage, progress = "videos", 35
        elif stage == "keyframe_review":
            threshold = STAGE_POLICIES[config.get("mode", "balanced")]["consistency_threshold"]
            low: set[int] = set()
            repair_notes: dict[int, list[Any]] = {}
            for row in tasks:
                result, payload = json.loads(row["result_json"] or "{}"), json.loads(row["payload_json"] or "{}")
                if int(result.get("score", 100)) < threshold:
                    shot_id = int(payload["shot_id"])
                    low.add(shot_id)
                    repair_notes[shot_id] = list(result.get("findings") or [])
            if low and config.get("auto_repair", True):
                _queue_keyframes(db, run_id, run["project_id"], shots, config, "keyframe_repairs", low, repair_notes); next_stage, progress = "keyframe_repairs", 30
            else:
                _queue_videos(db, run_id, run["project_id"], shots, config); next_stage, progress = "videos", 35
        elif stage == "keyframe_repairs":
            _queue_videos(db, run_id, run["project_id"], shots, config); next_stage, progress = "videos", 40
        elif stage == "videos":
            bridges = _queue_bridges(db, run_id, run["project_id"], shots, config)
            if bridges:
                next_stage, progress = "bridges", 65
                db.execute("UPDATE automation_runs SET stage=?,progress=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (next_stage, progress, run_id))
                return
            count = _queue_voices(db, run_id, run["project_id"], shots, config)
            if count:
                next_stage, progress = "voice", 72
            else:
                _assemble(db, run_id, run["project_id"], shots, config); next_stage, progress = "export", 85
        elif stage == "bridges":
            count = _queue_voices(db, run_id, run["project_id"], shots, config)
            if count:
                next_stage, progress = "voice", 72
            else:
                _assemble(db, run_id, run["project_id"], shots, config); next_stage, progress = "export", 85
        elif stage == "voice":
            _assemble(db, run_id, run["project_id"], shots, config); next_stage, progress = "export", 85
        elif stage == "export":
            output = next((json.loads(row["result_json"] or "{}").get("output_path") for row in tasks if row["status"] == "completed"), "")
            db.execute("UPDATE automation_runs SET status='completed',stage='completed',progress=100,checkpoint_json=?,updated_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP WHERE id=?", (json.dumps({"output_path": output}, ensure_ascii=False), run_id))
            return
        db.execute("UPDATE automation_runs SET stage=?,progress=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (next_stage, progress, run_id))


def serialize_run(row: sqlite3.Row) -> dict[str, Any]:
    result = dict(row)
    result["config"] = json.loads(result.pop("config_json") or "{}")
    result["checkpoint"] = json.loads(result.pop("checkpoint_json") or "{}")
    result["cancel_requested"] = bool(result["cancel_requested"])
    return result
