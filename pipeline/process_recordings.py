"""
Runs the PPE / proximity tracker over recorder files and reports the results to
Supabase through the ingest endpoint, the same way an edge device does.

    python process_recordings.py data/videos --upload --clips

Results for each recording go to data/outputs/<recording>/. A recording that
already has results is not processed again unless --force is given, so an
interrupted batch can simply be rerun.
"""
import argparse
import json
import os
import sys
import time
from datetime import timedelta
from pathlib import Path

import cv2
from dotenv import load_dotenv

from ppe_pipeline import config as c
from ppe_pipeline.ingest import IngestClient, build_incidents, cut_clip
from ppe_pipeline.recording import parse_recording
from ppe_pipeline.tracker import Calibration, ScenarioTracker

HERE = Path(__file__).resolve().parent
VIDEO_SUFFIXES = {".mp4", ".avi", ".mkv", ".mov"}

STATE_COLOURS = {
    "PROXIMITY_ALERT": (0, 0, 255),
    "PROXIMITY_CAUTION": (0, 165, 255),
    "VEST_REVIEW": (0, 165, 255),
    "OK": (40, 190, 40),
}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("inputs", nargs="+", type=Path, help="recording files, or folders of them")
    parser.add_argument("--model", type=Path, default=HERE / "data/models/best.pt")
    parser.add_argument("--calibration", type=Path, help="y_pixel_to_height_scale_lookup.json; without it, distances are estimated from person height")
    parser.add_argument("--distance-m", type=float, default=c.PERSON_VEHICLE_THRESHOLD_M,
                        help=f"person-near-vehicle threshold in metres (default {c.PERSON_VEHICLE_THRESHOLD_M})")
    parser.add_argument("--timezone", default="Europe/London", help="site timezone the recorder's clock uses")
    parser.add_argument("--out", type=Path, default=HERE / "data/outputs")
    parser.add_argument("--device", default="0", help="CUDA device index, or 'cpu'")
    parser.add_argument("--annotate", action="store_true", help="also write an annotated video")
    parser.add_argument("--upload", action="store_true", help="report incidents to the ingest endpoint")
    parser.add_argument("--clips", action="store_true", help="with --upload, also upload a short clip per incident")
    parser.add_argument("--force", action="store_true", help="reprocess recordings that already have results")
    return parser.parse_args()


def find_recordings(inputs):
    paths = []
    for item in inputs:
        if item.is_dir():
            paths.extend(sorted(p for p in item.iterdir() if p.suffix.lower() in VIDEO_SUFFIXES))
        else:
            paths.append(item)
    return paths


def load_model(path):
    from ultralytics import YOLO

    model = YOLO(str(path))
    names = model.names if isinstance(model.names, dict) else dict(enumerate(model.names))
    for class_id, expected in c.EXPECTED_CLASS_NAMES.items():
        if names.get(class_id) != expected:
            sys.exit(f"Model class {class_id} is {names.get(class_id)!r}, expected {expected!r}. Model classes: {names}")
    return model


