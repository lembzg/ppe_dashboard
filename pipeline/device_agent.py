from ingest_client import IngestClient
from config import load_config
import subprocess
import argparse
import sys
from pathlib import Path
from datetime import datetime, timedelta, timezone
import json
import re
import uuid
from collections import Counter
from zoneinfo import ZoneInfo
from clips import cut_clip

parser = argparse.ArgumentParser()
parser.add_argument("--run-dir", type=Path, help="Use existing inference results")
parser.add_argument("--metadata-only", action="store_true", help="Report incidents without cutting or uploading clips")
args = parser.parse_args()

# Initialisation
settings = load_config()
client = IngestClient(
    base_url=settings["INGEST_URL"],
    serial=settings["DEVICE_SERIAL"],
    key=settings["DEVICE_KEY"],
)


pipeline_dir = Path(__file__).resolve().parent
run_name = datetime.now().strftime("run_%Y%m%d_%H%M%S_%f")
run_dir = pipeline_dir / "outputs" / run_name

if args.run_dir:
    run_dir = args.run_dir.resolve()
else:
    subprocess.run(
        [
            sys.executable,
            str(pipeline_dir / "inference.py"),
            "--model", settings["MODEL"],
            "--video", settings["CAMERA_SOURCE"],
            "--calibration", settings["CALIBRATION"],
            "--run-name", run_name,
            "--device", settings.get("GPU") or "cpu",
        ],
        cwd=pipeline_dir,
        check=True,
    )



# Open meta data
with open(run_dir /"scenario_events.json", encoding="utf-8") as file:
    events = json.load(file)["events"]
with open(run_dir / "scenario_summary.json", encoding="utf-8") as file:
    summary = json.load(file)
source_path = Path(summary["inputs"]["video_path"])
configured_path = Path(settings["CAMERA_SOURCE"])
if not source_path.is_absolute():
    source_path = pipeline_dir / source_path
if not configured_path.is_absolute():
    configured_path = pipeline_dir / configured_path
if source_path.resolve() != configured_path.resolve():
    raise ValueError("The selected results do not match CAMERA_SOURCE")
annotated_video_path = run_dir / "annotated_scenario_tracker.mp4"


# Report session and incident metadata before uploading clips.
video_path = Path(settings["CAMERA_SOURCE"])
start_value = settings.get("RECORDING_STARTED_AT")
if start_value:
    started_at = datetime.fromisoformat(start_value.replace("Z", "+00:00"))
    if started_at.utcoffset() is None:
        raise ValueError("RECORDING_STARTED_AT must include a timezone offset")
else:
    match = re.search(r"_(\d{14})$", video_path.stem)
    if not match:
        raise ValueError("Set RECORDING_STARTED_AT in device.env, including timezone")
    started_at = datetime.strptime(match[1], "%Y%m%d%H%M%S").replace(
        tzinfo=ZoneInfo(settings.get("CAMERA_TIMEZONE") or "Europe/London")
    )
started_at = started_at.astimezone(timezone.utc)
ended_at = started_at + timedelta(seconds=float(summary["video"]["duration_s"]))

# Each run is a session; keep its ID for retries.
identity_path = run_dir / "session_id.txt"
if identity_path.exists():
    session_id = identity_path.read_text().strip()
else:
    session_id = str(uuid.uuid4())
    identity_path.write_text(session_id)

track_frames = Counter()
with open(run_dir / "frame_scenario_state.jsonl", encoding="utf-8") as file:
    for line in file:
        if line.strip():
            track_frames.update({p["track_id"] for p in json.loads(line)["persons"]
                                 if p.get("track_id") is not None})
min_frames = max(1, round(float(summary["video"]["fps"])))
people_observed = sum(count >= min_frames for count in track_frames.values())

violation_codes = {"PERSON_VEHICLE_PROXIMITY": "person_near_vehicle"}
incidents = []
for event in events:
    code = violation_codes.get(event["event_type"])
    if code is None or event.get("person_track_id") is None:
        continue
    end_s = event.get("end_timestamp_s")
    if end_s is None:
        end_s = event["start_timestamp_s"]
    incidents.append({
        "episode_id": event["event_id"],
        "track_id": event["person_track_id"],
        "violations": [{
            "code": code,
            "first_seen_at": (started_at + timedelta(seconds=event["start_timestamp_s"])).isoformat(),
            "last_seen_at": (started_at + timedelta(seconds=end_s)).isoformat(),
            "confidence": event["maximum_confidence"],
        }],
    })

result = client.report_session(
    session_id=session_id,
    started_at=started_at.isoformat(),
    ended_at=ended_at.isoformat(),
    people_observed=people_observed,
    incidents=incidents,
    recording=video_path.name,
)
(run_dir / "report_response.json").write_text(json.dumps(result, indent=2))
if any("episode_id" not in row for row in result["incidents"]):
    raise RuntimeError("Deploy the episode migration and updated ingest function first")
incident_ids = {row["episode_id"]: row["id"] for row in result["incidents"]}
print(f"Reported {len(incident_ids)} incidents")
if result.get("skipped_codes"):
    print("Backend skipped unconfigured violation codes:", result["skipped_codes"])


for index, event in enumerate(events if not args.metadata_only else []):
    backend_incident_id = incident_ids.get(event["event_id"])
    if backend_incident_id is None:
        continue
    clip_path = run_dir / "clips" / f"event_{index}.mp4"

    # Cut clip default +- 2s
    duration_s = cut_clip(
        video_path=annotated_video_path,
        start_s=event["start_timestamp_s"],
        end_s=event["end_timestamp_s"] if event.get("end_timestamp_s") is not None else event["start_timestamp_s"],
        output_path=clip_path,
    )

    # Upload to backend
    client.upload(
        incident_id=backend_incident_id,
        video_path=clip_path,
        duration_s=duration_s,
    )




print(f"Inference finished. Results: {run_dir}")
