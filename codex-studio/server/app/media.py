import json
import subprocess
import tempfile
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


def _run(command: list[str], timeout: int = 1800) -> None:
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, check=False)
    if completed.returncode:
        raise MediaError((completed.stderr or "FFmpeg 渲染失败")[-5000:])


def extract_boundary_frames(left_path: str, right_path: str, project_id: str, boundary_key: str) -> tuple[str, str]:
    ffmpeg = locate_ffmpeg()
    if not ffmpeg:
        raise MediaError("未找到 FFmpeg，无法提取转场首尾帧")
    left, right = probe_media(left_path), probe_media(right_path)
    folder = render_dir() / "boundaries" / "".join(ch for ch in project_id if ch.isalnum() or ch in "-_")
    folder.mkdir(parents=True, exist_ok=True)
    safe = "".join(ch for ch in boundary_key if ch.isalnum() or ch in "-_") or uuid.uuid4().hex[:8]
    left_frame, right_frame = folder / f"{safe}-left.png", folder / f"{safe}-right.png"
    left_at = max(0.0, float(left["duration"]) - 0.08)
    _run([ffmpeg, "-hide_banner", "-y", "-ss", f"{left_at:.3f}", "-i", left["path"], "-frames:v", "1", str(left_frame)], 60)
    _run([ffmpeg, "-hide_banner", "-y", "-ss", "0", "-i", right["path"], "-frames:v", "1", str(right_frame)], 60)
    return str(left_frame), str(right_frame)


def _safe_output_name(name: str) -> str:
    base = "".join(ch for ch in Path(name).stem if ch.isalnum() or ch in "-_（）()中文成片")[:80] or "final"
    return base + ".mp4"


def _subtitle_filter(path: str) -> str:
    escaped = Path(path).resolve().as_posix().replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
    return f"subtitles=filename='{escaped}':charenc=UTF-8"


