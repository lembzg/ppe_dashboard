"""Detector, tracker and scenario settings, carried over from the Colab notebook."""

# ── Model classes ─────────────────────────────────────────────────────────────

PERSON_CLASS_ID = 0
VEST_CLASS_ID = 1
VEHICLE_CLASS_ID = 2
EXPECTED_CLASS_NAMES = {PERSON_CLASS_ID: "Person", VEST_CLASS_ID: "Safety_Vest", VEHICLE_CLASS_ID: "Vehicle"}

# ── Detector and tracker settings ─────────────────────────────────────────────

TRACKER_CONFIG = "botsort.yaml"

# Keep this consistent with the calibration profile.
IMAGE_SIZE = 960

CONFIDENCE_THRESHOLD = 0.40
NMS_IOU_THRESHOLD = 0.70

# Vest detections can be accepted at a lower threshold because their final use
# is gated by person-torso association and temporal evidence.
VEST_CONFIDENCE_THRESHOLD = 0.25

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

# Above this, geometry becomes a caution signal; this is not proof of occlusion.
RATIO_CAUTION_THRESHOLD = 0.75
RATIO_STRONG_THRESHOLD = 0.95

RATIO_SMOOTHING_WINDOW = 7
CAUTION_PERSISTENCE_FRAMES = 5
STRONG_PERSISTENCE_FRAMES = 8

MIN_EXPECTED_HEIGHT_RATIO = 0.70
MAX_EXPECTED_HEIGHT_RATIO = 1.30

# Without a calibration file, scale is estimated from each person's own box
# height, assuming this height. Rougher: a crouching or partly hidden person
# reads as further from vehicles than they are.
ASSUMED_PERSON_HEIGHT_CM = 170.0

# ── Approximate proximity settings ────────────────────────────────────────────

PERSON_VEHICLE_THRESHOLD_M = 2.0

# Local scale is most defensible when pair floor proxies are at broadly similar
# depths in the image.
MAX_PAIR_FOOT_Y_DIFFERENCE_PX = 250.0

PROXIMITY_HISTORY_FRAMES = 15
PROXIMITY_PERSISTENCE_FRAMES = 8

# Do not produce a vehicle-risk event unless vehicle motion is evident recently.
VEHICLE_MOTION_HISTORY_FRAMES = 100
VEHICLE_MOTION_LOOKBACK_FRAMES = 20
VEHICLE_MOVING_DISPLACEMENT_PX = 12.0
VEHICLE_MOVING_RECENT_RATIO_THRESHOLD = 0.15

# ── Rider association settings ────────────────────────────────────────────────

RIDER_DISTANCE_THRESHOLD_M = 1.0

MIN_PERSON_IN_VEHICLE_CONTAINMENT = 0.20
MIN_PERSON_VEHICLE_IOU = 0.05

VEHICLE_ZONE_HORIZONTAL_EXPANSION = 0.10
VEHICLE_ZONE_VERTICAL_EXPANSION = 0.10

RIDER_CANDIDATE_PERSISTENCE_FRAMES = 8
RIDER_CONFIRM_PERSISTENCE_FRAMES = 15
RIDER_MEMORY_FRAMES = 100

# An operator is usually best represented by one person per vehicle.
ONE_ASSOCIATED_PERSON_PER_VEHICLE = True

# ── State cleanup ─────────────────────────────────────────────────────────────

STALE_TRACK_FRAMES = 90
STALE_PAIR_FRAMES = 90

# A person track counts towards people observed once it has lasted this long.
MIN_OBSERVED_PERSON_SECONDS = 1.0
