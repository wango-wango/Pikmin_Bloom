from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import get_route_engine, get_ws_manager
from app.models.schemas import ErrorResponse, GPSCoordinate, RouteRequest
from app.services.route_engine import RouteEngine
from app.services.ws_manager import WebSocketManager

router = APIRouter()


@router.post("/start", responses={409: {"model": ErrorResponse}})
async def start_route(
    request: RouteRequest,
    route_engine: RouteEngine = Depends(get_route_engine),
    ws_manager: WebSocketManager = Depends(get_ws_manager),
) -> dict:
    """啟動路徑自動移動。"""
    async def on_position_update(coord: GPSCoordinate, progress: float) -> None:
        await ws_manager.broadcast({
            "type": "position",
            "data": {
                "latitude": coord.latitude,
                "longitude": coord.longitude,
                "progress": progress,
            },
        })
    async def on_route_error(message: str) -> None:
        await ws_manager.broadcast({
            "type": "route_error",
            "data": {"message": message},
        })
        await ws_manager.broadcast({
            "type": "status",
            "data": {"state": "idle", "progress": 0},
        })

    try:
        await route_engine.start_route(
            device_id=request.device_id,
            waypoints=request.waypoints,
            speed=request.speed,
            loop=request.loop,
            on_position_update=on_position_update,
            on_route_error=on_route_error,
        )
    except RuntimeError as exc:
        raise HTTPException(
            status_code=409,
            detail=ErrorResponse(error=str(exc), code="ROUTE_ALREADY_RUNNING").model_dump(),
        ) from exc
    return {"success": True}


@router.post("/pause")
async def pause_route(
    route_engine: RouteEngine = Depends(get_route_engine),
) -> dict:
    """暫停路徑移動。"""
    await route_engine.pause_route()
    return {"success": True}


@router.post("/resume")
async def resume_route(
    route_engine: RouteEngine = Depends(get_route_engine),
) -> dict:
    """繼續路徑移動。"""
    await route_engine.resume_route()
    return {"success": True}


@router.post("/stop")
async def stop_route(
    route_engine: RouteEngine = Depends(get_route_engine),
    ws_manager: WebSocketManager = Depends(get_ws_manager),
) -> dict:
    """停止路徑移動。"""
    await route_engine.stop_route()
    await ws_manager.broadcast({"type": "status", "data": {"state": "idle", "progress": 0}})
    return {"success": True}
