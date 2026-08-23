from typing import Any

STAGE_POLICIES = {
    "quality": {"parallelism": 2, "consistency_threshold": 88, "transition_engine": "vace", "max_retries": 3},
    "balanced": {"parallelism": 4, "consistency_threshold": 82, "transition_engine": "auto", "max_retries": 2},
    "economy": {"parallelism": 8, "consistency_threshold": 75, "transition_engine": "ffmpeg", "max_retries": 1},
}


def automation_plan(episode: int, mode: str, shot_count: int, blockers: list[dict[str, Any]]) -> dict[str, Any]:
    policy = STAGE_POLICIES[mode]
    stages = [
        {"id": "bible_gate", "action": "freeze_latest_bible", "depends_on": []},
        {"id": "storyboard_gate", "action": "lock_full_storyboard", "depends_on": ["bible_gate"]},
        {"id": "keyframes", "action": "generate_and_review_keyframes", "depends_on": ["storyboard_gate"], "items": shot_count},
        {"id": "videos", "action": "generate_shot_videos", "depends_on": ["keyframes"], "items": shot_count},
        {"id": "seams", "action": "analyze_and_bridge_boundaries", "depends_on": ["videos"], "items": max(0, shot_count - 1)},
        {"id": "audio", "action": "generate_voice_music_sfx", "depends_on": ["storyboard_gate"]},
        {"id": "timeline", "action": "assemble_frame_accurate_timeline", "depends_on": ["seams", "audio"]},
        {"id": "final_qc", "action": "review_and_selective_repair", "depends_on": ["timeline"]},
    ]
    return {"episode": episode, "mode": mode, "policy": policy, "stages": stages, "blocked": bool(blockers), "blockers": blockers}

