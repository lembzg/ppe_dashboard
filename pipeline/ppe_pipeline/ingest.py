"""Turns tracker events into incidents and reports them to the ingest edge function."""
import subprocess
from collections import defaultdict
from datetime import timedelta

import requests

# Tracker event types and the violation_types.code each one is reported as.
VIOLATION_CODES = {
    "PERSON_VEHICLE_PROXIMITY": "person_near_vehicle",
    "VEST_MISSING": "ppe_no_vest",
}

CLIP_PADDING_S = 2.0
CLIP_MAX_S = 20.0


def build_incidents(events, started_at):
    """One incident per person track, with one violation per type. Repeated
    episodes of the same type merge into a single violation spanning them all."""
    by_track = defaultdict(lambda: defaultdict(list))
    for event in events:
        by_track[event["person_track_id"]][VIOLATION_CODES[event["event_type"]]].append(event)

    def at(seconds):
        return (started_at + timedelta(seconds=seconds)).isoformat()

    incidents = []
    for track_id, by_code in sorted(by_track.items()):
        violations = []
        for code, episodes in sorted(by_code.items()):
            votes = [episode["vote_ratio"] for episode in episodes if episode["vote_ratio"] is not None]
            violations.append({
                "code": code,
                "first_seen_at": at(min(episode["start_timestamp_s"] for episode in episodes)),
                "last_seen_at": at(max(episode["end_timestamp_s"] for episode in episodes)),
                "confidence": round(max(episode["maximum_confidence"] for episode in episodes), 4),
                "vote_ratio": round(sum(votes) / len(votes), 4) if votes else None,
            })
        incidents.append({
            "track_id": track_id,
            "start_s": min(episode["start_timestamp_s"] for episodes in by_code.values() for episode in episodes),
            "end_s": max(episode["end_timestamp_s"] for episodes in by_code.values() for episode in episodes),
            "violations": violations,
        })
    return incidents


def cut_clip(video_path, start_s, end_s, output_path):
    """Writes a browser-playable H.264 clip around an incident and returns its duration."""
    clip_start = max(0.0, start_s - CLIP_PADDING_S)
    duration = min(CLIP_MAX_S, end_s + CLIP_PADDING_S - clip_start)
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-ss", f"{clip_start:.2f}", "-i", str(video_path), "-t", f"{duration:.2f}",
        "-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-an",
        "-movflags", "+faststart", str(output_path),
    ], check=True)
    return duration


class IngestClient:
    def __init__(self, base_url, serial, key, timeout=60):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({"x-device-serial": serial, "x-device-key": key})
        self.timeout = timeout

    def _post(self, route, body):
        response = self.session.post(self.base_url + route, json=body, timeout=self.timeout)
        if not response.ok:
            raise RuntimeError(f"ingest {route} failed ({response.status_code}): {response.text}")
        return response.json()

    def report_session(self, recording, ended_at, people_observed, incidents):
        return self._post("/session", {
            "session_id": recording.session_id,
            "recording": recording.name,
            "started_at": recording.started_at.isoformat(),
            "ended_at": ended_at.isoformat(),
            "people_observed": people_observed,
            "incidents": [{"track_id": i["track_id"], "violations": i["violations"]} for i in incidents],
        })

    def upload_clip(self, incident_id, clip_path, duration_s):
        upload = self._post("/clip", {"incident_id": incident_id, "duration_s": duration_s, "blurred": False})
        with open(clip_path, "rb") as clip:
            response = requests.put(upload["signed_url"], data=clip, headers={"content-type": "video/mp4", "x-upsert": "true"},
                                    timeout=self.timeout)
        if not response.ok:
            raise RuntimeError(f"clip upload failed ({response.status_code}): {response.text}")
        return upload["path"]

    def heartbeat(self):
        return self._post("/heartbeat", {})
