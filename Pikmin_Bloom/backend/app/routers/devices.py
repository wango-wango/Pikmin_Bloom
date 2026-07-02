from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import get_device_manager
from app.models.schemas import DeviceInfo, ErrorResponse
from app.services.device_manager import DeviceManager, DeviceNotFoundError

router = APIRouter()


@router.get("", response_model=list[DeviceInfo])
async def list_devices(
    device_manager: DeviceManager = Depends(get_device_manager),
) -> list[DeviceInfo]:
    return await device_manager.list_devices()


@router.post("/{device_id}/developer-mode/reveal")
async def reveal_developer_mode(
    device_id: str,
    device_manager: DeviceManager = Depends(get_device_manager),
) -> dict[str, str]:
    try:
        await device_manager.reveal_developer_mode(device_id)
    except DeviceNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail=ErrorResponse(error=str(exc), code="DEVICE_NOT_FOUND").model_dump(),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=ErrorResponse(error=str(exc), code="DEVELOPER_MODE_REVEAL_FAILED").model_dump(),
        ) from exc
    return {"status": "ok"}
