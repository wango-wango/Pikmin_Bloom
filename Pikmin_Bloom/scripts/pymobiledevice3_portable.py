import sys
from importlib.metadata import entry_points


def main() -> int:
    scripts = entry_points(group="console_scripts")
    entry = scripts["pymobiledevice3"]
    return entry.load()()


if __name__ == "__main__":
    raise SystemExit(main())
