
"""
PPE / geometry / proximity scenario tracker with pathway segmentation.

Ported 1-for-1 from Inference_Script.ipynb (scenario_tracker_v1_fix6) and
Path_Segmentation_Script.ipynb. The detection, tracking, scoring and drawing
logic is the notebook code unchanged. Only these were changed:

  - Google Drive paths and RUN_NAME / DEVICE come from command-line options.
  - Colab-only lines (drive.mount, pip install, cd, cv2_imshow) are removed.
  - The path segmentation notebook runs once before the video loop, wrapped in
    run_path_segmentation(). It is optional (--pathway-annotation).
  - --draw-pathway shades the pathway on the annotated video, using the path
    segmentation notebook's overlay drawing. Off by default.

The pathway mask is not used by any detection or event logic: neither notebook
defines a pathway rule.

Usage:
    python inference.py --model models/best.pt --video video.mp4 \
        --calibration config/y_pixel_to_height_scale_lookup.json \
        --run-name test_run_1 \
        [--pathway-annotation config/pathway.json] [--draw-pathway]
"""
import argparse


parser = argparse.ArgumentParser(
    description="Integrated PPE / geometry / proximity scenario tracker.",
)
parser.add_argument("--model", required=True, help="YOLO weights (best.pt)")
parser.add_argument("--video", required=True, help="Input video file")
parser.add_argument(
    "--calibration",
    required=True,
    help="y_pixel_to_height_scale_lookup.json from the height calibration stage",
)
parser.add_argument(
    "--run-name",
    required=True,
    help="Name of this run; outputs go to <output-root>/<run-name>",
)
parser.add_argument(
    "--output-root",
    default="outputs",
    help="Folder that holds one subfolder per run (default: outputs)",
)
parser.add_argument(
    "--device",
    default="0",
    help="GPU index, or 'cpu' (default: 0)",
)
parser.add_argument(
    "--pathway-annotation",
    default=None,
    help="LabelMe JSON with the pathway polygon(s). Omit to skip path segmentation.",
)
parser.add_argument(
    "--pathway-image",
    default=None,
    help=(
        "Image the pathway was annotated on. "
        "Defaults to the first frame of --video."
    ),
)
parser.add_argument(
    "--pathway-label",
    default="Pathway",
    help="Polygon label to use as the pathway (default: Pathway)",
)
parser.add_argument(
    "--draw-pathway",
    action="store_true",
    help="Shade the pathway on the annotated output video",
)
args = parser.parse_args()

from ultralytics import YOLO
from pathlib import Path
from collections import defaultdict, deque, Counter
from tqdm.auto import tqdm
from itertools import combinations, product
import cv2
import numpy as np
import json
import math
import time
import uuid


# ── Paths ─────────────────────────────────────────────────────────────────────

MODEL_PATH = args.model

# Set this to the warehouse video you want to process.
VIDEO_PATH = args.video

# Produced by your previous quadratic pixel-to-centimetre calibration stage.
CALIBRATION_LOOKUP_JSON_PATH = args.calibration


# ── Output directory ──────────────────────────────────────────────────────────

RUN_NAME = args.run_name

OUTPUT_DIR = Path(args.output_root) / RUN_NAME

OUTPUT_VIDEO_PATH = OUTPUT_DIR / "annotated_scenario_tracker.mp4"
FRAME_LOG_JSONL_PATH = OUTPUT_DIR / "frame_scenario_state.jsonl"
EVENTS_JSON_PATH = OUTPUT_DIR / "scenario_events.json"
SUMMARY_JSON_PATH = OUTPUT_DIR / "scenario_summary.json"


# ── Model classes ─────────────────────────────────────────────────────────────

PERSON_CLASS_ID = 0
VEST_CLASS_ID = 1
VEHICLE_CLASS_ID = 2


# ── Detector and tracker settings ─────────────────────────────────────────────

TRACKER_CONFIG = "botsort.yaml"

# Keep this consistent with the calibration profile for this initial version.
IMAGE_SIZE = 960
DEVICE = int(args.device) if args.device.isdigit() else args.device

CONFIDENCE_THRESHOLD = 0.40
NMS_IOU_THRESHOLD = 0.70

# Vest detections can be accepted at a lower threshold because their final use
# is gated by person-torso association and temporal evidence.
VEST_CONFIDENCE_THRESHOLD = 0.25

VIDEO_CODEC = "mp4v"
DRAW_RAW_TRACKER_BOXES = True
WRITE_FRAME_JSONL = True


# ── Vest-to-person association settings ───────────────────────────────────────

MIN_VEST_ASSOCIATION_SCORE = 0.55

VEST_HISTORY_FRAMES = 30
MIN_VEST_VALID_OBSERVATIONS = 10
VEST_PRESENT_RATIO_THRESHOLD = 0.60
VEST_REVIEW_RATIO_THRESHOLD = 0.15


# ── Person geometry / calibration settings ────────────────────────────────────

MIN_PERSON_BOX_HEIGHT_PX = 90.0
MIN_PERSON_BOX_WIDTH_PX = 15.0
EDGE_MARGIN_PX = 4

# Observed normal walking range from your aspect-ratio analysis.
NORMAL_WIDTH_HEIGHT_RATIO_MIN = 0.35
NORMAL_WIDTH_HEIGHT_RATIO_MAX = 0.75

# Above this, geometry becomes a caution signal; this is not proof of occlusion.
RATIO_CAUTION_THRESHOLD = 0.75
RATIO_STRONG_THRESHOLD = 0.95

RATIO_SMOOTHING_WINDOW = 7
CAUTION_PERSISTENCE_FRAMES = 5
STRONG_PERSISTENCE_FRAMES = 8

# Current quadratic calibration uses an expected person-box height relationship.
# Your previous analysis used centroid y. This first integration therefore
# uses centroid y for scale consistency.
MIN_EXPECTED_HEIGHT_RATIO = 0.70
MAX_EXPECTED_HEIGHT_RATIO = 1.30


# ── Approximate proximity settings ────────────────────────────────────────────

PERSON_VEHICLE_THRESHOLD_M = 2.0
PERSON_PERSON_THRESHOLD_M = 1.5

# Local scale is most defensible when pair floor proxies are at broadly similar
# depths in the image. Keep this conservative for a prototype.
MAX_PAIR_FOOT_Y_DIFFERENCE_PX = 250.0

PROXIMITY_HISTORY_FRAMES = 15
PROXIMITY_PERSISTENCE_FRAMES = 8

# Do not produce a vehicle-risk event unless vehicle motion is evident recently.
VEHICLE_MOTION_HISTORY_FRAMES = 100
VEHICLE_MOTION_LOOKBACK_FRAMES = 20
VEHICLE_MOVING_DISPLACEMENT_PX = 12.0
VEHICLE_MOVING_RECENT_RATIO_THRESHOLD = 0.15


# ── Rider association settings ────────────────────────────────────────────────

# A rider/operator must be much closer than ordinary proximity threshold.
RIDER_DISTANCE_THRESHOLD_M = 1.0

# Require overlap, containment, foot-point compatibility, or shared movement.
MIN_PERSON_IN_VEHICLE_CONTAINMENT = 0.20
MIN_PERSON_VEHICLE_IOU = 0.05

# Expansion accommodates imperfect vehicle box boundaries.
VEHICLE_ZONE_HORIZONTAL_EXPANSION = 0.10
VEHICLE_ZONE_VERTICAL_EXPANSION = 0.10

RIDER_CANDIDATE_PERSISTENCE_FRAMES = 8
RIDER_CONFIRM_PERSISTENCE_FRAMES = 15
RIDER_MEMORY_FRAMES = 100

# An operator/rider is usually best represented by one person per vehicle.
# The highest persistent candidate wins.
ONE_ASSOCIATED_PERSON_PER_VEHICLE = True


# ── State cleanup / confidence ────────────────────────────────────────────────

STALE_TRACK_FRAMES = 90
STALE_PAIR_FRAMES = 90

HIGH_CONFIDENCE_THRESHOLD = 0.80
CAUTION_CONFIDENCE_THRESHOLD = 0.55


# ── Rendering ─────────────────────────────────────────────────────────────────

FONT = cv2.FONT_HERSHEY_SIMPLEX

PANEL_WIDTH = 560
PANEL_HEADER_HEIGHT = 42
PANEL_ROW_HEIGHT = 67
PANEL_PADDING = 12


# ── Generic helpers ───────────────────────────────────────────────────────────

def rounded(value, decimals=3):
    return round(float(value), decimals)


def clamp(value, minimum=0.0, maximum=1.0):
    return max(minimum, min(maximum, float(value)))


def box_area(box):
    x1, y1, x2, y2 = map(float, box)
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def intersection_box(box_a, box_b):
    ax1, ay1, ax2, ay2 = map(float, box_a)
    bx1, by1, bx2, by2 = map(float, box_b)

    return (
        max(ax1, bx1),
        max(ay1, by1),
        min(ax2, bx2),
        min(ay2, by2),
    )


