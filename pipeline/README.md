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
