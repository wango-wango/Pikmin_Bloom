from importlib.metadata import entry_points


def main() -> int:
    return entry_points(group="console_scripts")["uvicorn"].load()()


if __name__ == "__main__":
    raise SystemExit(main())
