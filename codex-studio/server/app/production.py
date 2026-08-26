from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from .automation import STAGE_POLICIES
from .config import project_media_dir, settings
from .media import MediaError, extract_boundary_frames, extract_review_frames, probe_media
from .reference_boards import approved_reference_paths


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
        for value in approved_reference_paths(db, project_id, row["entity_type"], row["entity_key"]):
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
        conflicts = db.execute(
            "SELECT COUNT(*) FROM shot_state_snapshots WHERE project_id=? AND episode=? AND conflicts_json<>'[]'",
            (project_id, episode),
        ).fetchone()[0]
        if conflicts:
            raise RuntimeError(f"故事状态图存在 {conflicts} 个阻断镜头，请先在分镜工作台修正服装、伤势、道具或环境跳变")
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
            _queue_video_wave(db, run_id, project_id, shots, config)
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
        value_score = int(shot["value_score"] or 50)
        requirement = json.loads(shot["model_requirement_json"] or "{}")
        tier = str(requirement.get("tier") or ("premium" if value_score >= 80 else "standard" if value_score >= 45 else "economy"))
        provider = config.get("reference_image_provider") if references and config.get("reference_image_provider") else config["image_provider"]
        model = config.get("reference_image_model") if references and config.get("reference_image_provider") else config.get("image_model")
        payload = {"project_id": project_id, "episode": shot["episode"], "shot_id": shot["id"], "shot_number": shot["number"],
                   "prompt": (shot["prompt"] or shot["description"]) + memory + repair, "model": model, "reference_paths": references,
                   "options": {"size": "1024x1536" if int(config.get("height", 1080)) > int(config.get("width", 1920)) else "1536x1024", "quality": "high" if tier == "premium" or config.get("mode") == "quality" else "medium"},
                   "routing": {"value_score": value_score, "tier": tier, "reason": "reference_image_role" if references and config.get("reference_image_provider") else "keyframe_image_role"}}
        _queue(db, run_id, project_id, "image", provider, stage, payload, 70 + value_score // 4)


def _latest_shot_asset(db: sqlite3.Connection, shot_id: int, role: str) -> sqlite3.Row | None:
    return db.execute("SELECT a.* FROM assets a JOIN shot_assets sa ON sa.asset_id=a.id WHERE sa.shot_id=? AND sa.role=? AND a.status='ready' ORDER BY a.id DESC LIMIT 1", (shot_id, role)).fetchone()


def video_route(shot: sqlite3.Row, config: dict[str, Any]) -> dict[str, Any]:
    """Return the deterministic, billable video route before any task is submitted."""
    value_score = int(shot["value_score"] or 50)
    requirement = json.loads(shot["model_requirement_json"] or "{}")
    tier = str(requirement.get("tier") or ("premium" if value_score >= 80 else "standard" if value_score >= 45 else "economy"))
    provider = str(config.get("video_provider") or "dashscope")
    model = str(config.get("video_model") or "")
    reason = "selected_video_provider"
    if config.get("value_routing_enabled") and provider == "metaso" and config.get("video_fallback_provider") == "dashscope":
        if tier == "premium" or value_score >= 80:
            provider, model, reason = "metaso", str(config.get("video_model") or "MiniMax-H3"), "high_value_h3"
        else:
            provider, model, reason = "dashscope", str(config.get("video_fallback_model") or "wan2.7-i2v-2026-04-25"), "standard_value_wan"
    continuity = json.loads(shot["continuity_json"] or "{}")
    if str(continuity.get("link") or "cut") == "continuous" and config.get("transition_provider"):
        provider = str(config["transition_provider"])
        model = str(config.get("transition_model") or model)
        reason = "transition_video_role"
    resolution = ("2K" if tier == "premium" else "768P") if provider == "metaso" else ("1080P" if tier in {"premium", "standard"} or config.get("mode") == "quality" else "720P")
    return {"provider": provider, "model": model, "resolution": resolution, "reason": reason, "tier": tier, "value_score": value_score}


def automation_route_plan(project_id: str, config: dict[str, Any]) -> dict[str, Any]:
    """Preview every paid video call and blocking continuity issue without mutating state."""
    episode = int(config.get("episode", 1))
    with _db() as db:
        shots = _shot_rows(db, project_id, episode)
        conflict_count = int(db.execute(
            "SELECT COUNT(*) FROM shot_state_snapshots WHERE project_id=? AND episode=? AND conflicts_json<>'[]'",
            (project_id, episode),
        ).fetchone()[0])
        items: list[dict[str, Any]] = []
        totals: dict[str, dict[str, Any]] = {}
        for shot in shots:
            route = video_route(shot, config)
            seconds = max(3, min(12, round(_duration_seconds(shot["duration"]))))
            items.append({"shot_id": int(shot["id"]), "shot_number": shot["number"], "seconds": seconds, **route})
            summary = totals.setdefault(route["provider"], {"provider": route["provider"], "shots": 0, "seconds": 0, "resolutions": {}})
            summary["shots"] += 1
            summary["seconds"] += seconds
            summary["resolutions"][route["resolution"]] = summary["resolutions"].get(route["resolution"], 0) + 1
    return {"project_id": project_id, "episode": episode, "ready": bool(shots) and conflict_count == 0,
            "shot_count": len(shots), "blocking_conflicts": conflict_count, "routes": items, "totals": list(totals.values())}


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
                   "model": config.get("quality_model"), "reference_paths": [asset["local_path"], *bible_references[:2]], "options": {"threshold": STAGE_POLICIES[config.get('mode', 'balanced')]["consistency_threshold"]}}
        _queue(db, run_id, project_id, "vision_review", provider, "keyframe_review", payload, 70)
        count += 1
    return count


