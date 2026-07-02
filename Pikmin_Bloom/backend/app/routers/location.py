from fastapi import APIRouter, Depends, HTTPException

from pydantic import BaseModel
from app.dependencies import get_device_manager, get_route_engine, get_ws_manager
from app.models.schemas import SetLocationRequest, GPSCoordinate, ErrorResponse
from app.services.device_manager import DeviceManager, DeviceNotFoundError, LocationSetError
from app.services.route_engine import RouteEngine
from app.services.ws_manager import WebSocketManager

router = APIRouter()


@router.post("", responses={
    404: {"model": ErrorResponse},
    400: {"model": ErrorResponse},
})
async def set_location(
    request: SetLocationRequest,
    device_manager: DeviceManager = Depends(get_device_manager),
    route_engine: RouteEngine = Depends(get_route_engine),
    ws_manager: WebSocketManager = Depends(get_ws_manager),
) -> dict:
    """設定裝置 GPS 位置。"""
    coordinate = GPSCoordinate(latitude=request.latitude, longitude=request.longitude)
    try:
        await device_manager.set_location(request.device_id, coordinate)
    except DeviceNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail=ErrorResponse(error=str(exc), code="DEVICE_NOT_FOUND").model_dump(),
        ) from exc
    except LocationSetError as exc:
        message = str(exc).lower()
        code = "LOCATION_BRIDGE_FAILED" if "host bridge" in message else "LOCATION_SET_FAILED"
        raise HTTPException(
            status_code=400,
            detail=ErrorResponse(error=str(exc), code=code).model_dump(),
        ) from exc
    route_engine.sync_manual_position(request.device_id, coordinate)
    await ws_manager.broadcast({
        "type": "status",
        "data": {
            "state": "idle",
            "current_position": {
                "latitude": coordinate.latitude,
                "longitude": coordinate.longitude,
            },
            "progress": 0,
        },
    })
    return {"success": True}


class ResetRequest(BaseModel):
    device_id: str


@router.post("/reset", responses={404: {"model": ErrorResponse}, 400: {"model": ErrorResponse}})
async def reset_location(
    request: ResetRequest,
    device_manager: DeviceManager = Depends(get_device_manager),
    route_engine: RouteEngine = Depends(get_route_engine),
    ws_manager: WebSocketManager = Depends(get_ws_manager),
) -> dict:
    """停止 GPS 模擬，恢復真實位置。"""
    try:
        await device_manager.stop_simulation(request.device_id)
    except DeviceNotFoundError as exc:
        raise HTTPException(status_code=404, detail=ErrorResponse(error=str(exc), code="DEVICE_NOT_FOUND").model_dump()) from exc
    except LocationSetError as exc:
        message = str(exc).lower()
        code = "LOCATION_BRIDGE_FAILED" if "host bridge" in message else "LOCATION_SET_FAILED"
        raise HTTPException(status_code=400, detail=ErrorResponse(error=str(exc), code=code).model_dump()) from exc
    route_engine.sync_manual_position(request.device_id, None)
    await ws_manager.broadcast({
        "type": "status",
        "data": {"state": "idle", "current_position": None, "progress": 0},
    })
    return {"success": True}
