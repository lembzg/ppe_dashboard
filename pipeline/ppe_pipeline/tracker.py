"""
Scenario tracker: the per-frame logic from the Colab notebook, wrapped so it can
run on a recorded file or a live camera feed.

Feed it one tracker result per frame with update(); call finish() at the end.
It produces explainable event episodes:

  PERSON_VEHICLE_PROXIMITY  a pedestrian persistently within the threshold
                            distance of a moving vehicle
  VEST_MISSING              persistent missing vest evidence under usable geometry
"""
import json
import uuid
from collections import defaultdict, deque
from itertools import product
from pathlib import Path

import numpy as np

from . import config as c
from .geometry import (
    bottom_centre, box_area, box_touches_edge, centroid, clamp, clip_box_xyxy, contains_point,
    euclidean_distance, expand_box, intersection_area, iou, person_containment_in_vehicle, torso_box,
)


def rounded(value, decimals=3):
    return round(float(value), decimals)


# ── Calibration ───────────────────────────────────────────────────────────────

class Calibration:
    """Quadratic expected person height in pixels from centroid y, as produced by
    the height calibration stage."""

    def __init__(self, a, b, c_, reference_height_cm, y_min, y_max):
        self.a, self.b, self.c = a, b, c_
        self.reference_height_cm = reference_height_cm
        self.y_min, self.y_max = y_min, y_max

    @classmethod
    def load(cls, path):
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        model = data["source_quadratic_model"]
        valid = data["valid_lookup_range"]
        return cls(
            float(model["coefficient_y_squared"]),
            float(model["coefficient_y"]),
            float(model["intercept"]),
            float(data["reference_person"]["assumed_height_cm"]),
            float(valid["coordinate_y_px_min"]),
            float(valid["coordinate_y_px_max"]),
        )

    def expected_height_px(self, centre_y):
        return self.a * centre_y**2 + self.b * centre_y + self.c


# ── Vest association ──────────────────────────────────────────────────────────

def vest_association_score(person_box, vest_box):
    vest_area = box_area(vest_box)
    person_area = box_area(person_box)
    if vest_area <= 0 or person_area <= 0:
        return 0.0

    torso = torso_box(person_box)
    contained_in_person = intersection_area(person_box, vest_box) / vest_area
    torso_overlap = iou(torso, vest_box)
    centre_in_torso = float(contains_point(torso, centroid(vest_box)))
    size_plausible = float(0.01 <= vest_area / person_area <= 0.65)

    return 0.45 * contained_in_person + 0.30 * torso_overlap + 0.20 * centre_in_torso + 0.05 * size_plausible


def assign_vests_to_people(persons, vests, min_score):
    candidates = []
    for vest_index, vest in enumerate(vests):
        for person in persons:
            score = vest_association_score(person["bbox"], vest["bbox"])
            if score >= min_score:
                candidates.append((float(score), person["track_id"], vest_index))
    candidates.sort(reverse=True, key=lambda item: item[0])

    assigned_people = set()
    assigned_vests = set()
    assignments = {}
    for score, person_id, vest_index in candidates:
        if person_id in assigned_people or vest_index in assigned_vests:
            continue
        assignments[person_id] = {"vest_index": int(vest_index), "association_score": float(score)}
        assigned_people.add(person_id)
        assigned_vests.add(vest_index)
    return assignments


# ── State factories ───────────────────────────────────────────────────────────

def new_person_state():
    return {
        "vest_history": deque(maxlen=c.VEST_HISTORY_FRAMES),
        "ratio_history": deque(maxlen=c.RATIO_SMOOTHING_WINDOW),
        "rider_history": deque(maxlen=c.RIDER_CONFIRM_PERSISTENCE_FRAMES),
        "last_seen_frame": -1,
        "vest_state": "VEST_UNKNOWN",
        "rider_state": "PEDESTRIAN",
        "associated_vehicle_id": None,
        "rider_memory_until": -1,
        "strong_ratio_count": 0,
        "caution_ratio_count": 0,
    }