def _queued_shot_ids(db: sqlite3.Connection, run_id: int, stage: str) -> set[int]:
    result: set[int] = set()
    for row in db.execute("SELECT payload_json FROM tasks WHERE automation_run_id=? AND stage=?", (run_id, stage)).fetchall():
        payload = json.loads(row["payload_json"] or "{}")
        if payload.get("shot_id") is not None:
            result.add(int(payload["shot_id"]))
    return result


def _queue_video_wave(db: sqlite3.Connection, run_id: int, project_id: str, shots: list[sqlite3.Row], config: dict[str, Any], stage: str = "videos", only_ids: set[int] | None = None, repair_notes: dict[int, list[Any]] | None = None) -> int:
    queued_ids = _queued_shot_ids(db, run_id, stage)
    count = 0
    previous: sqlite3.Row | None = None
    for shot in shots:
        shot_id = int(shot["id"])
        if shot_id in queued_ids or (only_ids is not None and shot_id not in only_ids):
            previous = shot
            continue
        memory, references = bible_context(db, project_id, shot)
        keyframe = _latest_shot_asset(db, int(shot["id"]), "image")
        keyframe_path = str(keyframe["local_path"] or "") if keyframe else ""
        if keyframe and keyframe["local_path"]:
            references = [keyframe_path]
        continuity = json.loads(shot["continuity_json"] or "{}")
        link = str(continuity.get("link") or "cut")
        dependency: dict[str, Any] = {"relation": link}
        if link == "continuous" and previous is not None:
            previous_video = _latest_shot_asset(db, int(previous["id"]), "video")
            if not previous_video:
                previous = shot
                continue
            try:
                tail_frame, _ = extract_boundary_frames(previous_video["local_path"], previous_video["local_path"], project_id, f"tail-{previous['number']}-{shot['number']}")
            except MediaError:
                previous = shot
                continue
            # 上一镜真实尾帧是本镜起点，本镜已确认关键帧是目标终点。
            # 两者同时发送给支持首尾帧的 H3/Wan，避免只锁起点却丢掉本镜构图。
            references = [tail_frame, *([keyframe_path] if keyframe_path else [])]
            dependency.update({"from_shot_id": int(previous["id"]), "from_shot_number": previous["number"], "tail_frame": tail_frame,
                               "target_keyframe": keyframe_path, "constraint": "previous_tail_to_current_target"})
        duration = max(3, min(12, round(_duration_seconds(shot["duration"]))))
        route = video_route(shot, config)
        value_score, tier = route["value_score"], route["tier"]
        route_provider, route_model = route["provider"], route["model"]
        route_reason, resolution = route["reason"], route["resolution"]
        if link == "continuous" and config.get("transition_provider"):
            route_provider = str(config["transition_provider"])
            route_model = str(config.get("transition_model") or route_model)
            route_reason = "transition_video_role"
            resolution = "2K" if route_provider == "metaso" else "1080P"
        notes = list((repair_notes or {}).get(shot_id, []))
        repair = f"\n\n【视频质检返工】{json.dumps(notes, ensure_ascii=False)}" if notes else ""
        phase = str(continuity.get("action_phase") or "static")
        action_id = str(continuity.get("action_id") or "")
        momentum = str(continuity.get("momentum") or "still")
        video_prompt = (shot["prompt"] or shot["description"]) + memory + f"\n动作连续要求：动作链 {action_id or '未命名'}，当前相位 {phase}，动量 {momentum}；可见动作：{shot['action']}" + repair
        native_audio_policy = "model_default"
        if route_provider == "metaso" and config.get("generate_voice", True) and config.get("voice_provider"):
            native_audio_policy = "ambient_only"
            video_prompt += "\n\n【音频硬约束】只生成环境音、动作音和空间氛围，不生成角色对白或旁白；对白由后期独立配音轨完成。"
        payload = {"project_id": project_id, "episode": shot["episode"], "shot_id": shot["id"], "shot_number": shot["number"],
                   "prompt": video_prompt, "model": route_model,
                   "reference_paths": references[:2], "options": {"duration": duration, "seconds": duration, "resolution": resolution, "size": f"{config.get('width',1920)}x{config.get('height',1080)}", "reference_mode": "frames", "prompt_extend": True, "watermark": False, "native_audio_policy": native_audio_policy},
                   "routing": {"value_score": value_score, "tier": tier, "provider": route_provider, "model": route_model, "resolution": resolution, "reason": route_reason}}
        if route_provider == "metaso" and config.get("video_fallback_provider"):
            payload["fallback"] = {
                "provider": config["video_fallback_provider"],
                "model": config.get("video_fallback_model") or "",
                "reason": "primary_queue_timeout_or_temporary_failure",
            }
        payload["dependency"] = dependency
        _queue(db, run_id, project_id, "video", route_provider, stage, payload, 60 + value_score // 5)
        count += 1
        previous = shot
    return count


def _queue_video_reviews(db: sqlite3.Connection, run_id: int, project_id: str, shots: list[sqlite3.Row], config: dict[str, Any], stage: str) -> int:
    provider = config.get("quality_provider")
    if not provider:
        return 0
    count = 0
    previous: sqlite3.Row | None = None
    for shot in shots:
        video = _latest_shot_asset(db, int(shot["id"]), "video")
        if not video:
            previous = shot
            continue
        try:
            frames = extract_review_frames(video["local_path"], project_id, f"run-{run_id}-{stage}-{shot['number']}", 3)
        except MediaError:
            continue
        memory, _ = bible_context(db, project_id, shot)
        continuity = json.loads(shot["continuity_json"] or "{}")
        review_paths = list(frames)
        seam_note = ""
        if str(continuity.get("link") or "cut") == "continuous" and previous is not None:
            previous_video = _latest_shot_asset(db, int(previous["id"]), "video")
            if previous_video:
                try:
                    previous_tail, current_head = extract_boundary_frames(previous_video["local_path"], video["local_path"], project_id, f"review-{previous['number']}-{shot['number']}")
                    review_paths = [previous_tail, current_head, *frames[1:]]
                    seam_note = f"第1张是上一镜 {previous['number']} 的真实尾帧，第2张是本镜真实首帧；必须重点比较人物姿态、手部、道具、运动方向、动作相位和动量是否无跳变。"
                except MediaError:
                    seam_note = "未能提取上一镜尾帧，本次只能审核本镜内部。"
        payload = {"project_id": project_id, "episode": shot["episode"], "shot_id": shot["id"], "shot_number": shot["number"],
                   "prompt": f"逐帧审核本镜头的身份、服装、场景、道具、动作相位、手部姿态、动量、画质和跨镜接缝。{seam_note} 分镜动作：{shot['action']}；动作链：{continuity.get('action_id') or '未命名'}；相位：{continuity.get('action_phase') or 'static'}。{memory}",
                   "model": config.get("quality_model"), "reference_paths": review_paths, "options": {"threshold": STAGE_POLICIES[config.get('mode', 'balanced')]["consistency_threshold"], "review_kind": "video", "seam_from_shot": previous["number"] if seam_note and previous is not None else None}}
        _queue(db, run_id, project_id, "vision_review", provider, stage, payload, 72)
        count += 1
        previous = shot
    return count


def _review_failures(tasks: list[sqlite3.Row], threshold: int) -> tuple[set[int], dict[int, list[Any]]]:
    low: set[int] = set()
    notes: dict[int, list[Any]] = {}
    for row in tasks:
        result, payload = json.loads(row["result_json"] or "{}"), json.loads(row["payload_json"] or "{}")
        if int(result.get("score", 0)) < threshold and payload.get("shot_id") is not None:
            shot_id = int(payload["shot_id"])
            low.add(shot_id)
            notes[shot_id] = list(result.get("findings") or [])
    return low, notes


def _queue_final_review(db: sqlite3.Connection, run_id: int, project_id: str, output: str, config: dict[str, Any]) -> int:
    provider = config.get("final_review_provider") or config.get("quality_provider")
    if not provider or not output:
        return 0
    try:
        frames = extract_review_frames(output, project_id, f"run-{run_id}-final", 3)
    except MediaError:
        return 0
    payload = {"project_id": project_id, "episode": int(config.get("episode", 1)), "shot_number": "FINAL",
               "prompt": "审核最终成片采样帧：人物与场景是否稳定、镜头顺序是否叙事连贯、字幕是否遮挡主体、画面是否有明显生成瑕疵。",
               "model": config.get("final_review_model") or config.get("quality_model"), "reference_paths": frames, "options": {"threshold": STAGE_POLICIES[config.get('mode', 'balanced')]["consistency_threshold"], "review_kind": "final"}}
    _queue(db, run_id, project_id, "vision_review", provider, "final_review", payload, 105)
    return 1


def _after_video(db: sqlite3.Connection, run_id: int, project_id: str, shots: list[sqlite3.Row], config: dict[str, Any]) -> tuple[str, int]:
    count = _queue_voices(db, run_id, project_id, shots, config)
    if count:
        return "voice", 75
    _assemble(db, run_id, project_id, shots, config)
    return "export", 86


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
    position = 0
    for shot_index, shot in enumerate(shots):
        video = _latest_shot_asset(db, int(shot["id"]), "video")
        if not video:
            continue
        try:
            duration = float(probe_media(video["local_path"])["duration"])
        except (MediaError, OSError, ValueError):
            duration = _duration_seconds(shot["duration"])
        transition = "cut"
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
                _queue_video_wave(db, run_id, run["project_id"], shots, config); next_stage, progress = "videos", 35
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
                _queue_video_wave(db, run_id, run["project_id"], shots, config); next_stage, progress = "videos", 35
        elif stage == "keyframe_repairs":
            _queue_video_wave(db, run_id, run["project_id"], shots, config); next_stage, progress = "videos", 40
        elif stage == "videos":
            if _queue_video_wave(db, run_id, run["project_id"], shots, config):
                scheduled = len(_queued_shot_ids(db, run_id, "videos"))
                progress = 40 + round(20 * scheduled / max(1, len(shots)))
                db.execute("UPDATE automation_runs SET progress=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (progress, run_id))
                return
            if _queue_video_reviews(db, run_id, run["project_id"], shots, config, "video_review"):
                next_stage, progress = "video_review", 63
            else:
                next_stage, progress = _after_video(db, run_id, run["project_id"], shots, config)
        elif stage == "video_review":
            threshold = STAGE_POLICIES[config.get("mode", "balanced")]["consistency_threshold"]
            low, notes = _review_failures(tasks, threshold)
            if low and config.get("auto_repair", True):
                _queue_video_wave(db, run_id, run["project_id"], shots, config, "video_repairs", low, notes)
                next_stage, progress = "video_repairs", 68
            elif low and config.get("stop_on_blocker", True):
                db.execute("UPDATE automation_runs SET status='review_required',stage='video_review',error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (f"{len(low)} 个镜头未通过视频质检", run_id))
                return
            else:
                next_stage, progress = _after_video(db, run_id, run["project_id"], shots, config)
        elif stage == "video_repairs":
            if _queue_video_reviews(db, run_id, run["project_id"], shots, config, "video_repair_review"):
                next_stage, progress = "video_repair_review", 72
            else:
                next_stage, progress = _after_video(db, run_id, run["project_id"], shots, config)
        elif stage == "video_repair_review":
            threshold = STAGE_POLICIES[config.get("mode", "balanced")]["consistency_threshold"]
            low, _ = _review_failures(tasks, threshold)
            if low and config.get("stop_on_blocker", True):
                db.execute("UPDATE automation_runs SET status='review_required',stage='video_repair_review',error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (f"自动返工后仍有 {len(low)} 个镜头未达标，需要人工确认", run_id))
                return
            next_stage, progress = _after_video(db, run_id, run["project_id"], shots, config)
        elif stage == "voice":
            _assemble(db, run_id, run["project_id"], shots, config); next_stage, progress = "export", 85
        elif stage == "export":
            output = next((json.loads(row["result_json"] or "{}").get("output_path") for row in tasks if row["status"] == "completed"), "")
            checkpoint = json.dumps({"output_path": output}, ensure_ascii=False)
            if _queue_final_review(db, run_id, run["project_id"], output, config):
                db.execute("UPDATE automation_runs SET stage='final_review',progress=95,checkpoint_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (checkpoint, run_id))
                return
            db.execute("UPDATE automation_runs SET status='completed',stage='completed',progress=100,checkpoint_json=?,updated_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP WHERE id=?", (checkpoint, run_id))
            return
        elif stage == "final_review":
            threshold = STAGE_POLICIES[config.get("mode", "balanced")]["consistency_threshold"]
            score = min((int(json.loads(row["result_json"] or "{}").get("score", 0)) for row in tasks), default=0)
            if score < threshold and config.get("stop_on_blocker", True):
                db.execute("UPDATE automation_runs SET status='review_required',progress=98,error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (f"最终成片质检 {score} 分，低于 {threshold} 分阈值", run_id))
                return
            db.execute("UPDATE automation_runs SET status='completed',stage='completed',progress=100,updated_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP WHERE id=?", (run_id,))
            return
        db.execute("UPDATE automation_runs SET stage=?,progress=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (next_stage, progress, run_id))


def serialize_run(row: sqlite3.Row) -> dict[str, Any]:
    result = dict(row)
    result["config"] = json.loads(result.pop("config_json") or "{}")
    result["checkpoint"] = json.loads(result.pop("checkpoint_json") or "{}")
    result["cancel_requested"] = bool(result["cancel_requested"])
    return result