def intersection_area(box_a, box_b):
    return box_area(intersection_box(box_a, box_b))


def iou(box_a, box_b):
    intersection = intersection_area(box_a, box_b)
    union = box_area(box_a) + box_area(box_b) - intersection
    return intersection / union if union > 0 else 0.0


def contains_point(box, point_xy):
    x1, y1, x2, y2 = map(float, box)
    x, y = map(float, point_xy)
    return x1 <= x <= x2 and y1 <= y <= y2


def expand_box(box, horizontal_fraction, vertical_fraction):
    x1, y1, x2, y2 = map(float, box)
    width = x2 - x1
    height = y2 - y1

    return (
        x1 - horizontal_fraction * width,
        y1 - vertical_fraction * height,
        x2 + horizontal_fraction * width,
        y2 + vertical_fraction * height,
    )


def person_containment_in_vehicle(person_box, vehicle_box):
    person_area = box_area(person_box)
    if person_area <= 0:
        return 0.0

    return intersection_area(person_box, vehicle_box) / person_area


def clip_box_xyxy(box, frame_width, frame_height):
    x1, y1, x2, y2 = map(float, box)

    return (
        max(0.0, min(x1, frame_width - 1.0)),
        max(0.0, min(y1, frame_height - 1.0)),
        max(0.0, min(x2, frame_width - 1.0)),
        max(0.0, min(y2, frame_height - 1.0)),
    )


def box_touches_edge(box, frame_width, frame_height, margin_px):
    x1, y1, x2, y2 = box

    return (
        x1 <= margin_px
        or y1 <= margin_px
        or x2 >= frame_width - 1 - margin_px
        or y2 >= frame_height - 1 - margin_px
    )


def centroid(box):
    x1, y1, x2, y2 = map(float, box)
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


def bottom_centre(box):
    x1, y1, x2, y2 = map(float, box)
    return ((x1 + x2) / 2.0, y2)


def euclidean_distance(point_a, point_b):
    ax, ay = map(float, point_a)
    bx, by = map(float, point_b)
    return math.hypot(ax - bx, ay - by)


def torso_box(person_box):
    x1, y1, x2, y2 = map(float, person_box)
    width = x2 - x1
    height = y2 - y1

    return (
        x1 + 0.10 * width,
        y1 + 0.20 * height,
        x2 - 0.10 * width,
        y1 + 0.75 * height,
    )


def draw_label(image, text, origin_xy, colour, scale=0.48, thickness=1):
    x, y = map(int, origin_xy)

    (text_w, text_h), baseline = cv2.getTextSize(
        text,
        FONT,
        scale,
        thickness,
    )

    x = max(0, min(x, image.shape[1] - text_w - 10))
    y = max(text_h + baseline + 10, min(y, image.shape[0] - 4))

    cv2.rectangle(
        image,
        (x, y - text_h - baseline - 8),
        (x + text_w + 10, y + 3),
        colour,
        -1,
    )

    cv2.putText(
        image,
        text,
        (x + 5, y - baseline - 2),
        FONT,
        scale,
        (255, 255, 255),
        thickness,
        cv2.LINE_AA,
    )


# ── Vest association ──────────────────────────────────────────────────────────

def vest_association_score(person_box, vest_box):
    vest_area = box_area(vest_box)
    person_area = box_area(person_box)

    if vest_area <= 0 or person_area <= 0:
        return 0.0

    torso = torso_box(person_box)

    contained_in_person = (
        intersection_area(person_box, vest_box) / vest_area
    )

    torso_overlap = iou(torso, vest_box)

    vest_centre = centroid(vest_box)
    centre_in_torso = float(contains_point(torso, vest_centre))

    relative_area = vest_area / person_area
    size_plausible = float(0.01 <= relative_area <= 0.65)

    return (
        0.45 * contained_in_person
        + 0.30 * torso_overlap
        + 0.20 * centre_in_torso
        + 0.05 * size_plausible
    )


def assign_vests_to_people(persons, vests, min_score):
    candidates = []

    for vest_index, vest in enumerate(vests):
        for person in persons:
            score = vest_association_score(
                person["bbox"],
                vest["bbox"],
            )

            if score >= min_score:
                candidates.append(
                    (float(score), person["track_id"], vest_index)
                )

    candidates.sort(reverse=True, key=lambda item: item[0])

    assigned_people = set()
    assigned_vests = set()
    assignments = {}

    for score, person_id, vest_index in candidates:
        if person_id in assigned_people or vest_index in assigned_vests:
            continue

        assignments[person_id] = {
            "vest_index": int(vest_index),
            "association_score": float(score),
        }

        assigned_people.add(person_id)
        assigned_vests.add(vest_index)

    return assignments


# ── State factories ───────────────────────────────────────────────────────────

def new_person_state():
    return {
        "vest_history": deque(maxlen=VEST_HISTORY_FRAMES),
        "geometry_history": deque(maxlen=VEST_HISTORY_FRAMES),
        "ratio_history": deque(maxlen=RATIO_SMOOTHING_WINDOW),
        "rider_history": deque(maxlen=RIDER_CONFIRM_PERSISTENCE_FRAMES),
        "last_seen_frame": -1,
        "vest_state": "VEST_UNKNOWN",
        "geometry_state": "GEOMETRY_UNKNOWN",
        "rider_state": "PEDESTRIAN",
        "associated_vehicle_id": None,
        "rider_memory_until": -1,
        "strong_ratio_count": 0,
        "caution_ratio_count": 0,
    }


def new_vehicle_state():
    return {
        "position_history": deque(maxlen=VEHICLE_MOTION_HISTORY_FRAMES),
        "last_seen_frame": -1,
        "motion_state": "UNKNOWN",
        "motion_score": 0.0,
        "recent_displacement_px": 0.0,
    }


def new_pair_state():
    return {
        "distance_history_m": deque(maxlen=PROXIMITY_HISTORY_FRAMES),
        "under_threshold_history": deque(
            maxlen=PROXIMITY_PERSISTENCE_FRAMES
        ),
        "rider_evidence_history": deque(
            maxlen=RIDER_CONFIRM_PERSISTENCE_FRAMES
        ),
        "last_seen_frame": -1,
        "proximity_state": "UNKNOWN",
        "active_event_id": None,
    }


# ── Geometry / calibration ────────────────────────────────────────────────────

def evaluate_person_geometry(
    person,
    frame_width,
    frame_height,
    quadratic_a,
    quadratic_b,
    quadratic_c,
    calibration_y_min,
    calibration_y_max,
):
    box = person["bbox"]
    x1, y1, x2, y2 = box

    box_width = x2 - x1
    box_height = y2 - y1

    centre_x, centre_y = centroid(box)
    foot_x, foot_y = bottom_centre(box)

    ratio = (
        box_width / box_height
        if box_height > 0
        else float("nan")
    )

    issues = []

    if box_width < MIN_PERSON_BOX_WIDTH_PX:
        issues.append("box_too_narrow")

    if box_height < MIN_PERSON_BOX_HEIGHT_PX:
        issues.append("box_too_short")

    if box_touches_edge(
        box,
        frame_width,
        frame_height,
        EDGE_MARGIN_PX,
    ):
        issues.append("box_touches_edge")

    # Current calibration profile was fitted using centroid y.
    if not (calibration_y_min <= centre_y <= calibration_y_max):
        issues.append("centroid_y_outside_calibration")

    expected_height_px = None
    observed_expected_height_ratio = None
    cm_per_pixel = None
    estimated_height_cm = None

    if not issues:
        expected_height_px = (
            quadratic_a * centre_y**2
            + quadratic_b * centre_y
            + quadratic_c
        )

        if expected_height_px <= 0:
            issues.append("invalid_expected_height")

        else:
            observed_expected_height_ratio = (
                box_height / expected_height_px
            )

            if not (
                MIN_EXPECTED_HEIGHT_RATIO
                <= observed_expected_height_ratio
                <= MAX_EXPECTED_HEIGHT_RATIO
            ):
                issues.append("height_inconsistent_with_calibration")

            cm_per_pixel = (
                REFERENCE_PERSON_HEIGHT_CM / expected_height_px
            )

            estimated_height_cm = box_height * cm_per_pixel

    return {
        "bbox_width_px": float(box_width),
        "bbox_height_px": float(box_height),
        "centroid_px": (float(centre_x), float(centre_y)),
        "foot_point_px": (float(foot_x), float(foot_y)),
        "width_to_height_ratio": float(ratio),
        "expected_height_px": (
            float(expected_height_px)
            if expected_height_px is not None
            else None
        ),
        "height_ratio": (
            float(observed_expected_height_ratio)
            if observed_expected_height_ratio is not None
            else None
        ),
        "cm_per_pixel": (
            float(cm_per_pixel)
            if cm_per_pixel is not None
            else None
        ),
        "estimated_height_cm": (
            float(estimated_height_cm)
            if estimated_height_cm is not None
            else None
        ),
        "issues": issues,
    }