def new_vehicle_state():
    return {"position_history": deque(maxlen=c.VEHICLE_MOTION_HISTORY_FRAMES)}


def new_pair_state():
    return {
        "distance_history_m": deque(maxlen=c.PROXIMITY_HISTORY_FRAMES),
        "under_threshold_history": deque(maxlen=c.PROXIMITY_PERSISTENCE_FRAMES),
        "last_seen_frame": -1,
    }


# ── Geometry / calibration ────────────────────────────────────────────────────

def evaluate_person_geometry(person, frame_width, frame_height, calibration):
    box = person["bbox"]
    x1, y1, x2, y2 = box
    box_width = x2 - x1
    box_height = y2 - y1
    centre_x, centre_y = centroid(box)
    foot_point = bottom_centre(box)
    ratio = box_width / box_height if box_height > 0 else float("nan")

    issues = []
    if box_width < c.MIN_PERSON_BOX_WIDTH_PX:
        issues.append("box_too_narrow")
    if box_height < c.MIN_PERSON_BOX_HEIGHT_PX:
        issues.append("box_too_short")
    if box_touches_edge(box, frame_width, frame_height, c.EDGE_MARGIN_PX):
        issues.append("box_touches_edge")
    # The calibration profile was fitted using centroid y.
    if calibration is not None and not (calibration.y_min <= centre_y <= calibration.y_max):
        issues.append("centroid_y_outside_calibration")

    height_ratio = None
    cm_per_pixel = None
    if calibration is not None and not issues:
        expected_height_px = calibration.expected_height_px(centre_y)
        if expected_height_px <= 0:
            issues.append("invalid_expected_height")
        else:
            height_ratio = box_height / expected_height_px
            if not (c.MIN_EXPECTED_HEIGHT_RATIO <= height_ratio <= c.MAX_EXPECTED_HEIGHT_RATIO):
                issues.append("height_inconsistent_with_calibration")
            cm_per_pixel = calibration.reference_height_cm / expected_height_px
    elif calibration is None and not issues:
        cm_per_pixel = c.ASSUMED_PERSON_HEIGHT_CM / box_height

    return {
        "centroid_px": (float(centre_x), float(centre_y)),
        "foot_point_px": (float(foot_point[0]), float(foot_point[1])),
        "width_to_height_ratio": float(ratio),
        "height_ratio": float(height_ratio) if height_ratio is not None else None,
        "cm_per_pixel": float(cm_per_pixel) if cm_per_pixel is not None else None,
        "issues": issues,
    }


def update_geometry_state(person_state, geometry):
    person_state["ratio_history"].append(float(geometry["width_to_height_ratio"]))
    ratio_smoothed = float(np.median(person_state["ratio_history"]))

    person_state["strong_ratio_count"] = person_state["strong_ratio_count"] + 1 if ratio_smoothed >= c.RATIO_STRONG_THRESHOLD else 0
    person_state["caution_ratio_count"] = person_state["caution_ratio_count"] + 1 if ratio_smoothed >= c.RATIO_CAUTION_THRESHOLD else 0

    if geometry["issues"]:
        state = "GEOMETRY_UNSUITABLE"
    elif person_state["strong_ratio_count"] >= c.STRONG_PERSISTENCE_FRAMES:
        state = "GEOMETRY_STRONG_ANOMALY"
    elif person_state["caution_ratio_count"] >= c.CAUTION_PERSISTENCE_FRAMES:
        state = "GEOMETRY_CAUTION"
    else:
        state = "GEOMETRY_USABLE"
    return {"state": state, "ratio_smoothed": ratio_smoothed}


def geometry_confidence(person, geometry_status):
    confidence = clamp(person["confidence"])
    factor = {"GEOMETRY_USABLE": 1.0, "GEOMETRY_CAUTION": 0.50, "GEOMETRY_STRONG_ANOMALY": 0.30}
    return factor.get(geometry_status["state"], 0.0) * confidence


# ── Temporal PPE state ────────────────────────────────────────────────────────

