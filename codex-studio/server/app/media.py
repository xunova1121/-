import json
import subprocess
import uuid
from pathlib import Path
from typing import Any

from .config import render_dir
from .preflight import locate_ffmpeg, locate_ffprobe


class MediaError(RuntimeError):
    pass


LOCAL_METHODS = {"cut", "match_cut", "dissolve", "fade_black"}


def capabilities() -> dict[str, Any]:
    ffmpeg, ffprobe = locate_ffmpeg(), locate_ffprobe()
    return {
        "ffmpeg_available": bool(ffmpeg and ffprobe),
        "ffmpeg_path": ffmpeg,
        "ffprobe_path": ffprobe,
        "local_transition_methods": sorted(LOCAL_METHODS),
        "ai_transition_methods": ["rife_interpolate", "first_last_bridge", "vace_context_bridge"],
    }


def probe_media(path: str) -> dict[str, Any]:
    source = Path(path).expanduser().resolve()
    if not source.is_file():
        raise MediaError(f"素材不存在：{source}")
    ffprobe = locate_ffprobe()
    if not ffprobe:
        raise MediaError("未找到 FFprobe，请安装 FFmpeg 或设置 AI_STUDIO_FFMPEG")
    completed = subprocess.run(
        [ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(source)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, check=False,
    )
    if completed.returncode:
        raise MediaError((completed.stderr or "无法读取素材").strip())
    raw = json.loads(completed.stdout)
    video = next((stream for stream in raw.get("streams", []) if stream.get("codec_type") == "video"), None)
    if not video:
        raise MediaError("素材不包含视频轨道")
    audio = next((stream for stream in raw.get("streams", []) if stream.get("codec_type") == "audio"), None)
    duration = float(raw.get("format", {}).get("duration") or video.get("duration") or 0)
    return {
        "path": str(source), "duration": duration, "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0), "fps": video.get("avg_frame_rate") or "0/0",
        "video_codec": video.get("codec_name"), "has_audio": audio is not None,
        "audio_codec": audio.get("codec_name") if audio else None,
    }


def _video_filter(index: int, width: int, height: int, fps: int) -> str:
    return (
        f"[{index}:v]fps={fps},scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,settb=AVTB[v{index}]"
    )


def render_transition(payload: dict[str, Any]) -> dict[str, Any]:
    method = str(payload.get("method", "dissolve"))
    if method not in LOCAL_METHODS:
        raise MediaError(f"{method} 需要 AI 转场引擎，不能由本地 FFmpeg 渲染")
    ffmpeg = locate_ffmpeg()
    if not ffmpeg:
        raise MediaError("未找到 FFmpeg，请安装后重试或设置 AI_STUDIO_FFMPEG")
    left = probe_media(str(payload["left_path"]))
    right = probe_media(str(payload["right_path"]))
    fps = int(payload.get("target_fps", 24))
    width, height = int(payload.get("width", 1280)), int(payload.get("height", 720))
    transition_seconds = min(float(payload.get("duration_seconds", 0.5)), left["duration"] / 2, right["duration"] / 2)
    if transition_seconds <= 0:
        raise MediaError("素材时长无效，无法计算转场")
    project_id = "".join(ch for ch in str(payload.get("project_id", "unassigned")) if ch.isalnum() or ch in "-_") or "unassigned"
    output_dir = render_dir() / project_id
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / f"transition-{uuid.uuid4().hex[:12]}.mp4"

    filters = [_video_filter(0, width, height, fps), _video_filter(1, width, height, fps)]
    effective = "cut" if method == "match_cut" else method
    if effective == "cut":
        filters.append("[v0][v1]concat=n=2:v=1:a=0[v]")
    else:
        style = "fadeblack" if effective == "fade_black" else "fade"
        offset = max(0, left["duration"] - transition_seconds)
        filters.append(f"[v0][v1]xfade=transition={style}:duration={transition_seconds:.3f}:offset={offset:.3f}[v]")

    preserve_audio = bool(payload.get("preserve_audio", True)) and left["has_audio"] and right["has_audio"]
    if preserve_audio:
        if effective == "cut":
            filters.extend(["[0:a]aresample=async=1:first_pts=0[a0]", "[1:a]aresample=async=1:first_pts=0[a1]", "[a0][a1]concat=n=2:v=0:a=1[a]"])
        else:
            filters.append(f"[0:a][1:a]acrossfade=d={transition_seconds:.3f}:c1=tri:c2=tri[a]")

    command = [ffmpeg, "-hide_banner", "-y", "-i", left["path"], "-i", right["path"], "-filter_complex", ";".join(filters), "-map", "[v]"]
    if preserve_audio:
        command.extend(["-map", "[a]", "-c:a", "aac", "-b:a", "192k"])
    command.extend(["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-movflags", "+faststart", str(output)])
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=int(payload.get("timeout_seconds", 600)), check=False)
    if completed.returncode or not output.is_file():
        raise MediaError((completed.stderr or "FFmpeg 渲染失败")[-3000:])
    rendered = probe_media(str(output))
    return {
        "status": "completed", "requested_method": method, "effective_method": effective,
        "output_path": str(output), "output_name": output.name, "media": rendered,
        "transition_seconds": transition_seconds, "audio_preserved": preserve_audio,
    }