def update_geometry_state(person_state, geometry):
    ratio = geometry["width_to_height_ratio"]
    issues = list(geometry["issues"])

    person_state["ratio_history"].append(float(ratio))
    ratio_smoothed = float(np.median(person_state["ratio_history"]))

    if ratio_smoothed >= RATIO_STRONG_THRESHOLD:
        person_state["strong_ratio_count"] += 1
    else:
        person_state["strong_ratio_count"] = 0

    if ratio_smoothed >= RATIO_CAUTION_THRESHOLD:
        person_state["caution_ratio_count"] += 1
    else:
        person_state["caution_ratio_count"] = 0

    if issues:
        state = "GEOMETRY_UNSUITABLE"

    elif (
        person_state["strong_ratio_count"]
        >= STRONG_PERSISTENCE_FRAMES
    ):
        state = "GEOMETRY_STRONG_ANOMALY"

    elif (
        person_state["caution_ratio_count"]
        >= CAUTION_PERSISTENCE_FRAMES
    ):
        state = "GEOMETRY_CAUTION"

    else:
        state = "GEOMETRY_USABLE"

    person_state["geometry_history"].append(
        1 if state == "GEOMETRY_USABLE" else 0
    )
    person_state["geometry_state"] = state

    return {
        "state": state,
        "ratio_smoothed": ratio_smoothed,
        "strong_ratio_count": person_state["strong_ratio_count"],
        "caution_ratio_count": person_state["caution_ratio_count"],
        "issues": issues,
    }


def geometry_confidence(person, geometry_status):
    confidence = clamp(person["confidence"])

    if geometry_status["state"] == "GEOMETRY_USABLE":
        return confidence

    if geometry_status["state"] == "GEOMETRY_CAUTION":
        return 0.50 * confidence

    if geometry_status["state"] == "GEOMETRY_STRONG_ANOMALY":
        return 0.30 * confidence

    return 0.0


# ── Temporal PPE state ────────────────────────────────────────────────────────

def update_vest_state(person_state, vest_seen_this_frame, geometry_state):
    # Only use geometry-usable frames as evidence for an absent/present vest.
    if geometry_state == "GEOMETRY_USABLE":
        person_state["vest_history"].append(
            1 if vest_seen_this_frame else 0
        )

    history = person_state["vest_history"]

    if len(history) < MIN_VEST_VALID_OBSERVATIONS:
        state = "VEST_UNKNOWN"
        ratio = sum(history) / len(history) if history else 0.0

    else:
        ratio = sum(history) / len(history)

        if ratio >= VEST_PRESENT_RATIO_THRESHOLD:
            state = "VEST_PRESENT"

        elif ratio <= VEST_REVIEW_RATIO_THRESHOLD:
            state = "VEST_REVIEW"

        else:
            state = "VEST_UNKNOWN"

    person_state["vest_state"] = state

    return {
        "state": state,
        "valid_observations": int(len(history)),
        "vest_evidence_ratio": float(ratio),
    }


# ── Vehicle motion ────────────────────────────────────────────────────────────

def update_vehicle_motion(vehicle_state, vehicle, frame_index):
    point = bottom_centre(vehicle["bbox"])

    vehicle_state["position_history"].append(
        {
            "frame_index": int(frame_index),
            "point": (float(point[0]), float(point[1])),
        }
    )

    history = vehicle_state["position_history"]

    if len(history) <= VEHICLE_MOTION_LOOKBACK_FRAMES:
        vehicle_state["motion_state"] = "UNKNOWN"
        vehicle_state["motion_score"] = 0.0
        vehicle_state["recent_displacement_px"] = 0.0

        return {
            "state": "UNKNOWN",
            "motion_score": 0.0,
            "recent_displacement_px": 0.0,
            "foot_point_px": point,
        }

    recent_displacements = []

    for index in range(
        VEHICLE_MOTION_LOOKBACK_FRAMES,
        len(history),
    ):
        recent = history[index]["point"]
        prior = history[index - VEHICLE_MOTION_LOOKBACK_FRAMES]["point"]

        recent_displacements.append(
            euclidean_distance(recent, prior)
        )

    moving_flags = [
        displacement >= VEHICLE_MOVING_DISPLACEMENT_PX
        for displacement in recent_displacements
    ]

    motion_score = (
        sum(moving_flags) / len(moving_flags)
        if moving_flags
        else 0.0
    )

    current_displacement = (
        recent_displacements[-1]
        if recent_displacements
        else 0.0
    )

    if current_displacement >= VEHICLE_MOVING_DISPLACEMENT_PX:
        state = "MOVING"

    elif motion_score >= VEHICLE_MOVING_RECENT_RATIO_THRESHOLD:
        state = "RECENTLY_MOVING"

    else:
        state = "STATIONARY"

    vehicle_state["motion_state"] = state
    vehicle_state["motion_score"] = float(motion_score)
    vehicle_state["recent_displacement_px"] = float(
        current_displacement
    )

    return {
        "state": state,
        "motion_score": float(motion_score),
        "recent_displacement_px": float(current_displacement),
        "foot_point_px": point,
    }


# ── Approximate calibrated distance ───────────────────────────────────────────

def approximate_distance_m(person, other, geometry):
    """
    Local image-plane distance estimate using the person calibration scale.

    This is deliberately conservative:
    - Uses the person's valid cm-per-pixel scale.
    - Rejects pairs whose image-depth proxy differs too much.
    - Does not claim full ground-plane metric accuracy.
    """
    cm_per_pixel = geometry.get("cm_per_pixel")

    if cm_per_pixel is None:
        return None, "person_scale_unavailable", None

    person_foot = geometry["foot_point_px"]
    other_foot = bottom_centre(other["bbox"])

    foot_y_gap_px = abs(person_foot[1] - other_foot[1])

    if foot_y_gap_px > MAX_PAIR_FOOT_Y_DIFFERENCE_PX:
        return None, "pair_depth_gap_too_large", foot_y_gap_px

    pixel_distance = euclidean_distance(person_foot, other_foot)

    distance_m = (pixel_distance * cm_per_pixel) / 100.0

    return float(distance_m), "local_scale_valid", float(foot_y_gap_px)


# ── Rider association ─────────────────────────────────────────────────────────

def rider_evidence(
    person,
    vehicle,
    geometry,
    distance_m,
):
    if distance_m is None:
        return {
            "is_candidate": False,
            "score": 0.0,
            "reasons": ["distance_unavailable"],
            "containment": 0.0,
            "iou": 0.0,
            "foot_inside_vehicle_zone": False,
        }

    containment = person_containment_in_vehicle(
        person["bbox"],
        vehicle["bbox"],
    )

    overlap_iou = iou(person["bbox"], vehicle["bbox"])

    vehicle_zone = expand_box(
        vehicle["bbox"],
        VEHICLE_ZONE_HORIZONTAL_EXPANSION,
        VEHICLE_ZONE_VERTICAL_EXPANSION,
    )

    foot_inside_vehicle_zone = contains_point(
        vehicle_zone,
        geometry["foot_point_px"],
    )

    close = distance_m < RIDER_DISTANCE_THRESHOLD_M

    abnormal_geometry = (
        geometry["width_to_height_ratio"] >= RATIO_CAUTION_THRESHOLD
        or (
            geometry["height_ratio"] is not None
            and geometry["height_ratio"] < MIN_EXPECTED_HEIGHT_RATIO
        )
    )

    spatial_compatible = (
        containment >= MIN_PERSON_IN_VEHICLE_CONTAINMENT
        or overlap_iou >= MIN_PERSON_VEHICLE_IOU
        or foot_inside_vehicle_zone
    )

    score = (
        0.35 * clamp(1.0 - distance_m / RIDER_DISTANCE_THRESHOLD_M)
        + 0.30 * clamp(containment / 0.50)
        + 0.15 * clamp(overlap_iou / 0.20)
        + 0.10 * float(foot_inside_vehicle_zone)
        + 0.10 * float(abnormal_geometry)
    )

    candidate = close and spatial_compatible

    reasons = []

    if close:
        reasons.append("very_close_to_vehicle")

    if containment >= MIN_PERSON_IN_VEHICLE_CONTAINMENT:
        reasons.append("person_contained_in_vehicle_box")

    if overlap_iou >= MIN_PERSON_VEHICLE_IOU:
        reasons.append("person_vehicle_overlap")

    if foot_inside_vehicle_zone:
        reasons.append("person_foot_in_vehicle_zone")

    if abnormal_geometry:
        reasons.append("person_geometry_abnormal")

    return {
        "is_candidate": candidate,
        "score": float(score),
        "reasons": reasons,
        "containment": float(containment),
        "iou": float(overlap_iou),
        "foot_inside_vehicle_zone": bool(foot_inside_vehicle_zone),
    }