def update_vest_state(person_state, vest_seen_this_frame, geometry_state):
    # Only geometry-usable frames count as evidence for an absent/present vest.
    if geometry_state == "GEOMETRY_USABLE":
        person_state["vest_history"].append(1 if vest_seen_this_frame else 0)

    history = person_state["vest_history"]
    ratio = sum(history) / len(history) if history else 0.0
    if len(history) < c.MIN_VEST_VALID_OBSERVATIONS:
        state = "VEST_UNKNOWN"
    elif ratio >= c.VEST_PRESENT_RATIO_THRESHOLD:
        state = "VEST_PRESENT"
    elif ratio <= c.VEST_REVIEW_RATIO_THRESHOLD:
        state = "VEST_REVIEW"
    else:
        state = "VEST_UNKNOWN"

    person_state["vest_state"] = state
    return {"state": state, "valid_observations": len(history), "vest_evidence_ratio": float(ratio)}


# ── Vehicle motion ────────────────────────────────────────────────────────────

def update_vehicle_motion(vehicle_state, vehicle):
    point = bottom_centre(vehicle["bbox"])
    history = vehicle_state["position_history"]
    history.append(point)

    if len(history) <= c.VEHICLE_MOTION_LOOKBACK_FRAMES:
        return {"state": "UNKNOWN", "motion_score": 0.0}

    displacements = [
        euclidean_distance(history[index], history[index - c.VEHICLE_MOTION_LOOKBACK_FRAMES])
        for index in range(c.VEHICLE_MOTION_LOOKBACK_FRAMES, len(history))
    ]
    motion_score = sum(d >= c.VEHICLE_MOVING_DISPLACEMENT_PX for d in displacements) / len(displacements)

    if displacements[-1] >= c.VEHICLE_MOVING_DISPLACEMENT_PX:
        state = "MOVING"
    elif motion_score >= c.VEHICLE_MOVING_RECENT_RATIO_THRESHOLD:
        state = "RECENTLY_MOVING"
    else:
        state = "STATIONARY"
    return {"state": state, "motion_score": float(motion_score)}


# ── Approximate calibrated distance ───────────────────────────────────────────

def approximate_distance_m(person, other, geometry):
    """Local image-plane distance using the person's calibration scale. Rejects
    pairs whose image-depth proxy differs too much; not a ground-plane measure."""
    cm_per_pixel = geometry.get("cm_per_pixel")
    if cm_per_pixel is None:
        return None
    person_foot = geometry["foot_point_px"]
    other_foot = bottom_centre(other["bbox"])
    if abs(person_foot[1] - other_foot[1]) > c.MAX_PAIR_FOOT_Y_DIFFERENCE_PX:
        return None
    return float(euclidean_distance(person_foot, other_foot) * cm_per_pixel / 100.0)


# ── Rider association ─────────────────────────────────────────────────────────

def rider_evidence(person, vehicle, geometry, distance_m):
    if distance_m is None:
        return {"is_candidate": False, "score": 0.0}

    containment = person_containment_in_vehicle(person["bbox"], vehicle["bbox"])
    overlap_iou = iou(person["bbox"], vehicle["bbox"])
    vehicle_zone = expand_box(vehicle["bbox"], c.VEHICLE_ZONE_HORIZONTAL_EXPANSION, c.VEHICLE_ZONE_VERTICAL_EXPANSION)
    foot_inside_vehicle_zone = contains_point(vehicle_zone, geometry["foot_point_px"])
    close = distance_m < c.RIDER_DISTANCE_THRESHOLD_M
    abnormal_geometry = (
        geometry["width_to_height_ratio"] >= c.RATIO_CAUTION_THRESHOLD
        or (geometry["height_ratio"] is not None and geometry["height_ratio"] < c.MIN_EXPECTED_HEIGHT_RATIO)
    )
    spatial_compatible = (
        containment >= c.MIN_PERSON_IN_VEHICLE_CONTAINMENT
        or overlap_iou >= c.MIN_PERSON_VEHICLE_IOU
        or foot_inside_vehicle_zone
    )
    score = (
        0.35 * clamp(1.0 - distance_m / c.RIDER_DISTANCE_THRESHOLD_M)
        + 0.30 * clamp(containment / 0.50)
        + 0.15 * clamp(overlap_iou / 0.20)
        + 0.10 * float(foot_inside_vehicle_zone)
        + 0.10 * float(abnormal_geometry)
    )
    return {"is_candidate": close and spatial_compatible, "score": float(score)}


