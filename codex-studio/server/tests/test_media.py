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