def update_rider_state(
    person_state,
    candidate_vehicle_id,
    candidate_evidence,
    frame_index,
):
    if candidate_vehicle_id is None:
        if frame_index <= person_state["rider_memory_until"]:
            person_state["rider_state"] = "RIDER_MEMORY"

        else:
            person_state["rider_state"] = "PEDESTRIAN"
            person_state["associated_vehicle_id"] = None

        return {
            "state": person_state["rider_state"],
            "associated_vehicle_id": person_state["associated_vehicle_id"],
            "persistence": 0,
        }

    person_state["rider_history"].append(
        {
            "vehicle_id": int(candidate_vehicle_id),
            "is_candidate": bool(candidate_evidence["is_candidate"]),
            "score": float(candidate_evidence["score"]),
        }
    )

    matching_candidates = [
        item
        for item in person_state["rider_history"]
        if item["vehicle_id"] == candidate_vehicle_id
        and item["is_candidate"]
    ]

    persistence = len(matching_candidates)

    if persistence >= RIDER_CONFIRM_PERSISTENCE_FRAMES:
        person_state["rider_state"] = "CONFIRMED_RIDER"
        person_state["associated_vehicle_id"] = int(candidate_vehicle_id)
        person_state["rider_memory_until"] = (
            frame_index + RIDER_MEMORY_FRAMES
        )

    elif persistence >= RIDER_CANDIDATE_PERSISTENCE_FRAMES:
        person_state["rider_state"] = "POSSIBLE_RIDER"
        person_state["associated_vehicle_id"] = int(candidate_vehicle_id)

    elif frame_index <= person_state["rider_memory_until"]:
        person_state["rider_state"] = "RIDER_MEMORY"

    else:
        person_state["rider_state"] = "PEDESTRIAN"
        person_state["associated_vehicle_id"] = None

    return {
        "state": person_state["rider_state"],
        "associated_vehicle_id": person_state["associated_vehicle_id"],
        "persistence": int(persistence),
    }


# ── Event management ──────────────────────────────────────────────────────────

def create_event(
    event_type,
    frame_index,
    timestamp_s,
    person_id=None,
    vehicle_id=None,
    second_person_id=None,
    metadata=None,
):
    return {
        "event_id": str(uuid.uuid4()),
        "event_type": event_type,
        "person_track_id": person_id,
        "vehicle_track_id": vehicle_id,
        "second_person_track_id": second_person_id,
        "start_frame_index": int(frame_index),
        "end_frame_index": None,
        "start_timestamp_s": rounded(timestamp_s),
        "end_timestamp_s": None,
        "duration_s": None,
        "minimum_distance_m": None,
        "maximum_confidence": 0.0,
        "mean_confidence_values": [],
        "reasons": [],
        "metadata": metadata or {},
        "outcome": "ACTIVE",
    }


def update_event(event, timestamp_s, confidence, distance_m=None, reasons=None):
    event["end_timestamp_s"] = rounded(timestamp_s)
    event["maximum_confidence"] = max(
        event["maximum_confidence"],
        float(confidence),
    )

    event["mean_confidence_values"].append(float(confidence))

    if distance_m is not None:
        if event["minimum_distance_m"] is None:
            event["minimum_distance_m"] = float(distance_m)
        else:
            event["minimum_distance_m"] = min(
                event["minimum_distance_m"],
                float(distance_m),
            )

    if reasons:
        event["reasons"] = list(
            dict.fromkeys(event["reasons"] + list(reasons))
        )


def close_event(event, frame_index, timestamp_s, outcome="RESOLVED"):
    event["end_frame_index"] = int(frame_index)
    event["end_timestamp_s"] = rounded(timestamp_s)
    event["duration_s"] = rounded(
        timestamp_s - event["start_timestamp_s"]
    )

    confidence_values = event.pop("mean_confidence_values", [])

    event["mean_confidence"] = (
        rounded(np.mean(confidence_values))
        if confidence_values
        else 0.0
    )

    event["outcome"] = outcome


# ── Panel rendering ───────────────────────────────────────────────────────────

def draw_scene_panel(image, persons, vehicles, pair_results):
    active_people = sorted(persons, key=lambda item: item["track_id"])

    active_alerts = sum(
        1
        for result in pair_results
        if result["proximity_state"] == "PROXIMITY_ALERT"
    )

    moving_vehicles = sum(
        1
        for vehicle in vehicles
        if vehicle.get("motion", {}).get("state")
        in {"MOVING", "RECENTLY_MOVING"}
    )

    x2 = image.shape[1] - 12
    x1 = max(0, x2 - PANEL_WIDTH)
    y1 = 12

    panel_height = (
        PANEL_HEADER_HEIGHT
        + 62
        + max(1, len(active_people)) * PANEL_ROW_HEIGHT
        + PANEL_PADDING
    )

    y2 = min(image.shape[0] - 1, y1 + panel_height)

    overlay = image.copy()
    cv2.rectangle(overlay, (x1, y1), (x2, y2), (20, 20, 20), -1)
    cv2.addWeighted(overlay, 0.80, image, 0.20, 0, image)
    cv2.rectangle(image, (x1, y1), (x2, y2), (210, 210, 210), 2)

    cv2.putText(
        image,
        "WAREHOUSE SCENARIO TRACKER",
        (x1 + PANEL_PADDING, y1 + 29),
        FONT,
        0.67,
        (255, 255, 255),
        2,
        cv2.LINE_AA,
    )

    scene_text = (
        f"People: {len(active_people)} | "
        f"Vehicles: {len(vehicles)} | "
        f"Moving/recent: {moving_vehicles} | "
        f"Alerts: {active_alerts}"
    )

    cv2.putText(
        image,
        scene_text,
        (x1 + PANEL_PADDING, y1 + 53),
        FONT,
        0.43,
        (220, 220, 220),
        1,
        cv2.LINE_AA,
    )

    if not active_people:
        cv2.putText(
            image,
            "No active person tracks",
            (x1 + PANEL_PADDING, y1 + 92),
            FONT,
            0.55,
            (220, 220, 220),
            1,
            cv2.LINE_AA,
        )
        return

    for row, person in enumerate(active_people):
        top = y1 + 70 + row * PANEL_ROW_HEIGHT

        vest_state = person['vest_temporal']['state']
        geometry_state = person["geometry"]["state"]
        rider_state = person["rider"]["state"]

        if person["risk_state"] == "PROXIMITY_ALERT":
            colour = (0, 0, 255)

        elif person["risk_state"] == "PROXIMITY_CAUTION":
            colour = (0, 165, 255)

        elif geometry_state == "GEOMETRY_UNSUITABLE":
            colour = (60, 60, 220)

        elif vest_state == "VEST_REVIEW":
            colour = (0, 165, 255)

        elif rider_state in {"POSSIBLE_RIDER", "CONFIRMED_RIDER"}:
            colour = (255, 170, 0)

        else:
            colour = (40, 190, 40)

        cv2.rectangle(
            image,
            (x1 + 8, top + 6),
            (x1 + 15, top + PANEL_ROW_HEIGHT - 6),
            colour,
            -1,
        )

        line_1 = (
            f"ID {person['track_id']} | "
            f"{vest_state.replace('_', ' ')} | "
            f"{geometry_state.replace('GEOMETRY_', '')}"
        )

        vehicle_context = (
            f"Rider V{person['rider']['associated_vehicle_id']}"
            if person["rider"]["associated_vehicle_id"] is not None
            else "Pedestrian"
        )

        line_2 = (
            f"{vehicle_context} | "
            f"Risk: {person['risk_state'].replace('_', ' ')}"
        )

        nearest_distance = person.get('nearest_vehicle_distance_m')

        if nearest_distance is not None:
            line_3 = (
                f'Vest evidence: '
                f'{person["vest_temporal"]["vest_evidence_ratio"]:.0%} | '
                f'Nearest V: {nearest_distance:.2f}m'
            )
        else:
            line_3 = (
                f'Vest evidence: '
                f'{person["vest_temporal"]["vest_evidence_ratio"]:.0%} | '
                'Nearest V: N/A'
            )

        cv2.putText(
            image,
            line_1,
            (x1 + 26, top + 23),
            FONT,
            0.47,
            colour,
            2,
            cv2.LINE_AA,
        )

        cv2.putText(
            image,
            line_2,
            (x1 + 26, top + 44),
            FONT,
            0.45,
            (255, 255, 255),
            1,
            cv2.LINE_AA,
        )

        cv2.putText(
            image,
            line_3,
            (x1 + 26, top + 62),
            FONT,
            0.40,
            (215, 215, 215),
            1,
            cv2.LINE_AA,
        )


# ── Preflight ─────────────────────────────────────────────────────────────────

model_path = Path(MODEL_PATH)
video_path = Path(VIDEO_PATH)
calibration_path = Path(CALIBRATION_LOOKUP_JSON_PATH)

assert model_path.exists(), f"Model not found:\n{model_path}"
assert video_path.exists(), f"Video not found:\n{video_path}"
assert calibration_path.exists(), (
    f"Calibration profile not found:\n{calibration_path}"
)

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

assert not OUTPUT_VIDEO_PATH.exists(), (
    f"Output video already exists:\n{OUTPUT_VIDEO_PATH}\n\n"
    "Change RUN_NAME to avoid overwriting a previous run."
)