def update_rider_state(person_state, candidate_vehicle_id, candidate_evidence, frame_index):
    if candidate_vehicle_id is None:
        if frame_index <= person_state["rider_memory_until"]:
            person_state["rider_state"] = "RIDER_MEMORY"
        else:
            person_state["rider_state"] = "PEDESTRIAN"
            person_state["associated_vehicle_id"] = None
        return {"state": person_state["rider_state"], "associated_vehicle_id": person_state["associated_vehicle_id"]}

    person_state["rider_history"].append({
        "vehicle_id": int(candidate_vehicle_id),
        "is_candidate": bool(candidate_evidence["is_candidate"]),
    })
    persistence = sum(
        1 for item in person_state["rider_history"]
        if item["vehicle_id"] == candidate_vehicle_id and item["is_candidate"]
    )

    if persistence >= c.RIDER_CONFIRM_PERSISTENCE_FRAMES:
        person_state["rider_state"] = "CONFIRMED_RIDER"
        person_state["associated_vehicle_id"] = int(candidate_vehicle_id)
        person_state["rider_memory_until"] = frame_index + c.RIDER_MEMORY_FRAMES
    elif persistence >= c.RIDER_CANDIDATE_PERSISTENCE_FRAMES:
        person_state["rider_state"] = "POSSIBLE_RIDER"
        person_state["associated_vehicle_id"] = int(candidate_vehicle_id)
    elif frame_index <= person_state["rider_memory_until"]:
        person_state["rider_state"] = "RIDER_MEMORY"
    else:
        person_state["rider_state"] = "PEDESTRIAN"
        person_state["associated_vehicle_id"] = None
    return {"state": person_state["rider_state"], "associated_vehicle_id": person_state["associated_vehicle_id"]}


# ── Event episodes ────────────────────────────────────────────────────────────

def create_event(event_type, frame_index, timestamp_s, person_id, vehicle_id=None):
    return {
        "event_id": str(uuid.uuid4()),
        "event_type": event_type,
        "person_track_id": person_id,
        "vehicle_track_id": vehicle_id,
        "start_frame_index": int(frame_index),
        "end_frame_index": None,
        "start_timestamp_s": rounded(timestamp_s),
        "end_timestamp_s": rounded(timestamp_s),
        "duration_s": None,
        "minimum_distance_m": None,
        "maximum_confidence": 0.0,
        "confidence_values": [],
        "vote_ratio_values": [],
        "outcome": "ACTIVE",
    }


def update_event(event, timestamp_s, confidence, distance_m=None, vote_ratio=None):
    event["end_timestamp_s"] = rounded(timestamp_s)
    event["maximum_confidence"] = max(event["maximum_confidence"], float(confidence))
    event["confidence_values"].append(float(confidence))
    if vote_ratio is not None:
        event["vote_ratio_values"].append(float(vote_ratio))
    if distance_m is not None:
        current = event["minimum_distance_m"]
        event["minimum_distance_m"] = float(distance_m) if current is None else min(current, float(distance_m))


def close_event(event, frame_index, timestamp_s, outcome):
    event["end_frame_index"] = int(frame_index)
    event["end_timestamp_s"] = rounded(timestamp_s)
    event["duration_s"] = rounded(timestamp_s - event["start_timestamp_s"])
    confidences = event.pop("confidence_values")
    votes = event.pop("vote_ratio_values")
    event["mean_confidence"] = rounded(np.mean(confidences)) if confidences else 0.0
    event["vote_ratio"] = rounded(np.mean(votes)) if votes else None
    event["outcome"] = outcome


