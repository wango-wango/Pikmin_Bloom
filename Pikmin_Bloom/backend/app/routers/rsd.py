from fastapi import APIRouter, Depends
from pydantic import BaseModel
from app.dependencies import get_device_manager
from app.services.device_manager import DeviceManager

router = APIRouter()

class RSDRequest(BaseModel):
    device_id: str
    address: str
    port: int

@router.post("")
async def set_rsd(req: RSDRequest, dm: DeviceManager = Depends(get_device_manager)):
    dm.set_rsd_info(req.device_id, req.address, req.port)
    return {"success": True, "message": f"RSD 已設定 {req.device_id}"}