# ── Load calibration profile ──────────────────────────────────────────────────

calibration = json.loads(calibration_path.read_text(encoding="utf-8"))

quadratic_model = calibration["source_quadratic_model"]

A = float(quadratic_model["coefficient_y_squared"])
B = float(quadratic_model["coefficient_y"])
C = float(quadratic_model["intercept"])

REFERENCE_PERSON_HEIGHT_CM = float(
    calibration["reference_person"]["assumed_height_cm"]
)

valid_range = calibration["valid_lookup_range"]

CALIBRATION_Y_MIN = float(valid_range["coordinate_y_px_min"])
CALIBRATION_Y_MAX = float(valid_range["coordinate_y_px_max"])


# ── Pathway segmentation (Path_Segmentation_Script.ipynb) ─────────────────────

def run_path_segmentation(
    image,
    ANNOTATION_PATH,
    OUTPUT_DIR,
    PATH_LABEL,
):
    # ── Load image and annotation ─────────────────────────────────────────

    if not ANNOTATION_PATH.exists():
        raise FileNotFoundError(f"Annotation not found: {ANNOTATION_PATH}")

    annotation = json.loads(
        ANNOTATION_PATH.read_text(encoding="utf-8")
    )

    image_height, image_width = image.shape[:2]

    annotation_width = int(annotation["imageWidth"])
    annotation_height = int(annotation["imageHeight"])

    if annotation_width <= 0 or annotation_height <= 0:
        raise ValueError("Invalid annotation dimensions.")

    # This first test deliberately requires the original image dimensions.
    if (image_width, image_height) != (
        annotation_width,
        annotation_height,
    ):
        raise ValueError(
            f"Image is {image_width} x {image_height}, but annotation is "
            f"{annotation_width} x {annotation_height}. "
            "Use the original annotated image for this first test."
        )


    # ── Read pathway polygons ─────────────────────────────────────────────

    shapes = [
        shape
        for shape in annotation.get("shapes", [])
        if shape.get("label") == PATH_LABEL
        and shape.get("shape_type") == "polygon"
    ]

    if not shapes:
        raise ValueError(f"No polygon labelled '{PATH_LABEL}' found.")

    polygons = []

    for shape in shapes:
        points = np.asarray(shape["points"], dtype=np.float32)

        if (
            points.ndim != 2
            or points.shape[1] != 2
            or len(points) < 3
            or not np.isfinite(points).all()
        ):
            raise ValueError("Invalid pathway polygon coordinates.")

        polygon = np.rint(points).astype(np.int32).reshape(-1, 1, 2)
        polygons.append(polygon)


    # ── Produce mask and isolated image ───────────────────────────────────

    path_mask = np.zeros(
        (image_height, image_width),
        dtype=np.uint8,
    )

    # Fill separately so multiple pathway polygons form a union.
    for polygon in polygons:
        cv2.fillPoly(path_mask, [polygon], 255)

    isolated_path = cv2.bitwise_and(
        image,
        image,
        mask=path_mask,
    )


    # ── Produce overlay ──────────────────────────────────────────────────

    overlay = image.copy()
    inside_path = path_mask > 0

    highlight_colour = np.array([0, 200, 0], dtype=np.float32)

    overlay[inside_path] = np.clip(
        0.65 * image[inside_path].astype(np.float32)
        + 0.35 * highlight_colour,
        0,
        255,
    ).astype(np.uint8)

    cv2.polylines(
        overlay,
        polygons,
        isClosed=True,
        color=(255, 255, 0),
        thickness=3,
        lineType=cv2.LINE_AA,
    )


    # ── Save full-resolution outputs ──────────────────────────────────────

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    outputs = {
        "path_mask.png": path_mask,
        "isolated_path.png": isolated_path,
        "path_overlay.png": overlay,
    }

    for filename, output_image in outputs.items():
        output_path = OUTPUT_DIR / filename

        if not cv2.imwrite(str(output_path), output_image):
            raise RuntimeError(f"Could not save: {output_path}")


    path_pixel_count = int(np.count_nonzero(path_mask))
    path_fraction = path_pixel_count / path_mask.size

    print(f"Image dimensions: {image_width} x {image_height}")
    print(f"Pathway polygons: {len(polygons)}")
    print(f"Pixels inside pathway: {path_pixel_count:,}")
    print(f"Image area covered: {path_fraction:.2%}")
    print(f"Saved outputs to: {OUTPUT_DIR}")

    return path_mask, polygons


PATH_MASK = None
PATH_POLYGONS = None
PATH_SEGMENTATION_OUTPUT_DIR = OUTPUT_DIR / "path_segmentation"

if args.pathway_annotation is not None:
    if args.pathway_image is not None:
        pathway_image_path = Path(args.pathway_image)
        pathway_image = cv2.imread(str(pathway_image_path))

    else:
        pathway_image_path = Path(VIDEO_PATH)
        first_frame_cap = cv2.VideoCapture(str(pathway_image_path))
        _, pathway_image = first_frame_cap.read()
        first_frame_cap.release()

    if pathway_image is None:
        raise FileNotFoundError(f"Could not read image: {pathway_image_path}")

    PATH_MASK, PATH_POLYGONS = run_path_segmentation(
        pathway_image,
        Path(args.pathway_annotation),
        PATH_SEGMENTATION_OUTPUT_DIR,
        args.pathway_label,
    )

elif args.draw_pathway:
    raise ValueError("--draw-pathway needs --pathway-annotation.")


# ── Load model and validate class map ─────────────────────────────────────────

model = YOLO(str(model_path))

print("Model classes:")
print(model.names)

def class_name(class_id):
    if isinstance(model.names, dict):
        return model.names.get(class_id)
    return model.names[class_id]

assert class_name(PERSON_CLASS_ID) == "Person", (
    "PERSON_CLASS_ID does not map to 'Person'. Update configuration."
)

assert class_name(VEST_CLASS_ID) == "Safety_Vest", (
    "VEST_CLASS_ID does not map to 'Safety_Vest'. Update configuration."
)

assert class_name(VEHICLE_CLASS_ID) == "Vehicle", (
    "VEHICLE_CLASS_ID does not map to 'Vehicle'. Update configuration."
)


# ── Open input/output video ───────────────────────────────────────────────────

cap = cv2.VideoCapture(str(video_path))
assert cap.isOpened(), f"Could not open video:\n{video_path}"

fps = float(cap.get(cv2.CAP_PROP_FPS))
frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

if not math.isfinite(fps) or fps <= 0:
    fps = 25.0

writer = cv2.VideoWriter(
    str(OUTPUT_VIDEO_PATH),
    cv2.VideoWriter_fourcc(*VIDEO_CODEC),
    fps,
    (frame_width, frame_height),
)

assert writer.isOpened(), (
    f"Could not create output video:\n{OUTPUT_VIDEO_PATH}\n"
    "Try VIDEO_CODEC = 'avc1' or 'XVID'."
)


if PATH_MASK is not None:
    assert PATH_MASK.shape[:2] == (frame_height, frame_width), (
        f"Pathway mask is {PATH_MASK.shape[1]} x {PATH_MASK.shape[0]}, "
        f"but the video is {frame_width} x {frame_height}."
    )


# ── Runtime state ─────────────────────────────────────────────────────────────

person_states = defaultdict(new_person_state)
vehicle_states = defaultdict(new_vehicle_state)
pair_states = defaultdict(new_pair_state)

last_track_seen = {}
active_events = {}
completed_events = []

summary_counts = Counter()

start_time = time.time()

frame_log_file = (
    open(FRAME_LOG_JSONL_PATH, "w", encoding="utf-8")
    if WRITE_FRAME_JSONL
    else None
)


# ── Main scenario-tracker loop ────────────────────────────────────────────────

