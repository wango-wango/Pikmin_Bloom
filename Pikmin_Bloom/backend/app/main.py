from contextlib import asynccontextmanager
import asyncio
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.routers import devices, location, route, status, rsd, geolocation, tunnel, landmarks, saved_routes, postcards
from app.services.device_manager import DeviceManager
from app.services.route_engine import RouteEngine
from app.services.tunneld_poller import TunneldPoller
from app.services.ws_manager import WebSocketManager


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 初始化單例
    device_manager = DeviceManager()
    route_engine = RouteEngine(device_manager)
    ws_manager = WebSocketManager()
    tunneld_poller = TunneldPoller(device_manager)

    app.state.device_manager = device_manager
    app.state.route_engine = route_engine
    app.state.ws_manager = ws_manager
    app.state.tunneld_poller = tunneld_poller

    # 啟動背景任務
    polling_task = asyncio.create_task(device_manager.start_device_polling())
    tunneld_task = asyncio.create_task(tunneld_poller.start_polling())

    yield

    # 清理
    polling_task.cancel()
    tunneld_task.cancel()
    await route_engine.stop_route()


app = FastAPI(title="iOS GPS Simulator", version="0.1.0", lifespan=lifespan)

# CORS 設定：允許前端 origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5678",
        "http://127.0.0.1:5678",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 掛載 API 路由
app.include_router(devices.router, prefix="/api/devices", tags=["devices"])
app.include_router(location.router, prefix="/api/location", tags=["location"])
app.include_router(route.router, prefix="/api/route", tags=["route"])
app.include_router(status.router, prefix="/api/status", tags=["status"])
app.include_router(rsd.router, prefix="/api/rsd", tags=["rsd"])
app.include_router(geolocation.router, prefix="/api/geolocation", tags=["geolocation"])
app.include_router(tunnel.router, prefix="/api/tunnel", tags=["tunnel"])
app.include_router(landmarks.router, prefix="/api/landmarks", tags=["landmarks"])
app.include_router(saved_routes.router, prefix="/api/saved-routes", tags=["saved-routes"])
app.include_router(postcards.router, prefix="/api/postcards", tags=["postcards"])


@app.websocket("/ws/status")
async def websocket_status(websocket: WebSocket):
    ws_manager: WebSocketManager = websocket.app.state.ws_manager
    await ws_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await ws_manager.disconnect(websocket)


def _frontend_dist_dir() -> Path | None:
    configured = os.environ.get("FRONTEND_DIST_DIR", "").strip()
    candidates = []
    if configured:
        candidates.append(Path(configured))

    app_dir = Path(__file__).resolve().parents[1]
    candidates.extend(
        [
            app_dir.parent / "frontend" / "dist",
            app_dir.parent.parent / "frontend" / "dist",
        ]
    )

    for candidate in candidates:
        index_file = candidate / "index.html"
        if index_file.exists():
            return candidate
    return None


frontend_dist = _frontend_dist_dir()
if frontend_dist is not None:
    app.mount("/assets", StaticFiles(directory=frontend_dist / "assets"), name="assets")

    for asset_name in ("marker-icon.png", "marker-icon-2x.png", "marker-shadow.png"):
        asset_path = frontend_dist / asset_name
        if asset_path.exists():
            route_path = f"/{asset_name}"

            async def serve_asset(path: Path = asset_path) -> FileResponse:
                return FileResponse(path)

            app.get(route_path, include_in_schema=False)(serve_asset)

    @app.get("/", include_in_schema=False)
    async def serve_frontend_index() -> FileResponse:
        return FileResponse(frontend_dist / "index.html")

    @app.get("/{path:path}", include_in_schema=False)
    async def serve_frontend_fallback(path: str) -> FileResponse:
        return FileResponse(frontend_dist / "index.html")
