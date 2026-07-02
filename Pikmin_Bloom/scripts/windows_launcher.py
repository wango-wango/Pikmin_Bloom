import os
import subprocess
import sys
import time
import webbrowser
from pathlib import Path


def run_detached(cmd, cwd=None, env=None):
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    return subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        creationflags=creationflags,
    )


def main():
    base = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent.parent / "release" / "pikomin-win-portable"
    runtime_py = base / "python" / "python.exe"
    pmd3_launcher = base / "pymobiledevice3_portable.py"
    uvicorn_launcher = base / "uvicorn_portable.py"
    if not runtime_py.exists():
        print(f"Missing bundled Python runtime: {runtime_py}")
        sys.exit(1)
    if not pmd3_launcher.exists():
        print(f"Missing pymobiledevice3 launcher: {pmd3_launcher}")
        sys.exit(1)
    if not uvicorn_launcher.exists():
        print(f"Missing uvicorn launcher: {uvicorn_launcher}")
        sys.exit(1)

    backend_port = os.environ.get("BACKEND_PORT", "5679")
    app_url = f"http://localhost:{backend_port}"
    env = os.environ.copy()
    env["FRONTEND_DIST_DIR"] = str(base / "frontend" / "dist")
    env["HOST_BRIDGE_URL"] = ""
    env["PMD3_COMMAND"] = f'"{runtime_py}" "{pmd3_launcher}"'

    # 1) tunneld (TCP)
    run_detached([str(runtime_py), str(pmd3_launcher), "remote", "tunneld", "--protocol", "tcp"], env=env)

    # 2) backend + bundled frontend
    run_detached(
        [str(runtime_py), str(uvicorn_launcher), "--app-dir", str(base / "backend"), "app.main:app", "--host", "0.0.0.0", "--port", backend_port],
        cwd=str(base / "backend"),
        env=env,
    )

    time.sleep(1.2)
    webbrowser.open(app_url)
    print("Pikomin started. You can close this window.")


if __name__ == "__main__":
    main()
