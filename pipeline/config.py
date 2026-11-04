from pathlib import Path
from dotenv import dotenv_values

class ConfigError(ValueError):
    pass

def load_config():
    env_path = Path(__file__).resolve().parent / "device.env"

    if not env_path.is_file():
        raise ConfigError("device.env was not found")

    settings = dotenv_values(env_path)

    required_keys = [
        "INGEST_URL",
        "DEVICE_SERIAL",
        "DEVICE_KEY",
        "CAMERA_SOURCE",
        "MODEL",
        "CALIBRATION",
    ]

    # Check if all parameters are filled
    for key in required_keys:
        if not settings.get(key):
            raise ConfigError(f"{key} is missing")

    # Check if key exists
    for key in ["MODEL", "CALIBRATION"]:
        file_path = env_path.parent / settings[key]

        if not file_path.is_file():
            raise ConfigError(f"{key}: file not found at {file_path}")

        settings[key] = str(file_path.resolve())

    return settings
