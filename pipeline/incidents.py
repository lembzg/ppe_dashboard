"""
Turns inference.py's events into the incidents the ingest API takes.

inference.py writes one event per continuous alert for a (person, vehicle)
pair, timed in seconds from the start of the video. The dashboard wants one
incident per tracked person, with at most one violation per type. So events are
grouped by person, and repeated episodes of the same type are merged into a
single violation spanning all of them.

    events = load_events("outputs/<run-name>")
    incidents = build_incidents(events, started_at)   # started_at: when the video began
    ingest_client.report_session(..., incidents=incidents)

Each incident also carries start_s / end_s (seconds into the video) for cutting
its clip; report_session ignores them.

count_people_observed() gives the session's people_observed, the dashboard's
denominator for compliance rate. It counts person tracks, not people: a tracker
id switch or a new session (the tracker restarts per video) counts the same
person again.
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

log = logging.getLogger(__name__)

# inference.py event type -> violation_types.code in the dashboard.
VIOLATION_CODES = {
    "PERSON_VEHICLE_PROXIMITY": "person_near_vehicle",
}


def load_events(run_dir: str | Path) -> list[dict]:
    """Reads the events from one inference.py run folder."""
    path = Path(run_dir) / "scenario_events.json"
    return json.loads(path.read_text(encoding="utf-8"))["events"]


def build_incidents(events: list[dict], started_at: datetime) -> list[dict]:
    """Groups events into one incident per person track.

    `started_at` is the wall-clock time of the video's first frame and must be
    timezone-aware. Events of types with no dashboard code, or with no person,
    are left out.
    """
    if started_at.tzinfo is None:
        raise ValueError("started_at has no timezone")

    by_track: dict[int, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for event in events:
        code = VIOLATION_CODES.get(event["event_type"])
        if code is None:
            log.warning("skipping %s event: no violation code mapped", event["event_type"])
            continue
        if event.get("person_track_id") is None:
            continue
        by_track[int(event["person_track_id"])][code].append(event)

    def at(seconds: float) -> datetime:
        return started_at + timedelta(seconds=seconds)

    incidents = []
    for track_id, by_code in sorted(by_track.items()):
        violations = []
        for code, episodes in sorted(by_code.items()):
            violations.append({
                "code": code,
                "first_seen_at": at(min(_start(e) for e in episodes)),
                "last_seen_at": at(max(_end(e) for e in episodes)),
                "confidence": round(max(e["maximum_confidence"] for e in episodes), 4),
                # inference.py events have no vote ratio; the column is optional.
                "vote_ratio": None,
            })
        all_episodes = [e for episodes in by_code.values() for e in episodes]
        incidents.append({
            "track_id": track_id,
            "start_s": min(_start(e) for e in all_episodes),
            "end_s": max(_end(e) for e in all_episodes),
            "violations": violations,
        })
    return incidents


MIN_OBSERVED_PERSON_SECONDS = 1.0  # same rule as the previous pipeline


def count_people_observed(run_dir: str | Path, min_seconds: float = MIN_OBSERVED_PERSON_SECONDS) -> int:
    """Person tracks seen on at least `min_seconds` worth of frames, so a
    detection that flickers for a few frames isn't counted as a person.

    Reads frame_scenario_state.jsonl (one line per frame, every tracked person)
    line by line, since a few minutes of video is tens of megabytes."""
    run_dir = Path(run_dir)
    summary = json.loads((run_dir / "scenario_summary.json").read_text(encoding="utf-8"))
    min_frames = max(1, round(min_seconds * float(summary["video"]["fps"])))

    frames_per_track: dict[int, int] = defaultdict(int)
    with open(run_dir / "frame_scenario_state.jsonl", encoding="utf-8") as frames:
        for line in frames:
            if line.strip():
                for person in json.loads(line)["persons"]:
                    if person.get("track_id") is not None:
                        frames_per_track[person["track_id"]] += 1
    return sum(1 for count in frames_per_track.values() if count >= min_frames)


def _start(event: dict) -> float:
    return float(event["start_timestamp_s"])


def _end(event: dict) -> float:
    # Every completed event is closed with an end time; fall back to the start
    # rather than fail if one ever isn't.
    end = event.get("end_timestamp_s")
    return float(end) if end is not None else _start(event)
