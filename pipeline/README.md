# Detection pipeline

Runs the PPE / proximity tracker over video and reports incidents to Supabase
through the `ingest` edge function, the same endpoint the Jetson Orin Nano uses.

## Setup

```sh
cd pipeline
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env   # then fill in the device key
```

Files that stay out of git, in `data/`:

- `data/models/best.pt`: detector weights (classes 0 Person, 1 Safety_Vest, 2 Vehicle)
- `data/videos/`: recordings, named as the recorder names them
- `data/outputs/`: results per recording

## Recording names

The recorder's file names carry the camera and the start time, and the pipeline
reads both from them:

```
2026_08_18_FMDC1_00_20260818082151.mp4  →  device FMDC1_00, started 2026-08-18 08:21:51 (site time)
```

The device serial must exist in the `devices` table, and `.env` needs a
`DEVICE_KEY_<serial>` whose SHA-256 hash is that device's `key_hash`.

## Running

```sh
.venv/bin/python process_recordings.py data/videos                    # detect only
.venv/bin/python process_recordings.py data/videos --upload --clips   # detect and report
```

Options: `--calibration <json>` uses the camera's height calibration for
person-near-vehicle distances (without it, distances are estimated by assuming
people are 170 cm tall), `--distance-m <m>` changes the alert threshold from
2 m, `--annotate` writes an annotated video, `--force` reprocesses recordings
that already have results.

Reporting is idempotent: each recording maps to a fixed session id, so
reporting it again updates its incidents instead of duplicating them.

## Viewing older footage

The dashboard shows today, this week and this month. To see a recorded day, open
it with `?asOf=YYYY-MM-DD`, for example `http://localhost:5173/?asOf=2026-08-18`.
