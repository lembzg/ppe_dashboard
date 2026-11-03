"""
Cuts a short, browser-playable clip around an incident.

    duration_s = cut_clip(video_path, incident["start_s"], incident["end_s"], "clip.mp4")
    ingest_client.upload_clip(incident_id, "clip.mp4", duration_s)

`video_path` can be the raw recording or inference.py's annotated video (boxes,
distances and states drawn on). Either way the clip is re-encoded, because the
dashboard plays it in the browser: H.264, yuv420p, at most 720p tall, no audio,
with the index at the front (faststart) so playback starts before it has fully
downloaded. inference.py's annotated video is mp4v, which browsers can't play.

Needs ffmpeg and ffprobe on the PATH. The Jetson Orin Nano has no hardware
video encoder, so this encodes on the CPU; a 20 s 720p clip takes a few seconds.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

PADDING_S = 2.0   # footage kept before the incident starts and after it ends
MAX_CLIP_S = 20.0  # longer incidents are cut to their first MAX_CLIP_S (including padding)


class ClipError(RuntimeError):
    pass


def cut_clip(
    video_path: str | Path,
    start_s: float,
    end_s: float,
    output_path: str | Path,
    padding_s: float = PADDING_S,
    max_s: float = MAX_CLIP_S,
) -> float:
    """Writes the clip for [start_s, end_s] (seconds into the video) and returns
    its actual duration in seconds, which is shorter than requested when the
    incident is near the start or end of the video."""
    if end_s < start_s:
        raise ValueError(f"end_s ({end_s}) is before start_s ({start_s})")

    clip_start = max(0.0, start_s - padding_s)
    clip_length = min(max_s, end_s + padding_s - clip_start)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    _run([
        "ffmpeg", "-y", "-nostdin", "-loglevel", "error",
        "-ss", f"{clip_start:.3f}", "-i", str(video_path), "-t", f"{clip_length:.3f}",
        # At most 720 px tall (never upscaled), both sides even as H.264 requires.
        "-vf", "scale=-2:'trunc(min(720,ih)/2)*2'",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
        "-an", "-movflags", "+faststart",
        str(output_path),
    ])

    duration = _run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(output_path),
    ]).strip()
    try:
        duration_s = float(duration)
    except ValueError:
        duration_s = 0.0
    if duration_s <= 0:
        output_path.unlink(missing_ok=True)
        raise ClipError(f"no footage at {clip_start:.2f}s in {video_path}")
    return round(duration_s, 2)


def _run(command: list[str]) -> str:
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except FileNotFoundError as error:
        raise ClipError(f"{command[0]} is not installed") from error
    if result.returncode != 0:
        raise ClipError(f"{command[0]} failed: {result.stderr.strip()[-1000:]}")
    return result.stdout