try:
    for frame_index in tqdm(
        range(frame_count),
        desc="Integrated PPE / geometry / proximity scenario tracker",
    ):
        success, frame = cap.read()

        if not success:
            break

        timestamp_s = frame_index / fps

        # One tracker call per frame. All three classes must remain available
        # in Results for vest association and person/vehicle context.
        result = model.track(
            source=frame,
            persist=True,
            tracker=TRACKER_CONFIG,
            classes=[
                PERSON_CLASS_ID,
                VEST_CLASS_ID,
                VEHICLE_CLASS_ID,
            ],
            conf=CONFIDENCE_THRESHOLD,
            iou=NMS_IOU_THRESHOLD,
            imgsz=IMAGE_SIZE,
            device=DEVICE,
            verbose=False,
        )[0]

        annotated = (
            result.plot(conf=True, labels=True, boxes=True)
            if DRAW_RAW_TRACKER_BOXES
            else frame.copy()
        )

        if args.draw_pathway:
            inside_path = PATH_MASK > 0

            highlight_colour = np.array([0, 200, 0], dtype=np.float32)

            annotated[inside_path] = np.clip(
                0.65 * annotated[inside_path].astype(np.float32)
                + 0.35 * highlight_colour,
                0,
                255,
            ).astype(np.uint8)

            cv2.polylines(
                annotated,
                PATH_POLYGONS,
                isClosed=True,
                color=(255, 255, 0),
                thickness=3,
                lineType=cv2.LINE_AA,
            )

        persons = []
        vests = []
        vehicles = []

        if result.boxes is not None and len(result.boxes) > 0:
            boxes = result.boxes.xyxy.cpu().numpy()
            class_ids = result.boxes.cls.int().cpu().tolist()
            confidences = result.boxes.conf.cpu().tolist()

            track_ids = (
                result.boxes.id.int().cpu().tolist()
                if result.boxes.id is not None
                else [None] * len(boxes)
            )

            for box, class_id, confidence, track_id in zip(
                boxes,
                class_ids,
                confidences,
                track_ids,
            ):
                clipped_box = clip_box_xyxy(
                    box,
                    frame_width,
                    frame_height,
                )

                detection = {
                    "bbox": clipped_box,
                    "confidence": float(confidence),
                    "track_id": (
                        int(track_id)
                        if track_id is not None
                        else None
                    ),
                }

                if class_id == PERSON_CLASS_ID and track_id is not None:
                    persons.append(detection)

                elif (
                    class_id == VEST_CLASS_ID
                    and confidence >= VEST_CONFIDENCE_THRESHOLD
                ):
                    vests.append(detection)

                elif class_id == VEHICLE_CLASS_ID and track_id is not None:
                    vehicles.append(detection)

        # ── Update vehicles before person-vehicle logic ───────────────────────

        for vehicle in vehicles:
            vehicle_id = vehicle["track_id"]

            last_track_seen[("vehicle", vehicle_id)] = frame_index

            motion = update_vehicle_motion(
                vehicle_states[vehicle_id],
                vehicle,
                frame_index,
            )

            vehicle["motion"] = motion

        # ── Associate vests to people ─────────────────────────────────────────

        vest_assignments = assign_vests_to_people(
            persons,
            vests,
            MIN_VEST_ASSOCIATION_SCORE,
        )

        # ── Person state: geometry and vest evidence ──────────────────────────

        for person in persons:
            person_id = person["track_id"]
            last_track_seen[("person", person_id)] = frame_index

            person_state = person_states[person_id]
            person_state["last_seen_frame"] = frame_index

            geometry = evaluate_person_geometry(
                person,
                frame_width,
                frame_height,
                A,
                B,
                C,
                CALIBRATION_Y_MIN,
                CALIBRATION_Y_MAX,
            )

            geometry_status = update_geometry_state(
                person_state,
                geometry,
            )

            person["geometry"] = {
                **geometry,
                **geometry_status,
            }

            assignment = vest_assignments.get(person_id)

            if assignment is not None:
                vest = vests[assignment["vest_index"]]

                person["vest"] = {
                    "seen_this_frame": True,
                    "bbox": vest["bbox"],
                    "confidence": vest["confidence"],
                    "association_score": assignment["association_score"],
                }

            else:
                person["vest"] = {
                    "seen_this_frame": False,
                    "bbox": None,
                    "confidence": None,
                    "association_score": None,
                }

            person["vest_temporal"] = update_vest_state(
                person_state,
                person["vest"]["seen_this_frame"],
                person["geometry"]["state"],
            )

        # ── Evaluate person ↔ vehicle pair geometry / distance ────────────────

        vehicle_pair_candidates = defaultdict(list)
        pair_results = []

        for person, vehicle in product(persons, vehicles):
            person_id = person["track_id"]
            vehicle_id = vehicle["track_id"]

            pair_key = ("person_vehicle", person_id, vehicle_id)
            pair_state = pair_states[pair_key]
            pair_state["last_seen_frame"] = frame_index

            distance_m, distance_reason, foot_y_gap = approximate_distance_m(
                person,
                vehicle,
                person["geometry"],
            )

            motion_state = vehicle["motion"]["state"]

            rider = rider_evidence(
                person,
                vehicle,
                person["geometry"],
                distance_m,
            )

            if distance_m is not None:
                pair_state["distance_history_m"].append(distance_m)

                smoothed_distance_m = float(
                    np.median(pair_state["distance_history_m"])
                )

            else:
                smoothed_distance_m = None

            vehicle_pair_candidates[person_id].append(
                {
                    "vehicle": vehicle,
                    "distance_m": smoothed_distance_m,
                    "distance_reason": distance_reason,
                    "foot_y_gap_px": foot_y_gap,
                    "rider": rider,
                }
            )

            pair_results.append(
                {
                    "pair_key": pair_key,
                    "person_id": person_id,
                    "vehicle_id": vehicle_id,
                    "distance_m": smoothed_distance_m,
                    "distance_reason": distance_reason,
                    "foot_y_gap_px": foot_y_gap,
                    "motion_state": motion_state,
                    "rider": rider,
                }
            )

        # ── Resolve nearest vehicle and rider state per person ─────────────────

        vehicle_association_winners = {}

        for person in persons:
            person_id = person["track_id"]
            person_state = person_states[person_id]

            candidates = [
                item
                for item in vehicle_pair_candidates.get(person_id, [])
                if item["distance_m"] is not None
            ]

            candidates.sort(
                key=lambda item: (
                    item["distance_m"],
                    -item["rider"]["score"],
                )
            )

            nearest = candidates[0] if candidates else None

            candidate_vehicle_id = (
                nearest["vehicle"]["track_id"]
                if nearest is not None
                and nearest["rider"]["is_candidate"]
                else None
            )

            candidate_evidence = (
                nearest["rider"]
                if candidate_vehicle_id is not None
                else {
                    "is_candidate": False,
                    "score": 0.0,
                    "reasons": [],
                }
            )

            rider_status = update_rider_state(
                person_state,
                candidate_vehicle_id,
                candidate_evidence,
                frame_index,
            )

            person["rider"] = rider_status

            person["nearest_vehicle_distance_m"] = (
                nearest["distance_m"]
                if nearest is not None
                else None
            )

            person["nearest_vehicle_id"] = (
                nearest["vehicle"]["track_id"]
                if nearest is not None
                else None
            )

            if (
                rider_status["state"]
                in {"POSSIBLE_RIDER", "CONFIRMED_RIDER"}
                and rider_status["associated_vehicle_id"] is not None
            ):
                vehicle_association_winners[
                    rider_status["associated_vehicle_id"]
                ] = person_id

        # Enforce at most one associated rider per vehicle in this prototype.
        if ONE_ASSOCIATED_PERSON_PER_VEHICLE:
            for person in persons:
                rider_status = person["rider"]
                vehicle_id = rider_status["associated_vehicle_id"]

                if (
                    vehicle_id is not None
                    and vehicle_association_winners.get(vehicle_id)
                    != person["track_id"]
                ):
                    rider_status["state"] = "PEDESTRIAN"
                    rider_status["associated_vehicle_id"] = None

        # ── Final person ↔ vehicle proximity states ────────────────────────────

        person_risk_lookup = defaultdict(list)

        for pair in pair_results:
            person_id = pair["person_id"]
            vehicle_id = pair["vehicle_id"]
            pair_key = pair["pair_key"]
            pair_state = pair_states[pair_key]

            person = next(
                item for item in persons
                if item["track_id"] == person_id
            )

            vehicle = next(
                item for item in vehicles
                if item["track_id"] == vehicle_id
            )

            rider_state = person["rider"]["state"]
            associated_vehicle_id = person["rider"]["associated_vehicle_id"]

            is_own_rider_vehicle = (
                associated_vehicle_id == vehicle_id
                and rider_state in {
                    "POSSIBLE_RIDER",
                    "CONFIRMED_RIDER",
                    "RIDER_MEMORY",
                }
            )

            geometry_usable = (
                person["geometry"]["state"] == "GEOMETRY_USABLE"
            )

            moving_context = pair["motion_state"] in {
                "MOVING",
                "RECENTLY_MOVING",
            }

            distance_m = pair["distance_m"]

            if is_own_rider_vehicle:
                proximity_state = "SUPPRESSED_RIDER_ASSOCIATION"
                pair_state["under_threshold_history"].append(0)

            elif not geometry_usable:
                proximity_state = "DISTANCE_UNKNOWN_GEOMETRY"
                pair_state["under_threshold_history"].append(0)

            elif distance_m is None:
                proximity_state = "DISTANCE_UNKNOWN"
                pair_state["under_threshold_history"].append(0)

            elif not moving_context:
                proximity_state = "VEHICLE_STATIONARY_CONTEXT"
                pair_state["under_threshold_history"].append(0)

            else:
                under_threshold = (
                    distance_m < PERSON_VEHICLE_THRESHOLD_M
                )

                pair_state["under_threshold_history"].append(
                    1 if under_threshold else 0
                )

                persistence_count = sum(
                    pair_state["under_threshold_history"]
                )

                if (
                    under_threshold
                    and persistence_count
                    >= PROXIMITY_PERSISTENCE_FRAMES
                ):
                    proximity_state = "PROXIMITY_ALERT"

                elif under_threshold:
                    proximity_state = "PROXIMITY_CAUTION"

                else:
                    proximity_state = "PROXIMITY_SAFE"

            pair_state["proximity_state"] = proximity_state

            person_conf = clamp(person["confidence"])
            vehicle_conf = clamp(vehicle["confidence"])
            geom_conf = geometry_confidence(
                person,
                person["geometry"],
            )

            persistence_conf = clamp(
                sum(pair_state["under_threshold_history"])
                / PROXIMITY_PERSISTENCE_FRAMES
            )

            motion_conf = (
                1.0
                if pair["motion_state"] == "MOVING"
                else (
                    0.70
                    if pair["motion_state"] == "RECENTLY_MOVING"
                    else 0.0
                )
            )

            event_confidence = (
                0.25 * person_conf
                + 0.20 * vehicle_conf
                + 0.20 * geom_conf
                + 0.20 * persistence_conf
                + 0.15 * motion_conf
            )

            pair["proximity_state"] = proximity_state
            pair["event_confidence"] = float(event_confidence)
            pair["persistence_count"] = int(
                sum(pair_state["under_threshold_history"])
            )

            person_risk_lookup[person_id].append(pair)

            # Open/update/close only persistent alert events.
            event_key = (
                "person_vehicle_proximity",
                person_id,
                vehicle_id,
            )

            if proximity_state == "PROXIMITY_ALERT":
                if event_key not in active_events:
                    active_events[event_key] = create_event(
                        event_type="PERSON_VEHICLE_PROXIMITY",
                        frame_index=frame_index,
                        timestamp_s=timestamp_s,
                        person_id=person_id,
                        vehicle_id=vehicle_id,
                        metadata={
                            "threshold_m": PERSON_VEHICLE_THRESHOLD_M,
                            "calibration_type": "local_pixel_scale",
                        },
                    )

                update_event(
                    active_events[event_key],
                    timestamp_s,
                    event_confidence,
                    distance_m,
                    reasons=[
                        "valid_person_geometry",
                        "vehicle_moving_or_recently_moving",
                        "persistent_distance_below_threshold",
                    ],
                )

            elif event_key in active_events:
                event = active_events.pop(event_key)

                close_event(
                    event,
                    frame_index,
                    timestamp_s,
                    outcome="RESOLVED_OR_CONDITION_CHANGED",
                )

                completed_events.append(event)

        # ── Person ↔ person proximity ─────────────────────────────────────────

        for person_a, person_b in combinations(persons, 2):
            person_a_id = person_a["track_id"]
            person_b_id = person_b["track_id"]

            if (
                person_a["geometry"]["state"] != "GEOMETRY_USABLE"
                or person_b["geometry"]["state"] != "GEOMETRY_USABLE"
            ):
                continue

            # Use A's local scale only as an exploratory approximation.
            # A later homography-based version should replace this.
            distance_m, distance_reason, foot_y_gap = approximate_distance_m(
                person_a,
                person_b,
                person_a["geometry"],
            )

            pair_key = (
                "person_person",
                min(person_a_id, person_b_id),
                max(person_a_id, person_b_id),
            )

            pair_state = pair_states[pair_key]
            pair_state["last_seen_frame"] = frame_index

            if distance_m is not None:
                pair_state["distance_history_m"].append(distance_m)

                smoothed_distance_m = float(
                    np.median(pair_state["distance_history_m"])
                )

                under_threshold = (
                    smoothed_distance_m < PERSON_PERSON_THRESHOLD_M
                )

                pair_state["under_threshold_history"].append(
                    1 if under_threshold else 0
                )

                persistence_count = sum(
                    pair_state["under_threshold_history"]
                )

                if (
                    under_threshold
                    and persistence_count
                    >= PROXIMITY_PERSISTENCE_FRAMES
                ):
                    proximity_state = "PERSON_PERSON_ALERT"

                elif under_threshold:
                    proximity_state = "PERSON_PERSON_CAUTION"

                else:
                    proximity_state = "PERSON_PERSON_SAFE"

            else:
                smoothed_distance_m = None
                persistence_count = 0
                proximity_state = "PERSON_PERSON_UNKNOWN"

            pair_results.append(
                {
                    "pair_key": pair_key,
                    "person_id": person_a_id,
                    "second_person_id": person_b_id,
                    "distance_m": smoothed_distance_m,
                    "distance_reason": distance_reason,
                    "foot_y_gap_px": foot_y_gap,
                    "proximity_state": proximity_state,
                    "event_confidence": None,
                    "persistence_count": int(persistence_count),
                }
            )

        # ── Assign one highest-risk state to each person for display ──────────

        for person in persons:
            person_id = person["track_id"]
            risks = person_risk_lookup.get(person_id, [])

            risk_priority = {
                "PROXIMITY_ALERT": 4,
                "PROXIMITY_CAUTION": 3,
                "SUPPRESSED_RIDER_ASSOCIATION": 2,
                "VEHICLE_STATIONARY_CONTEXT": 1,
                "PROXIMITY_SAFE": 0,
                "DISTANCE_UNKNOWN": 0,
                "DISTANCE_UNKNOWN_GEOMETRY": 0,
            }

            if risks:
                highest = max(
                    risks,
                    key=lambda item: risk_priority.get(
                        item["proximity_state"],
                        0,
                    ),
                )

                person["risk_state"] = highest["proximity_state"]

            else:
                person["risk_state"] = "NO_VEHICLE_CONTEXT"

        # ── Draw custom person overlays ───────────────────────────────────────

        for person in persons:
            x1, y1, x2, y2 = map(int, person["bbox"])
            person_id = person["track_id"]

            geometry_state = person["geometry"]["state"]
            vest_state = person["vest_temporal"]["state"]
            rider_state = person["rider"]["state"]
            risk_state = person["risk_state"]

            if risk_state == "PROXIMITY_ALERT":
                colour = (0, 0, 255)

            elif risk_state == "PROXIMITY_CAUTION":
                colour = (0, 165, 255)

            elif rider_state == "CONFIRMED_RIDER":
                colour = (255, 170, 0)

            elif geometry_state == "GEOMETRY_UNSUITABLE":
                colour = (70, 70, 220)

            elif vest_state == "VEST_REVIEW":
                colour = (0, 165, 255)

            else:
                colour = (40, 190, 40)

            cv2.rectangle(
                annotated,
                (x1, y1),
                (x2, y2),
                colour,
                3,
            )

            label = (
                f"ID {person_id} | "
                f"{vest_state.replace('VEST_', '')} | "
                f"{rider_state.replace('_', ' ')}"
            )

            draw_label(
                annotated,
                label,
                (x1, max(26, y1 - 8)),
                colour,
                scale=0.46,
            )

            if person["vest"]["bbox"] is not None:
                vx1, vy1, vx2, vy2 = map(
                    int,
                    person["vest"]["bbox"],
                )

                cv2.rectangle(
                    annotated,
                    (vx1, vy1),
                    (vx2, vy2),
                    (40, 190, 40),
                    2,
                )

        # ── Draw vehicle motion overlays ──────────────────────────────────────

        for vehicle in vehicles:
            x1, y1, x2, y2 = map(int, vehicle["bbox"])
            vehicle_id = vehicle["track_id"]
            motion_state = vehicle["motion"]["state"]

            if motion_state == "MOVING":
                colour = (0, 0, 255)

            elif motion_state == "RECENTLY_MOVING":
                colour = (0, 165, 255)

            elif motion_state == "STATIONARY":
                colour = (180, 180, 180)

            else:
                colour = (130, 130, 130)

            cv2.rectangle(
                annotated,
                (x1, y1),
                (x2, y2),
                colour,
                3,
            )

            draw_label(
                annotated,
                f"V{vehicle_id} | {motion_state.replace('_', ' ')}",
                (x1, max(26, y1 - 8)),
                colour,
                scale=0.46,
            )

        # ── Draw active person-vehicle distance lines ─────────────────────────

        for pair in pair_results:
            if pair.get("vehicle_id") is None:
                continue

            if pair["distance_m"] is None:
                continue

            if pair["proximity_state"] not in {
                "PROXIMITY_ALERT",
                "PROXIMITY_CAUTION",
                "SUPPRESSED_RIDER_ASSOCIATION",
            }:
                continue

            person = next(
                item for item in persons
                if item["track_id"] == pair["person_id"]
            )

            vehicle = next(
                item for item in vehicles
                if item["track_id"] == pair["vehicle_id"]
            )

            p1 = tuple(map(int, person["geometry"]["foot_point_px"]))
            p2 = tuple(map(int, bottom_centre(vehicle["bbox"])))

            if pair["proximity_state"] == "PROXIMITY_ALERT":
                colour = (0, 0, 255)

            elif pair["proximity_state"] == "PROXIMITY_CAUTION":
                colour = (0, 165, 255)

            else:
                colour = (255, 170, 0)

            cv2.line(
                annotated,
                p1,
                p2,
                colour,
                3,
                cv2.LINE_AA,
            )

            midpoint = (
                int((p1[0] + p2[0]) / 2),
                int((p1[1] + p2[1]) / 2),
            )

            draw_label(
                annotated,
                f"{pair['distance_m']:.2f}m",
                midpoint,
                colour,
                scale=0.48,
            )

        draw_scene_panel(
            annotated,
            persons,
            vehicles,
            pair_results,
        )

        # ── Frame-level structured audit record ───────────────────────────────

        if frame_log_file is not None:
            record = {
                "frame_index": int(frame_index),
                "timestamp_s": rounded(timestamp_s),
                "persons": [],
                "vehicles": [],
                "pairs": [],
            }

            for person in persons:
                record["persons"].append(
                    {
                        "track_id": person["track_id"],
                        "bbox_xyxy_px": [
                            rounded(value)
                            for value in person["bbox"]
                        ],
                        "confidence": rounded(person["confidence"], 5),
                        "vest": {
                            "seen_this_frame": person["vest"][
                                "seen_this_frame"
                            ],
                            "state": person["vest_temporal"]["state"],
                            "evidence_ratio": rounded(
                                person["vest_temporal"][
                                    "vest_evidence_ratio"
                                ],
                                5,
                            ),
                            "valid_observations": person[
                                "vest_temporal"
                            ]["valid_observations"],
                            "association_score": (
                                rounded(
                                    person["vest"][
                                        "association_score"
                                    ],
                                    5,
                                )
                                if person["vest"][
                                    "association_score"
                                ] is not None
                                else None
                            ),
                        },
                        "geometry": {
                            "state": person["geometry"]["state"],
                            "issues": person["geometry"]["issues"],
                            "ratio_smoothed": rounded(
                                person["geometry"]["ratio_smoothed"],
                                5,
                            ),
                            "height_ratio": (
                                rounded(
                                    person["geometry"]["height_ratio"],
                                    5,
                                )
                                if person["geometry"]["height_ratio"]
                                is not None
                                else None
                            ),
                            "estimated_height_cm": (
                                rounded(
                                    person["geometry"][
                                        "estimated_height_cm"
                                    ],
                                    3,
                                )
                                if person["geometry"][
                                    "estimated_height_cm"
                                ] is not None
                                else None
                            ),
                        },
                        "rider": person["rider"],
                        "risk_state": person["risk_state"],
                        "nearest_vehicle_id": person[
                            "nearest_vehicle_id"
                        ],
                        "nearest_vehicle_distance_m": (
                            rounded(
                                person["nearest_vehicle_distance_m"],
                                4,
                            )
                            if person[
                                "nearest_vehicle_distance_m"
                            ] is not None
                            else None
                        ),
                    }
                )

            for vehicle in vehicles:
                record["vehicles"].append(
                    {
                        "track_id": vehicle["track_id"],
                        "bbox_xyxy_px": [
                            rounded(value)
                            for value in vehicle["bbox"]
                        ],
                        "confidence": rounded(vehicle["confidence"], 5),
                        "motion": {
                            "state": vehicle["motion"]["state"],
                            "motion_score": rounded(
                                vehicle["motion"]["motion_score"],
                                5,
                            ),
                            "recent_displacement_px": rounded(
                                vehicle["motion"][
                                    "recent_displacement_px"
                                ],
                                3,
                            ),
                        },
                    }
                )

            for pair in pair_results:
                pair_copy = {
                    key: value
                    for key, value in pair.items()
                    if key not in {"pair_key", "rider"}
                }

                if "rider" in pair:
                    pair_copy["rider"] = pair["rider"]

                record["pairs"].append(pair_copy)

            frame_log_file.write(json.dumps(record) + "\n")

        writer.write(annotated)

        # ── Remove stale transient state ──────────────────────────────────────

        stale_track_keys = [
            key
            for key, last_seen in last_track_seen.items()
            if frame_index - last_seen > STALE_TRACK_FRAMES
        ]

        for kind, track_id in stale_track_keys:
            last_track_seen.pop((kind, track_id), None)

            if kind == "person":
                person_states.pop(track_id, None)

            elif kind == "vehicle":
                vehicle_states.pop(track_id, None)

        stale_pair_keys = [
            key
            for key, state in pair_states.items()
            if frame_index - state["last_seen_frame"] > STALE_PAIR_FRAMES
        ]

        for pair_key in stale_pair_keys:
            pair_states.pop(pair_key, None)

