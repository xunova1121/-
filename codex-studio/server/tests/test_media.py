import shutil
import subprocess

import pytest

from app import media


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg not installed")
def test_real_dissolve_render_normalizes_video_and_preserves_audio(tmp_path, monkeypatch):
    left, right = tmp_path / "left.mp4", tmp_path / "right.mp4"
    for output, color, size, rate, tone in [
        (left, "red", "320x240", 24, 440),
        (right, "blue", "426x240", 30, 660),
    ]:
        subprocess.run([
            shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"color=c={color}:s={size}:d=1.2:r={rate}",
            "-f", "lavfi", "-i", f"sine=frequency={tone}:duration=1.2", "-shortest",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(output),
        ], check=True, timeout=30)
    monkeypatch.setattr(media, "render_dir", lambda: tmp_path / "renders")
    result = media.render_transition({
        "project_id": "test", "left_path": str(left), "right_path": str(right),
        "method": "dissolve", "duration_seconds": 0.4, "target_fps": 24,
        "width": 640, "height": 360, "preserve_audio": True,
    })
    assert result["status"] == "completed"
    assert result["audio_preserved"] is True
    assert result["media"]["width"] == 640
    assert result["media"]["height"] == 360
    assert result["media"]["fps"] == "24/1"
    assert 1.8 < result["media"]["duration"] < 2.2


def test_ai_transition_cannot_silently_fall_back_to_local_renderer():
    with pytest.raises(media.MediaError, match="AI 转场引擎"):
        media.render_transition({"method": "vace_context_bridge"})


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg not installed")
def test_real_timeline_export_with_cut_and_dissolve(tmp_path, monkeypatch):
    sources = []
    for index, color in enumerate(("red", "blue", "green")):
        output = tmp_path / f"source-{index}.mp4"
        subprocess.run([
            shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"color=c={color}:s=320x240:d=1.4:r=24",
            "-f", "lavfi", "-i", f"sine=frequency={440 + index * 100}:duration=1.4", "-shortest",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(output),
        ], check=True, timeout=30)
        sources.append(output)
    monkeypatch.setattr(media, "render_dir", lambda: tmp_path / "renders")
    clips = [
        {"track": "V1", "source_path": str(sources[0]), "duration": 1.2, "trim_in": 0, "trim_out": 0, "transition": "cut", "transition_duration": 0.3},
        {"track": "V1", "source_path": str(sources[1]), "duration": 1.2, "trim_in": 0, "trim_out": 0, "transition": "cut", "transition_duration": 0.3},
        {"track": "V1", "source_path": str(sources[2]), "duration": 1.2, "trim_in": 0, "trim_out": 0, "transition": "dissolve", "transition_duration": 0.3},
    ]
    result = media.render_timeline({"project_id": "timeline-test", "width": 640, "height": 360, "fps": 24, "quality": "standard", "output_name": "成片.mp4"}, clips)
    assert result["status"] == "completed"
    assert result["clip_count"] == 3
    assert result["media"]["width"] == 640
    assert result["media"]["height"] == 360
    assert 3.0 < result["media"]["duration"] < 3.7


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg not installed")
def test_timeline_mixes_external_audio_and_burns_subtitles(tmp_path, monkeypatch):
    video, voice, subtitle = tmp_path / "video.mp4", tmp_path / "voice.wav", tmp_path / "caption.srt"
    subprocess.run([shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=1.5:r=24", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(video)], check=True, timeout=30)
    subprocess.run([shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=0.7", str(voice)], check=True, timeout=30)
    subtitle.write_text("1\n00:00:00,100 --> 00:00:01,200\n自动字幕已进入成片\n", encoding="utf-8")
    monkeypatch.setattr(media, "render_dir", lambda: tmp_path / "renders")
    result = media.render_timeline({"project_id": "audio-subtitle", "width": 640, "height": 360, "fps": 24, "quality": "standard", "output_name": "mixed.mp4", "burn_subtitles": True}, [
        {"track": "V1", "source_path": str(video), "duration": 1.4, "trim_in": 0, "trim_out": 0, "transition": "cut", "transition_duration": 0},
        {"track": "A1", "source_path": str(voice), "volume": 1, "metadata": {"start_seconds": 0.3}},
        {"track": "T1", "source_path": str(subtitle)},
    ])
    assert result["status"] == "completed"
    assert result["media"]["has_audio"] is True
    assert result["media"]["width"] == 640
