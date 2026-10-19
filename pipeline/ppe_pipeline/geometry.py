"""Bounding box helpers. Boxes are (x1, y1, x2, y2) in pixels."""
import math


def clamp(value, minimum=0.0, maximum=1.0):
    return max(minimum, min(maximum, float(value)))


def box_area(box):
    x1, y1, x2, y2 = map(float, box)
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def intersection_area(box_a, box_b):
    ax1, ay1, ax2, ay2 = map(float, box_a)
    bx1, by1, bx2, by2 = map(float, box_b)
    return box_area((max(ax1, bx1), max(ay1, by1), min(ax2, bx2), min(ay2, by2)))


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
    return intersection_area(person_box, vehicle_box) / person_area if person_area > 0 else 0.0


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
    return (x1 + 0.10 * width, y1 + 0.20 * height, x2 - 0.10 * width, y1 + 0.75 * height)
