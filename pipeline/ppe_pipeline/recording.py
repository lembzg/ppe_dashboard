"""
Recorder file names carry the camera and the moment recording started, e.g.

    2026_08_18_FMDC1_00_20260818082151.mp4
    └ date ──┘ └cam┘ └ch┘ └ start ──────┘

The camera and channel together are the device serial (FMDC1_00). The start time
is wall-clock time at the site.
"""
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

NAME_PATTERN = re.compile(r"^\d{4}_\d{2}_\d{2}_(?P<camera>[A-Za-z0-9]+)_(?P<channel>\d+)_(?P<start>\d{14})$")

# Fixed namespace so the same recording always maps to the same session id.
SESSION_NAMESPACE = uuid.UUID("6f1c3a52-2b8e-4b7a-9d55-0c1f7c2e9a10")


@dataclass(frozen=True)
class Recording:
    path: Path
    serial: str
    started_at: datetime  # timezone-aware

    @property
    def name(self):
        return self.path.stem

    @property
    def session_id(self):
        return str(uuid.uuid5(SESSION_NAMESPACE, self.serial + "/" + self.name))


def parse_recording(path, timezone):
    path = Path(path)
    match = NAME_PATTERN.match(path.stem)
    if not match:
        raise ValueError(f"{path.name} does not follow YYYY_MM_DD_<camera>_<channel>_<YYYYMMDDHHMMSS>")
    started_at = datetime.strptime(match["start"], "%Y%m%d%H%M%S").replace(tzinfo=ZoneInfo(timezone))
    return Recording(path=path, serial=match["camera"] + "_" + match["channel"], started_at=started_at)