# ── Tracker ───────────────────────────────────────────────────────────────────

class ScenarioTracker:
    def __init__(self, frame_width, frame_height, fps, calibration=None):
        self.frame_width = frame_width
        self.frame_height = frame_height
        self.fps = fps
        self.calibration = calibration

        self.person_states = defaultdict(new_person_state)
        self.vehicle_states = defaultdict(new_vehicle_state)
        self.pair_states = defaultdict(new_pair_state)
        self.last_track_seen = {}
        self.person_frame_counts = defaultdict(int)
        self.active_events = {}
        self.completed_events = []
        self.last_frame_index = -1

    # Detections ----------------------------------------------------------------

    def _detections(self, result):
        persons, vests, vehicles = [], [], []
        if result.boxes is None or len(result.boxes) == 0:
            return persons, vests, vehicles

        boxes = result.boxes.xyxy.cpu().numpy()
        class_ids = result.boxes.cls.int().cpu().tolist()
        confidences = result.boxes.conf.cpu().tolist()
        track_ids = result.boxes.id.int().cpu().tolist() if result.boxes.id is not None else [None] * len(boxes)

        for box, class_id, confidence, track_id in zip(boxes, class_ids, confidences, track_ids):
            detection = {
                "bbox": clip_box_xyxy(box, self.frame_width, self.frame_height),
                "confidence": float(confidence),
                "track_id": int(track_id) if track_id is not None else None,
            }
            if class_id == c.PERSON_CLASS_ID and track_id is not None:
                persons.append(detection)
            elif class_id == c.VEST_CLASS_ID and confidence >= c.VEST_CONFIDENCE_THRESHOLD:
                vests.append(detection)
            elif class_id == c.VEHICLE_CLASS_ID and track_id is not None:
                vehicles.append(detection)
        return persons, vests, vehicles

    # Per frame -----------------------------------------------------------------

    def update(self, frame_index, result):
        """Process one frame's tracker result. Returns the people and vehicles with
        their derived states, for drawing overlays."""
        timestamp_s = frame_index / self.fps
        self.last_frame_index = frame_index
        persons, vests, vehicles = self._detections(result)

        for vehicle in vehicles:
            self.last_track_seen[("vehicle", vehicle["track_id"])] = frame_index
            vehicle["motion"] = update_vehicle_motion(self.vehicle_states[vehicle["track_id"]], vehicle)

        self._update_people(frame_index, persons, vests)
        self._update_vest_events(frame_index, timestamp_s, persons)
        pair_results = self._evaluate_pairs(frame_index, persons, vehicles)
        self._resolve_riders(frame_index, persons, pair_results)
        self._update_proximity_events(frame_index, timestamp_s, persons, vehicles, pair_results)
        self._remove_stale_state(frame_index, timestamp_s)
        return persons, vehicles

    def _update_people(self, frame_index, persons, vests):
        vest_assignments = assign_vests_to_people(persons, vests, c.MIN_VEST_ASSOCIATION_SCORE)
        for person in persons:
            person_id = person["track_id"]
            self.last_track_seen[("person", person_id)] = frame_index
            self.person_frame_counts[person_id] += 1
            person_state = self.person_states[person_id]
            person_state["last_seen_frame"] = frame_index

            geometry = evaluate_person_geometry(person, self.frame_width, self.frame_height, self.calibration)
            person["geometry"] = {**geometry, **update_geometry_state(person_state, geometry)}

            assignment = vest_assignments.get(person_id)
            person["vest_bbox"] = vests[assignment["vest_index"]]["bbox"] if assignment else None
            person["vest_temporal"] = update_vest_state(person_state, assignment is not None, person["geometry"]["state"])

    def _update_vest_events(self, frame_index, timestamp_s, persons):
        for person in persons:
            person_id = person["track_id"]
            event_key = ("vest_missing", person_id)
            vest = person["vest_temporal"]
            if vest["state"] == "VEST_REVIEW":
                if event_key not in self.active_events:
                    self.active_events[event_key] = create_event("VEST_MISSING", frame_index, timestamp_s, person_id)
                update_event(
                    self.active_events[event_key],
                    timestamp_s,
                    geometry_confidence(person, person["geometry"]),
                    vote_ratio=1.0 - vest["vest_evidence_ratio"],
                )
            elif event_key in self.active_events:
                self._close(event_key, frame_index, timestamp_s, "RESOLVED_OR_CONDITION_CHANGED")

    def _evaluate_pairs(self, frame_index, persons, vehicles):
        pair_results = []
        for person, vehicle in product(persons, vehicles):
            pair_key = ("person_vehicle", person["track_id"], vehicle["track_id"])
            pair_state = self.pair_states[pair_key]
            pair_state["last_seen_frame"] = frame_index

            distance_m = approximate_distance_m(person, vehicle, person["geometry"])
            if distance_m is not None:
                pair_state["distance_history_m"].append(distance_m)
                smoothed_distance_m = float(np.median(pair_state["distance_history_m"]))
            else:
                smoothed_distance_m = None

            pair_results.append({
                "pair_key": pair_key,
                "person": person,
                "vehicle": vehicle,
                "distance_m": smoothed_distance_m,
                "rider": rider_evidence(person, vehicle, person["geometry"], distance_m),
            })
        return pair_results

    def _resolve_riders(self, frame_index, persons, pair_results):
        winners = {}
        for person in persons:
            person_id = person["track_id"]
            candidates = sorted(
                (pair for pair in pair_results if pair["person"] is person and pair["distance_m"] is not None),
                key=lambda pair: (pair["distance_m"], -pair["rider"]["score"]),
            )
            nearest = candidates[0] if candidates else None
            candidate_vehicle_id = (
                nearest["vehicle"]["track_id"] if nearest is not None and nearest["rider"]["is_candidate"] else None
            )
            evidence = nearest["rider"] if candidate_vehicle_id is not None else {"is_candidate": False, "score": 0.0}
            person["rider"] = update_rider_state(self.person_states[person_id], candidate_vehicle_id, evidence, frame_index)

            rider = person["rider"]
            if rider["state"] in {"POSSIBLE_RIDER", "CONFIRMED_RIDER"} and rider["associated_vehicle_id"] is not None:
                winners[rider["associated_vehicle_id"]] = person_id

        # Enforce at most one associated rider per vehicle.
        if c.ONE_ASSOCIATED_PERSON_PER_VEHICLE:
            for person in persons:
                vehicle_id = person["rider"]["associated_vehicle_id"]
                if vehicle_id is not None and winners.get(vehicle_id) != person["track_id"]:
                    person["rider"]["state"] = "PEDESTRIAN"
                    person["rider"]["associated_vehicle_id"] = None

    def _update_proximity_events(self, frame_index, timestamp_s, persons, vehicles, pair_results):
        for person in persons:
            person["risk_state"] = "NO_VEHICLE_CONTEXT"

        for pair in pair_results:
            person, vehicle = pair["person"], pair["vehicle"]
            pair_state = self.pair_states[pair["pair_key"]]
            rider = person["rider"]
            motion_state = vehicle["motion"]["state"]
            distance_m = pair["distance_m"]

            is_own_rider_vehicle = (
                rider["associated_vehicle_id"] == vehicle["track_id"]
                and rider["state"] in {"POSSIBLE_RIDER", "CONFIRMED_RIDER", "RIDER_MEMORY"}
            )
            if is_own_rider_vehicle:
                proximity_state = "SUPPRESSED_RIDER_ASSOCIATION"
            elif person["geometry"]["state"] != "GEOMETRY_USABLE":
                proximity_state = "DISTANCE_UNKNOWN_GEOMETRY"
            elif distance_m is None:
                proximity_state = "DISTANCE_UNKNOWN"
            elif motion_state not in {"MOVING", "RECENTLY_MOVING"}:
                proximity_state = "VEHICLE_STATIONARY_CONTEXT"
            else:
                proximity_state = None

            if proximity_state is not None:
                pair_state["under_threshold_history"].append(0)
            else:
                under_threshold = distance_m < c.PERSON_VEHICLE_THRESHOLD_M
                pair_state["under_threshold_history"].append(1 if under_threshold else 0)
                persistence_count = sum(pair_state["under_threshold_history"])
                if under_threshold and persistence_count >= c.PROXIMITY_PERSISTENCE_FRAMES:
                    proximity_state = "PROXIMITY_ALERT"
                elif under_threshold:
                    proximity_state = "PROXIMITY_CAUTION"
                else:
                    proximity_state = "PROXIMITY_SAFE"

            if proximity_state in {"PROXIMITY_ALERT", "PROXIMITY_CAUTION"}:
                person["risk_state"] = proximity_state
            pair["proximity_state"] = proximity_state

            persistence_conf = clamp(sum(pair_state["under_threshold_history"]) / c.PROXIMITY_PERSISTENCE_FRAMES)
            motion_conf = 1.0 if motion_state == "MOVING" else 0.70 if motion_state == "RECENTLY_MOVING" else 0.0
            event_confidence = (
                0.25 * clamp(person["confidence"])
                + 0.20 * clamp(vehicle["confidence"])
                + 0.20 * geometry_confidence(person, person["geometry"])
                + 0.20 * persistence_conf
                + 0.15 * motion_conf
            )

            event_key = ("person_vehicle_proximity", person["track_id"], vehicle["track_id"])
            if proximity_state == "PROXIMITY_ALERT":
                if event_key not in self.active_events:
                    self.active_events[event_key] = create_event(
                        "PERSON_VEHICLE_PROXIMITY", frame_index, timestamp_s, person["track_id"], vehicle["track_id"])
                update_event(self.active_events[event_key], timestamp_s, event_confidence, distance_m,
                             vote_ratio=persistence_conf)
            elif event_key in self.active_events:
                self._close(event_key, frame_index, timestamp_s, "RESOLVED_OR_CONDITION_CHANGED")

    def _remove_stale_state(self, frame_index, timestamp_s):
        stale_tracks = [key for key, last_seen in self.last_track_seen.items() if frame_index - last_seen > c.STALE_TRACK_FRAMES]
        for kind, track_id in stale_tracks:
            self.last_track_seen.pop((kind, track_id), None)
            if kind == "person":
                self.person_states.pop(track_id, None)
                if ("vest_missing", track_id) in self.active_events:
                    self._close(("vest_missing", track_id), frame_index, timestamp_s, "TRACK_LOST")
            else:
                self.vehicle_states.pop(track_id, None)

        stale_pairs = [key for key, state in self.pair_states.items() if frame_index - state["last_seen_frame"] > c.STALE_PAIR_FRAMES]
        for pair_key in stale_pairs:
            self.pair_states.pop(pair_key, None)
            event_key = ("person_vehicle_proximity", pair_key[1], pair_key[2])
            if event_key in self.active_events:
                self._close(event_key, frame_index, timestamp_s, "TRACK_LOST")

    def _close(self, event_key, frame_index, timestamp_s, outcome):
        event = self.active_events.pop(event_key)
        close_event(event, frame_index, timestamp_s, outcome)
        self.completed_events.append(event)

    # End of input ----------------------------------------------------------------

    def finish(self):
        """Close events still active at the end of the input and return all events."""
        final_timestamp_s = (self.last_frame_index + 1) / self.fps
        for event_key in list(self.active_events):
            self._close(event_key, self.last_frame_index, final_timestamp_s, "VIDEO_ENDED")
        return sorted(self.completed_events, key=lambda event: event["start_timestamp_s"])

    def people_observed(self):
        """Person tracks that lasted long enough to count as a person seen."""
        min_frames = max(1, round(c.MIN_OBSERVED_PERSON_SECONDS * self.fps))
        return sum(1 for count in self.person_frame_counts.values() if count >= min_frames)