finally:
    cap.release()
    writer.release()

    if frame_log_file is not None:
        frame_log_file.close()


# ── Close any events that were active at end of video ─────────────────────────

final_timestamp_s = frame_count / fps

for event in active_events.values():
    close_event(
        event,
        frame_count - 1,
        final_timestamp_s,
        outcome="VIDEO_ENDED",
    )
    completed_events.append(event)


# ── Save event and summary outputs ────────────────────────────────────────────

elapsed_s = time.time() - start_time

EVENTS_JSON_PATH.write_text(
    json.dumps(
        {
            "schema_version": "1.0",
            "run_name": RUN_NAME,
            "event_count": len(completed_events),
            "events": completed_events,
        },
        indent=2,
    ),
    encoding="utf-8",
)

event_type_counts = Counter(
    event["event_type"]
    for event in completed_events
)

summary = {
    "schema_version": "1.0",
    "run_name": RUN_NAME,
    "purpose": (
        "Initial integrated scenario tracker combining PPE evidence, "
        "person/vehicle tracking, geometry quality, rider association, "
        "local-scale proximity, temporal persistence, and explainable events."
    ),
    "inputs": {
        "model_path": str(model_path),
        "video_path": str(video_path),
        "calibration_profile": str(calibration_path),
        "pathway_annotation": args.pathway_annotation,
    },
    "configuration": {
        "imgsz": IMAGE_SIZE,
        "device": str(DEVICE),
        "tracker": TRACKER_CONFIG,
        "person_vehicle_threshold_m": PERSON_VEHICLE_THRESHOLD_M,
        "person_person_threshold_m": PERSON_PERSON_THRESHOLD_M,
        "proximity_persistence_frames": PROXIMITY_PERSISTENCE_FRAMES,
        "rider_confirm_persistence_frames": RIDER_CONFIRM_PERSISTENCE_FRAMES,
        "reference_person_height_cm": REFERENCE_PERSON_HEIGHT_CM,
        "calibration_y_range": [
            CALIBRATION_Y_MIN,
            CALIBRATION_Y_MAX,
        ],
    },
    "video": {
        "fps": rounded(fps, 5),
        "source_frame_count": frame_count,
        "frame_width_px": frame_width,
        "frame_height_px": frame_height,
        "duration_s": rounded(final_timestamp_s),
    },
    "processing": {
        "elapsed_s": rounded(elapsed_s),
        "processed_fps": rounded(
            frame_count / elapsed_s
            if elapsed_s > 0
            else 0.0
        ),
    },
    "event_summary": {
        "total_events": len(completed_events),
        "event_type_counts": dict(event_type_counts),
    },
    "outputs": {
        "annotated_video": str(OUTPUT_VIDEO_PATH),
        "frame_state_jsonl": (
            str(FRAME_LOG_JSONL_PATH)
            if WRITE_FRAME_JSONL
            else None
        ),
        "events_json": str(EVENTS_JSON_PATH),
        "path_segmentation_dir": (
            str(PATH_SEGMENTATION_OUTPUT_DIR)
            if PATH_MASK is not None
            else None
        ),
    },
    "limitations": [
        (
            "Distance estimates use camera-specific local pixel scale and "
            "are not ground-plane homography measurements."
        ),
        (
            "Rider state is heuristic and should be interpreted as "
            "possible/confirmed association evidence, not ground truth."
        ),
        (
            "VEST_REVIEW means persistent missing vest evidence under "
            "usable geometry, not a definitive safety violation."
        ),
        (
            "Tracker IDs may switch after long occlusion or re-entry."
        ),
    ],
}

SUMMARY_JSON_PATH.write_text(
    json.dumps(summary, indent=2),
    encoding="utf-8",
)


# ── Console report ────────────────────────────────────────────────────────────

print("\n" + "=" * 84)
print("INTEGRATED SCENARIO TRACKER COMPLETE")
print("=" * 84)

print(f"Annotated video:\n{OUTPUT_VIDEO_PATH}")

if WRITE_FRAME_JSONL:
    print(f"\nFrame-level scenario log:\n{FRAME_LOG_JSONL_PATH}")

print(f"\nEvent episodes:\n{EVENTS_JSON_PATH}")
print(f"\nRun summary:\n{SUMMARY_JSON_PATH}")

print(f"\nProcessed duration: {final_timestamp_s:.2f} seconds")
print(f"Wall-clock processing: {elapsed_s:.2f} seconds")
print(
    f"Processing speed: "
    f"{frame_count / elapsed_s if elapsed_s > 0 else 0.0:.2f} FPS"
)
print(f"Completed persistent events: {len(completed_events)}")

for event_type, count in event_type_counts.items():
    print(f"  {event_type}: {count}")
