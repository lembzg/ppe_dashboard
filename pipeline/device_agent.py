"""
The program that runs on the Jetson. It turns one camera into a device that
reports to the dashboard, configured entirely by device.env (see
device.env.example).

    .venv/bin/python device_agent.py [--config path/to/device.env]

What it does, continuously:

    camera ──ffmpeg──► spool/segments/<UTC start>.mp4     (one chunk per SEGMENT_MINUTES)
                          │ each finished chunk, oldest first
                          ▼
                       inference.py (unchanged, its own process) ──► spool/runs/<chunk>/
                          │
                          ▼
                       incidents + people observed ──► ingest /session
                       clip per incident ──────────► ingest /clip + upload
                          │
                          ▼
                       footage deleted after KEEP_HOURS (sooner if the disk fills)

    and every minute, while the camera is delivering footage: ingest /heartbeat

Each chunk is one session. Chunks are named by their UTC start time, which
gives the session its timestamps and its fixed session id, so a chunk reported
twice (after a crash or a network failure) updates the same records.

Nothing is lost when the network drops: processed chunks wait in spool/runs
until reporting succeeds. A chunk inference.py can't process is moved to
spool/failed with its log in spool/logs, and the agent carries on.

The Jetson's clock must be right (it syncs automatically when online), since
chunk start times come from it.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from clips import ClipError, cut_clip
from config import Config, ConfigError, load_config, masked_source
from incidents import build_incidents, count_people_observed, load_events
from ingest_client import IngestClient, IngestError, session_id_for

HERE = Path(__file__).resolve().parent
INFERENCE = HERE / "inference.py"
SPOOL = HERE / "spool"

CHUNK_NAME_FORMAT = "%Y%m%dT%H%M%SZ"  # chunk file names, UTC start time
STALL_S = 60          # no new footage for this long: restart the recorder, stop heartbeats
HEARTBEAT_S = 60      # dashboard shows a camera offline after 10 minutes without one
IDLE_WAIT_S = 5
MIN_FREE_GB = 2.0     # below this, old footage is deleted early
MAX_REPORT_BACKOFF_S = 300

log = logging.getLogger("device_agent")


def should_retry(error: IngestError) -> bool:
    # A wrong or replaced key (401/403) is fixed by updating device.env, after
    # which everything still waiting should be sent, so keep it rather than drop it.
    return error.retryable or error.status in (401, 403)


# ── Spool: the agent's working folder ─────────────────────────────────────────

class Spool:
    def __init__(self, root: Path):
        self.segments = root / "segments"   # recorded chunks; the newest is still being written
        self.runs = root / "runs"           # inference.py output per chunk
        self.failed = root / "failed"       # chunks inference.py couldn't process
        self.clips = root / "clips"         # clips waiting to upload
        self.logs = root / "logs"
        for folder in (self.segments, self.runs, self.failed, self.clips, self.logs):
            folder.mkdir(parents=True, exist_ok=True)

    def segment_files(self) -> list[Path]:
        return sorted(self.segments.glob("*.mp4"))

    def segment(self, chunk: str) -> Path:
        return self.segments / f"{chunk}.mp4"

    def run_dir(self, chunk: str) -> Path:
        return self.runs / chunk

    def is_processed(self, chunk: str) -> bool:
        return (self.run_dir(chunk) / "scenario_summary.json").exists()

    def is_reported(self, chunk: str) -> bool:
        return (self.run_dir(chunk) / "reported.json").exists()

    def remove_chunk(self, chunk: str) -> None:
        shutil.rmtree(self.run_dir(chunk), ignore_errors=True)
        self.segment(chunk).unlink(missing_ok=True)
        (self.logs / f"{chunk}.log").unlink(missing_ok=True)

    def free_gb(self) -> float:
        return shutil.disk_usage(self.segments).free / 1e9


# ── Recorder: camera → chunk files ────────────────────────────────────────────

class Recorder(threading.Thread):
    """Keeps an ffmpeg process recording the camera into chunk files, and
    restarts it if it exits or the camera stops delivering footage."""

    def __init__(self, source: str, spool: Spool, segment_s: int, stop: threading.Event):
        super().__init__(name="recorder", daemon=True)
        self.source = source
        self.spool = spool
        self.segment_s = segment_s
        self.stop = stop
        self.log_path = spool.logs / "recorder.log"
        self._process: subprocess.Popen | None = None

    def command(self) -> list[str]:
        source = self.source
        if source.startswith(("rtsp://", "rtsps://")):
            # Stored as the camera sends it: no re-encoding, so almost no CPU.
            source_args = ["-rtsp_transport", "tcp", "-i", source]
            codec_args = ["-c", "copy"]
        elif source.startswith("/dev/video"):
            # USB cameras deliver raw frames, which have to be encoded (on the CPU:
            # the Orin Nano has no hardware encoder).
            source_args = ["-f", "v4l2", "-i", source]
            codec_args = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p", "-g", "50"]
        elif Path(source).is_file():
            # A video file played in a loop as if it were live, for testing without a camera.
            source_args = ["-re", "-stream_loop", "-1", "-i", source]
            codec_args = ["-c", "copy"]
        else:
            source_args = ["-i", source]
            codec_args = ["-c", "copy"]
        return [
            "ffmpeg", "-nostdin", "-loglevel", "error", *source_args,
            "-map", "0:v:0", *codec_args,
            "-f", "segment", "-segment_time", str(self.segment_s), "-segment_format", "mp4",
            "-reset_timestamps", "1", "-strftime", "1",
            str(self.spool.segments / f"{CHUNK_NAME_FORMAT}.mp4"),
        ]

    def running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def healthy(self) -> bool:
        """Recording and footage is arriving."""
        return self.running() and self._footage_is_fresh()

    def _footage_is_fresh(self) -> bool:
        files = self.spool.segment_files()
        return bool(files) and time.time() - files[-1].stat().st_mtime < STALL_S

    def run(self) -> None:
        backoff = 5
        while not self.stop.is_set():
            started = time.monotonic()
            with open(self.log_path, "ab") as errors:
                errors.write(f"--- {datetime.now(timezone.utc).isoformat()} starting\n".encode())
                errors.flush()
                # TZ=UTC so the chunk names (strftime) are UTC.
                self._process = subprocess.Popen(
                    self.command(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors,
                    env={**os.environ, "TZ": "UTC"},
                )
                log.info("recording %s in %d s chunks", masked_source(self.source), self.segment_s)
                while self._process.poll() is None and not self.stop.wait(5):
                    if time.monotonic() - started > STALL_S and not self._footage_is_fresh():
                        log.warning("no new footage from the camera for %d s; restarting the recorder", STALL_S)
                        break
                self._finish()
            if self.stop.is_set():
                break
            ran_s = time.monotonic() - started
            if ran_s > 2 * STALL_S:
                backoff = 5
            log.warning("recorder stopped (exit code %s) after %.0f s; restarting in %d s (details in %s)",
                        self._process.returncode, ran_s, backoff, self.log_path)
            self.stop.wait(backoff)
            backoff = min(backoff * 2, 60)

    def _finish(self) -> None:
        # SIGINT lets ffmpeg finish the chunk it is writing, so the file stays playable.
        if self._process.poll() is None:
            self._process.send_signal(signal.SIGINT)
            try:
                self._process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait()


def heartbeat_loop(client: IngestClient, recorder: Recorder, stop: threading.Event) -> None:
    """Heartbeats only while footage is arriving, so a dead camera shows as
    offline on the dashboard even though the Jetson itself is up."""
    was_healthy = None
    while not stop.is_set():
        healthy = recorder.healthy()
        if healthy:
            try:
                client.heartbeat()
            except IngestError as error:
                log.warning("heartbeat failed: %s", error)
        if healthy != was_healthy and was_healthy is not None:
            log.info("camera %s", "delivering footage" if healthy else
                     "not delivering footage; withholding heartbeats so the dashboard shows it offline")
        was_healthy = healthy
        stop.wait(HEARTBEAT_S)


# ── Agent: chunks → inference → reports ───────────────────────────────────────

class Agent:
    def __init__(self, config: Config, stop: threading.Event):
        self.config = config
        self.stop = stop
        self.spool = Spool(SPOOL)
        self.client = IngestClient(config.ingest_url, config.device_serial, config.device_key)
        self.segment_s = max(1, int(round(config.segment_minutes * 60)))
        self.recorder = Recorder(config.camera_source, self.spool, self.segment_s, stop)
        self.report_backoff_s = 0
        self.report_retry_at = 0.0
        self.disk_warned = False

    def run(self) -> None:
        self.recorder.start()
        threading.Thread(target=heartbeat_loop, args=(self.client, self.recorder, self.stop),
                         name="heartbeat", daemon=True).start()
        while not self.stop.is_set():
            worked = self.process_next()
            self.report_pending()
            self.cleanup()
            if not worked:
                self.stop.wait(IDLE_WAIT_S)
        self.recorder.join(timeout=20)
        log.info("stopped")

    # ── Processing ────────────────────────────────────────────────────────────

    def finished_chunks(self) -> list[str]:
        files = self.spool.segment_files()
        # The newest file is still being written while the recorder runs.
        if files and (self.recorder.running() or time.time() - files[-1].stat().st_mtime < 10):
            files = files[:-1]
        return [f.stem for f in files]

    def process_next(self) -> bool:
        waiting = [chunk for chunk in self.finished_chunks() if not self.spool.is_processed(chunk)]
        if not waiting:
            return False
        if len(waiting) > 1:
            log.warning("%d chunks waiting to be processed (about %d min behind)",
                        len(waiting), len(waiting) * self.segment_s // 60)

        chunk = waiting[0]
        segment = self.spool.segment(chunk)
        run_dir = self.spool.run_dir(chunk)
        shutil.rmtree(run_dir, ignore_errors=True)  # partial output from an interrupted run
        command = [
            sys.executable, str(INFERENCE),
            "--model", str(self.config.model),
            "--video", str(segment),
            "--calibration", str(self.config.calibration),
            "--run-name", chunk,
            "--output-root", str(self.spool.runs),
            "--device", self.config.gpu,
        ]
        if self.config.pathway_annotation:
            command += ["--pathway-annotation", str(self.config.pathway_annotation)]

        log_path = self.spool.logs / f"{chunk}.log"
        timeout_s = max(1800, 4 * self.segment_s)
        log.info("processing %s", segment.name)
        started = time.monotonic()
        with open(log_path, "wb") as output:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output,
                                       stderr=subprocess.STDOUT, cwd=HERE)
            while process.poll() is None:
                if self.stop.wait(2):
                    # Shutting down: drop the partial run; the chunk is redone on the next start.
                    process.terminate()
                    process.wait()
                    shutil.rmtree(run_dir, ignore_errors=True)
                    return True
                if time.monotonic() - started > timeout_s:
                    log.error("inference on %s still running after %d s; stopping it", segment.name, timeout_s)
                    process.kill()
                    process.wait()
                    break
        elapsed_s = time.monotonic() - started

        if process.returncode == 0 and self.spool.is_processed(chunk):
            summary = json.loads((run_dir / "scenario_summary.json").read_text(encoding="utf-8"))
            video_s = float(summary["video"]["duration_s"]) or 1.0
            log.info("processed %s in %.0f s (%.1fx real time), %d events",
                     segment.name, elapsed_s, elapsed_s / video_s, summary["event_summary"]["total_events"])
            if elapsed_s > video_s:
                log.warning("processing is slower than the camera records, so chunks will pile up; "
                            "use a TensorRT model (.engine) or lower the camera's frame rate")
            return True

        tail = log_path.read_text(encoding="utf-8", errors="replace")[-1500:] if log_path.exists() else ""
        log.error("inference failed on %s (exit code %s); moved to %s. End of %s:\n%s",
                  segment.name, process.returncode, self.spool.failed, log_path, tail)
        shutil.rmtree(run_dir, ignore_errors=True)
        if segment.exists():
            segment.replace(self.spool.failed / segment.name)
        return True

    # ── Reporting ─────────────────────────────────────────────────────────────

    def report_pending(self) -> None:
        if time.monotonic() < self.report_retry_at:
            return
        for run_dir in sorted(p for p in self.spool.runs.iterdir() if p.is_dir()):
            chunk = run_dir.name
            if self.stop.is_set():
                return
            if not self.spool.is_processed(chunk) or self.spool.is_reported(chunk):
                continue
            try:
                self.report(chunk)
            except IngestError as error:
                if should_retry(error):
                    self.report_backoff_s = min(MAX_REPORT_BACKOFF_S, max(10, self.report_backoff_s * 2))
                    self.report_retry_at = time.monotonic() + self.report_backoff_s
                    log.warning("could not report %s: %s; retrying in %d s", chunk, error, self.report_backoff_s)
                    return
                log.error("server rejected %s: %s; not retrying it", chunk, error)
                self._mark_reported(chunk, {"rejected": str(error)})
            except Exception as error:  # malformed output etc.; retrying won't help
                log.exception("could not report %s; not retrying it", chunk)
                self._mark_reported(chunk, {"failed": repr(error)})
            else:
                self.report_backoff_s = 0

    def report(self, chunk: str) -> None:
        run_dir = self.spool.run_dir(chunk)
        summary = json.loads((run_dir / "scenario_summary.json").read_text(encoding="utf-8"))
        started_at = datetime.strptime(chunk, CHUNK_NAME_FORMAT).replace(tzinfo=timezone.utc)
        ended_at = started_at + timedelta(seconds=float(summary["video"]["duration_s"]))
        incidents = build_incidents(load_events(run_dir), started_at)
        people = count_people_observed(run_dir)
        session_id = session_id_for(self.config.device_serial, chunk)

        incident_ids = self.client.report_session(session_id, started_at, ended_at, people, incidents, recording=chunk)
        if self.client.last_skipped_codes:
            log.warning("the dashboard has no violation type for %s; add it on the Configuration page "
                        "to record these", ", ".join(self.client.last_skipped_codes))

        # Clips already uploaded, so a retry after a network failure doesn't redo them.
        uploaded_path = run_dir / "clips_uploaded.json"
        uploaded = set(json.loads(uploaded_path.read_text())) if uploaded_path.exists() else set()
        source = (run_dir / "annotated_scenario_tracker.mp4" if self.config.clip_source == "annotated"
                  else self.spool.segment(chunk))
        for incident in incidents:
            track_id = incident["track_id"]
            incident_id = incident_ids.get(track_id)
            if incident_id is None or track_id in uploaded:
                continue
            clip = self.spool.clips / f"{chunk}_{track_id}.mp4"
            try:
                duration_s = cut_clip(source, incident["start_s"], incident["end_s"], clip)
                self.client.upload_clip(incident_id, clip, duration_s)
            except ClipError as error:
                log.warning("no clip for %s track %d: %s", chunk, track_id, error)
                continue
            except IngestError as error:
                if should_retry(error):
                    raise
                log.warning("clip for %s track %d rejected: %s", chunk, track_id, error)
                continue
            finally:
                clip.unlink(missing_ok=True)
            uploaded.add(track_id)
            uploaded_path.write_text(json.dumps(sorted(uploaded)))

        self._mark_reported(chunk, {"session_id": session_id, "incidents": len(incident_ids),
                                    "people_observed": people, "clips": len(uploaded)})
        # Tens of MB per chunk and only needed for the people count.
        (run_dir / "frame_scenario_state.jsonl").unlink(missing_ok=True)
        log.info("reported %s: %d incidents, %d people observed, %d clips",
                 chunk, len(incident_ids), people, len(uploaded))

    def _mark_reported(self, chunk: str, details: dict) -> None:
        details["at"] = datetime.now(timezone.utc).isoformat()
        (self.spool.run_dir(chunk) / "reported.json").write_text(json.dumps(details, indent=2))

    # ── Cleanup ───────────────────────────────────────────────────────────────

    def cleanup(self) -> None:
        keep_s = self.config.keep_hours * 3600
        now = time.time()

        reported = []
        for run_dir in sorted(p for p in self.spool.runs.iterdir() if p.is_dir()):
            marker = run_dir / "reported.json"
            if marker.exists():
                if now - marker.stat().st_mtime >= keep_s:
                    self.spool.remove_chunk(run_dir.name)
                else:
                    reported.append(run_dir.name)
        failed = sorted(self.spool.failed.glob("*.mp4"))
        for segment in list(failed):
            if now - segment.stat().st_mtime >= keep_s:
                segment.unlink(missing_ok=True)
                (self.spool.logs / f"{segment.stem}.log").unlink(missing_ok=True)
                failed.remove(segment)

        recorder_log = self.spool.logs / "recorder.log"
        if recorder_log.exists() and recorder_log.stat().st_size > 10_000_000:
            recorder_log.write_bytes(recorder_log.read_bytes()[-1_000_000:])

        # Disk filling up: delete what's already reported first, then failed
        # chunks, and only as a last resort footage not yet processed.
        while self.spool.free_gb() < MIN_FREE_GB:
            if reported:
                self.spool.remove_chunk(reported.pop(0))
            elif failed:
                failed.pop(0).unlink(missing_ok=True)
            else:
                waiting = [c for c in self.finished_chunks() if not self.spool.is_reported(c)]
                if not waiting:
                    if not self.disk_warned:
                        log.error("less than %.0f GB free and nothing left to delete", MIN_FREE_GB)
                        self.disk_warned = True
                    return
                log.error("disk nearly full: deleting %s before it was reported", waiting[0])
                self.spool.remove_chunk(waiting[0])
        self.disk_warned = False


def wait_for_clock(stop: threading.Event) -> None:
    """Without a network time sync a Jetson can boot with a clock in the past,
    which would put every chunk at the wrong time."""
    warned = False
    while datetime.now(timezone.utc).year < 2025 and not stop.is_set():
        if not warned:
            log.warning("system clock reads %s; waiting for it to sync before recording", datetime.now(timezone.utc))
            warned = True
        stop.wait(10)


def main() -> None:
    parser = argparse.ArgumentParser(description="Runs this Jetson's camera as a dashboard device.")
    parser.add_argument("--config", help="device.env to use (default: device.env next to this file)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)

    try:
        config = load_config(args.config)
    except ConfigError as error:
        log.error("%s", error)
        sys.exit(1)
    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            log.error("%s is not installed (sudo apt install ffmpeg)", tool)
            sys.exit(1)

    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())

    log.info("device %s reporting to %s", config.device_serial, config.ingest_url)
    wait_for_clock(stop)
    Agent(config, stop).run()


if __name__ == "__main__":
    main()