def draw_overlays(frame, persons, vehicles):
    for person in persons:
        x1, y1, x2, y2 = map(int, person["bbox"])
        vest_state = person["vest_temporal"]["state"]
        state = person["risk_state"] if person["risk_state"] in STATE_COLOURS else vest_state if vest_state == "VEST_REVIEW" else "OK"
        colour = STATE_COLOURS[state]
        cv2.rectangle(frame, (x1, y1), (x2, y2), colour, 3)
        label = f"ID {person['track_id']} | {vest_state.replace('VEST_', '')} | {person['rider']['state'].replace('_', ' ')}"
        cv2.putText(frame, label, (x1, max(20, y1 - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, colour, 2, cv2.LINE_AA)
    for vehicle in vehicles:
        x1, y1, x2, y2 = map(int, vehicle["bbox"])
        cv2.rectangle(frame, (x1, y1), (x2, y2), (180, 180, 180), 3)
        cv2.putText(frame, f"V{vehicle['track_id']} | {vehicle['motion']['state']}", (x1, max(20, y1 - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (180, 180, 180), 2, cv2.LINE_AA)


def process(recording, model, calibration, args, output_dir):
    capture = cv2.VideoCapture(str(recording.path))
    if not capture.isOpened():
        raise RuntimeError(f"Could not open {recording.path}")
    fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))

    writer = None
    if args.annotate:
        writer = cv2.VideoWriter(str(output_dir / "annotated.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))

    tracker = ScenarioTracker(width, height, fps, calibration)
    started = time.time()
    frame_index = -1
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            frame_index += 1
            result = model.track(
                source=frame, persist=True, tracker=c.TRACKER_CONFIG,
                classes=[c.PERSON_CLASS_ID, c.VEST_CLASS_ID, c.VEHICLE_CLASS_ID],
                conf=c.CONFIDENCE_THRESHOLD, iou=c.NMS_IOU_THRESHOLD, imgsz=c.IMAGE_SIZE,
                device=args.device, verbose=False,
            )[0]
            persons, vehicles = tracker.update(frame_index, result)
            if writer is not None:
                annotated = result.plot(conf=True, labels=True, boxes=True)
                draw_overlays(annotated, persons, vehicles)
                writer.write(annotated)
            if frame_index % 100 == 0:
                print(f"  frame {frame_index}/{frame_count}", flush=True)
    finally:
        capture.release()
        if writer is not None:
            writer.release()

    events = tracker.finish()
    elapsed = time.time() - started
    summary = {
        "recording": recording.name,
        "serial": recording.serial,
        "session_id": recording.session_id,
        "started_at": recording.started_at.isoformat(),
        "duration_s": round((frame_index + 1) / fps, 3),
        "fps": round(fps, 3),
        "frame_size": [width, height],
        "frames_processed": frame_index + 1,
        "processing_fps": round((frame_index + 1) / elapsed, 2) if elapsed else None,
        "model": str(args.model),
        "calibration": str(args.calibration) if args.calibration else f"assumed person height {c.ASSUMED_PERSON_HEIGHT_CM:g} cm",
        "distance_threshold_m": args.distance_m,
        "people_observed": tracker.people_observed(),
        "event_counts": {t: sum(e["event_type"] == t for e in events) for t in sorted({e["event_type"] for e in events})},
    }
    (output_dir / "events.json").write_text(json.dumps(events, indent=2))
    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    return summary, events


def upload(recording, summary, events, args, output_dir):
    key = os.environ.get("DEVICE_KEY_" + recording.serial)
    if not key or not os.environ.get("INGEST_URL"):
        sys.exit(f"Set INGEST_URL and DEVICE_KEY_{recording.serial} in pipeline/.env to upload.")
    client = IngestClient(os.environ["INGEST_URL"], recording.serial, key)

    incidents = build_incidents(events, recording.started_at)
    ended_at = recording.started_at + timedelta(seconds=summary["duration_s"])
    response = client.report_session(recording, ended_at, summary["people_observed"], incidents)
    print(f"  reported {len(response['incidents'])} incidents, {summary['people_observed']} people observed")
    if response.get("skipped_codes"):
        print(f"  warning: no violation type for {', '.join(response['skipped_codes'])}, so those detections were dropped."
              " Add the type in Configuration and rerun with --upload to report them.")

    if args.clips:
        incident_ids = {row["track_id"]: row["id"] for row in response["incidents"]}
        for incident in (i for i in incidents if i["track_id"] in incident_ids):
            clip_path = output_dir / f"clip_track{incident['track_id']}.mp4"
            duration = cut_clip(recording.path, incident["start_s"], incident["end_s"], clip_path)
            client.upload_clip(incident_ids[incident["track_id"]], clip_path, duration)
        print(f"  uploaded {len(incident_ids)} clips")


def main():
    load_dotenv(HERE / ".env")
    args = parse_args()
    c.PERSON_VEHICLE_THRESHOLD_M = args.distance_m
    calibration = Calibration.load(args.calibration) if args.calibration else None
    if calibration is None:
        print(f"No calibration file: distances are estimated assuming people are {c.ASSUMED_PERSON_HEIGHT_CM:g} cm tall.")

    recordings = [parse_recording(path, args.timezone) for path in find_recordings(args.inputs)]
    if not recordings:
        sys.exit("No recordings found.")

    model = None
    for recording in recordings:
        print(f"{recording.name} ({recording.serial}, started {recording.started_at:%Y-%m-%d %H:%M:%S %Z})")
        output_dir = args.out / recording.name
        output_dir.mkdir(parents=True, exist_ok=True)

        if (output_dir / "summary.json").exists() and not args.force:
            print("  already processed, using saved results")
            summary = json.loads((output_dir / "summary.json").read_text())
            events = json.loads((output_dir / "events.json").read_text())
        else:
            # A fresh model per recording, so tracker IDs and state never carry over.
            model = load_model(args.model)
            summary, events = process(recording, model, calibration, args, output_dir)
            print(f"  {summary['frames_processed']} frames at {summary['processing_fps']} fps: {summary['event_counts'] or 'no events'}")

        if args.upload:
            upload(recording, summary, events, args, output_dir)


if __name__ == "__main__":
    main()
