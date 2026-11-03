"""
Reads and checks the device configuration (device.env, see device.env.example).

    config = load_config()          # device.env next to this file
    config.camera_source, config.device_key, ...

Every problem is collected and reported together, each with the line to fix,
so a bad config fails at startup rather than minutes later. Run this file to
check a config without starting anything:

    .venv/bin/python config.py [path/to/device.env]
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_PATH = Path(__file__).resolve().parent / "device.env"

SERIAL_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")  # same rule the dashboard enforces
CLIP_SOURCES = ("annotated", "raw")

KNOWN_KEYS = {
    "INGEST_URL", "DEVICE_SERIAL", "CAMERA_SOURCE", "MODEL", "CALIBRATION",
    "PATHWAY_ANNOTATION", "SEGMENT_MINUTES", "CLIP_SOURCE", "KEEP_HOURS", "GPU",
}


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Config:
    path: Path
    ingest_url: str
    device_serial: str
    device_key: str = field(repr=False)
    camera_source: str
    model: Path
    calibration: Path
    pathway_annotation: Path | None
    segment_minutes: int
    clip_source: str
    keep_hours: float
    gpu: str


def load_config(path: str | Path | None = None) -> Config:
    path = Path(path) if path else DEFAULT_PATH
    if not path.is_file():
        raise ConfigError(f"{path} not found. Copy device.env.example to {path.name} and fill it in.")

    values, lines = _parse(path)
    base = path.resolve().parent
    errors: list[str] = []

    def where(key: str) -> str:
        return f"{path.name} line {lines[key]}" if key in lines else path.name

    def required(key: str) -> str:
        value = values.get(key, "")
        if not value:
            errors.append(f"{key} is missing ({where(key)})")
        elif "<" in value and ">" in value:
            errors.append(f"{key} is still the example placeholder: {value} ({where(key)})")
            return ""
        return value

    def file(key: str, optional: bool = False) -> Path | None:
        value = values.get(key, "") if optional else required(key)
        if not value:
            return None
        resolved = (base / value).resolve()
        if not resolved.is_file():
            errors.append(f"{key}: {resolved} does not exist ({where(key)})")
        return resolved

    def number(key: str, default: float, minimum: float, maximum: float, integer: bool = False) -> float:
        raw = values.get(key, "")
        if not raw:
            return default
        try:
            value = int(raw) if integer else float(raw)
        except ValueError:
            errors.append(f"{key} must be a {'whole ' if integer else ''}number, got {raw!r} ({where(key)})")
            return default
        if not minimum <= value <= maximum:
            errors.append(f"{key} must be between {minimum:g} and {maximum:g}, got {raw} ({where(key)})")
        return value

    for key in sorted(set(values) - KNOWN_KEYS):
        if not key.startswith("DEVICE_KEY"):
            errors.append(f"unknown setting {key} ({where(key)}); check the spelling against device.env.example")

    ingest_url = required("INGEST_URL").rstrip("/")
    if ingest_url and not re.match(r"^https?://", ingest_url):
        errors.append(f"INGEST_URL must start with https:// ({where('INGEST_URL')})")

    serial = required("DEVICE_SERIAL")
    if serial and not SERIAL_PATTERN.match(serial):
        errors.append(f"DEVICE_SERIAL may only contain letters, digits, _ and - ({where('DEVICE_SERIAL')})")

    # The dashboard shows the key as DEVICE_KEY_<serial>=<key>; plain DEVICE_KEY also works.
    key_name = f"DEVICE_KEY_{serial}" if f"DEVICE_KEY_{serial}" in values else "DEVICE_KEY"
    device_key = values.get(key_name, "")
    if serial and (not device_key or ("<" in device_key and ">" in device_key)):
        others = [k for k in values if k.startswith("DEVICE_KEY_") and k != f"DEVICE_KEY_{serial}"]
        hint = f"; found {', '.join(others)}, which is for a different serial" if others else ""
        errors.append(f"no key for {serial}: add the DEVICE_KEY_{serial}=... line from the dashboard{hint}")

    camera_source = required("CAMERA_SOURCE")
    model = file("MODEL")
    calibration = file("CALIBRATION")
    pathway = file("PATHWAY_ANNOTATION", optional=True)
    segment_minutes = number("SEGMENT_MINUTES", 5, 1, 60, integer=True)
    keep_hours = number("KEEP_HOURS", 24, 0, 24 * 30)

    clip_source = values.get("CLIP_SOURCE") or "annotated"
    if clip_source not in CLIP_SOURCES:
        errors.append(f"CLIP_SOURCE must be annotated or raw, got {clip_source!r} ({where('CLIP_SOURCE')})")

    gpu = values.get("GPU") or "0"
    if not (gpu.isdigit() or gpu == "cpu"):
        errors.append(f"GPU must be a number or cpu, got {gpu!r} ({where('GPU')})")

    if errors:
        raise ConfigError("device configuration has problems:\n  - " + "\n  - ".join(errors))

    return Config(
        path=path.resolve(),
        ingest_url=ingest_url,
        device_serial=serial,
        device_key=device_key,
        camera_source=camera_source,
        model=model,
        calibration=calibration,
        pathway_annotation=pathway,
        segment_minutes=int(segment_minutes),
        clip_source=clip_source,
        keep_hours=float(keep_hours),
        gpu=gpu,
    )


def _parse(path: Path) -> tuple[dict[str, str], dict[str, int]]:
    """KEY=value lines. Blank lines and lines starting with # are ignored, as is
    a trailing ' # comment'. Quote a value ("..." or '...') to keep it exactly,
    e.g. a camera password containing ' #'."""
    values: dict[str, str] = {}
    lines: dict[str, int] = {}
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ConfigError(f"{path.name} line {number}: expected KEY=value, got {line!r}")
        key, value = (part.strip() for part in line.split("=", 1))
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
        if key in values:
            raise ConfigError(f"{path.name} line {number}: {key} is already set on line {lines[key]}")
        values[key] = value
        lines[key] = number
    return values, lines


def masked_source(source: str) -> str:
    """Hides a password in a camera URL (rtsp://user:secret@host → rtsp://user:***@host)."""
    return re.sub(r"(://[^:/@]+:)[^@]+@", r"\1***@", source)


if __name__ == "__main__":
    try:
        config = load_config(sys.argv[1] if len(sys.argv) > 1 else None)
    except ConfigError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
    print(f"{config.path} is valid:")
    print(f"  device       {config.device_serial} (key {len(config.device_key)} chars)")
    print(f"  ingest       {config.ingest_url}")
    print(f"  camera       {masked_source(config.camera_source)}")
    print(f"  model        {config.model}")
    print(f"  calibration  {config.calibration}")
    print(f"  pathway      {config.pathway_annotation or '(none)'}")
    print(f"  chunks       {config.segment_minutes} min, clips from {config.clip_source} video,"
          f" footage kept {config.keep_hours:g} h, GPU {config.gpu}")