def _finish_timeline(ffmpeg: str, master: Path, output: Path, payload: dict[str, Any], clips: list[dict[str, Any]], crf: str) -> None:
    audio_clips = [clip for clip in clips if clip.get("track") in {"A1", "A2"} and Path(str(clip.get("source_path", ""))).is_file()]
    subtitle = next((clip for clip in clips if clip.get("track") == "T1" and Path(str(clip.get("source_path", ""))).is_file()), None)
    if not audio_clips and not (subtitle and payload.get("burn_subtitles", True)):
        _run([ffmpeg, "-hide_banner", "-y", "-i", str(master), "-c", "copy", "-movflags", "+faststart", str(output)])
        return
    master_duration = float(probe_media(str(master))["duration"])
    command = [ffmpeg, "-hide_banner", "-y", "-i", str(master)]
    for clip in audio_clips:
        command.extend(["-i", str(clip["source_path"])])
    filters: list[str] = []
    audio_labels = ["[0:a]"]
    for index, clip in enumerate(audio_clips, start=1):
        metadata = clip.get("metadata") or {}
        if isinstance(metadata, str):
            try: metadata = json.loads(metadata)
            except json.JSONDecodeError: metadata = {}
        delay = max(0, round(float(metadata.get("start_seconds", 0)) * 1000))
        volume = max(0.0, min(4.0, float(clip.get("volume") or 1)))
        filters.append(f"[{index}:a]aresample=48000,adelay={delay}|{delay},volume={volume:.3f},apad,atrim=0:{master_duration:.3f}[ta{index}]")
        audio_labels.append(f"[ta{index}]")
    if audio_clips:
        filters.append(f"{''.join(audio_labels)}amix=inputs={len(audio_labels)}:duration=first:dropout_transition=2[aout]")
        command.extend(["-filter_complex", ";".join(filters), "-map", "0:v:0", "-map", "[aout]"])
    else:
        command.extend(["-map", "0:v:0", "-map", "0:a:0"])
    if subtitle and payload.get("burn_subtitles", True):
        command.extend(["-vf", _subtitle_filter(str(subtitle["source_path"])), "-c:v", "libx264", "-preset", "medium", "-crf", crf])
    else:
        command.extend(["-c:v", "copy"])
    command.extend(["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(output)])
    _run(command)


def render_timeline(payload: dict[str, Any], clips: list[dict[str, Any]]) -> dict[str, Any]:
    ffmpeg = locate_ffmpeg()
    if not ffmpeg:
        raise MediaError("未找到 FFmpeg，无法导出成片")
    video_clips = [clip for clip in clips if clip.get("track") in {"V1", "V2"}]
    if not video_clips:
        raise MediaError("时间线没有视频素材")
    width, height = int(payload.get("width", 1920)), int(payload.get("height", 1080))
    fps = int(payload.get("fps", 24))
    quality = str(payload.get("quality", "high"))
    crf = {"draft": "28", "standard": "22", "high": "18"}.get(quality, "18")
    project_id = str(payload.get("project_id", "unassigned"))
    output_dir = render_dir() / "".join(ch for ch in project_id if ch.isalnum() or ch in "-_")
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / _safe_output_name(str(payload.get("output_name", "final.mp4")))

    with tempfile.TemporaryDirectory(prefix="ai-film-export-") as temporary:
        master = Path(temporary) / "video-master.mp4"
        normalized: list[Path] = []
        durations: list[float] = []
        for index, clip in enumerate(video_clips):
            info = probe_media(str(clip["source_path"]))
            trim_in = max(0.0, float(clip.get("trim_in") or 0))
            trim_out = max(0.0, float(clip.get("trim_out") or 0))
            requested = float(clip.get("duration") or 0)
            available = max(0.05, info["duration"] - trim_in - trim_out)
            duration = min(requested, available) if requested > 0 else available
            durations.append(duration)
            segment = Path(temporary) / f"segment-{index:04d}.mp4"
            command = [ffmpeg, "-hide_banner", "-y", "-ss", f"{trim_in:.3f}", "-i", info["path"]]
            audio_input = 0
            if not info["has_audio"]:
                command.extend(["-f", "lavfi", "-t", f"{duration:.3f}", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"])
                audio_input = 1
            command.extend([
                "-t", f"{duration:.3f}", "-map", "0:v:0", "-map", f"{audio_input}:a:0",
                "-vf", f"fps={fps},scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p",
                "-af", "aresample=async=1:first_pts=0", "-c:v", "libx264", "-preset", "veryfast", "-crf", crf,
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", str(segment),
            ])
            _run(command)
            normalized.append(segment)

        if len(normalized) == 1:
            _run([ffmpeg, "-hide_banner", "-y", "-i", str(normalized[0]), "-c", "copy", "-movflags", "+faststart", str(master)])
        else:
            command = [ffmpeg, "-hide_banner", "-y"]
            for segment in normalized:
                command.extend(["-i", str(segment)])
            filters: list[str] = []
            for index in range(len(normalized)):
                filters.append(f"[{index}:v]settb=AVTB,setpts=PTS-STARTPTS[sv{index}]")
                filters.append(f"[{index}:a]aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS[sa{index}]")
            previous_v, previous_a = "[sv0]", "[sa0]"
            elapsed = durations[0]
            for index in range(1, len(normalized)):
                method = str(video_clips[index].get("transition") or "cut")
                transition = min(float(video_clips[index].get("transition_duration") or 0.4), durations[index - 1] / 3, durations[index] / 3)
                if method == "cut" or transition <= 0:
                    filters.append(f"{previous_v}[sv{index}]concat=n=2:v=1:a=0[v{index}]")
                    filters.append(f"{previous_a}[sa{index}]concat=n=2:v=0:a=1[a{index}]")
                    elapsed += durations[index]
                else:
                    style = "fadeblack" if method == "fade_black" else "fade"
                    offset = max(0.0, elapsed - transition)
                    filters.append(f"{previous_v}[sv{index}]xfade=transition={style}:duration={transition:.3f}:offset={offset:.3f}[v{index}]")
                    filters.append(f"{previous_a}[sa{index}]acrossfade=d={transition:.3f}:c1=tri:c2=tri[a{index}]")
                    elapsed += durations[index] - transition
                previous_v, previous_a = f"[v{index}]", f"[a{index}]"
            command.extend(["-filter_complex", ";".join(filters), "-map", previous_v, "-map", previous_a,
                            "-c:v", "libx264", "-preset", "medium", "-crf", crf, "-c:a", "aac", "-b:a", "192k",
                            "-movflags", "+faststart", str(master)])
            _run(command)
        _finish_timeline(ffmpeg, master, output, payload, clips, crf)
    if not output.is_file():
        raise MediaError("导出命令结束但未生成成片")
    return {"status": "completed", "output_path": str(output), "output_name": output.name, "media": probe_media(str(output)), "clip_count": len(video_clips)}
