# Detection pipeline

`inference.py` is `Inference_Script.ipynb` and `Path_Segmentation_Script.ipynb`
ported 1-for-1 into one script. The detection, tracking and event logic is the
notebook code unchanged; only the Drive paths became command-line options and
the Colab-only lines were removed. See the docstring at the top of the file.

## Setup

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Files that stay out of git:

- `models/best.pt`: detector weights (classes 0 Person, 1 Safety_Vest, 2 Vehicle)
- `config/`: per-camera `y_pixel_to_height_scale_lookup.json` (height calibration)
  and the pathway annotation (LabelMe JSON)
- `outputs/`: one folder per run

## Running

```sh
.venv/bin/python inference.py \
    --model models/best.pt \
    --video path/to/video.mp4 \
    --calibration config/y_pixel_to_height_scale_lookup.json \
    --run-name first_test \
    --pathway-annotation config/pathway.json --draw-pathway
```

`--pathway-annotation` is optional. The pathway image defaults to the video's
first frame; pass `--pathway-image` for a still image instead. The annotation
must match the image size. `--device cpu` runs without a GPU.

Outputs in `outputs/<run-name>/`: `annotated_scenario_tracker.mp4`,
`frame_scenario_state.jsonl`, `scenario_events.json`, `scenario_summary.json`,
and `path_segmentation/` (mask, isolated path, overlay). A run name can't be
reused, so earlier results are never overwritten.

## Reporting from the device agent

The agent reports session metadata and one incident per event before its existing
clip upload loop. The response in `report_response.json` maps episode IDs to
backend incident IDs. `session_id.txt` stores this run's session identity.

Apply `20261104170000_incident_episodes.sql`, then deploy the updated `ingest`
function before reporting. The database now identifies incidents by episode,
allowing multiple episodes for the same person. Older clients use a
`track:<id>` fallback. Configure `person_near_vehicle` in the dashboard's
violation types so the backend accepts proximity events.

Recording timestamps come from the filename's final 14 digits. The timezone is
`CAMERA_TIMEZONE` (default `Europe/London`). Alternatively set
`RECORDING_STARTED_AT` to an ISO timestamp including offset. Person counts are
tracks observed for at least one second, including non-violating tracks.

The inference geometry/rider/motion bypass produces test alerts. Historical
recordings appear at their recording date in the dashboard.

To report only metadata from an existing run (no inference or clip upload):

```sh
python3 device_agent.py --run-dir outputs/first_agent_test --metadata-only
```

Deploy backend changes from the repository root, after checking the dry-run:

```sh
supabase db push --dry-run
supabase db push
supabase functions deploy ingest
```

The database migration must precede deployment of the function. These commands
change the linked hosted project; they are not run automatically by the agent.
