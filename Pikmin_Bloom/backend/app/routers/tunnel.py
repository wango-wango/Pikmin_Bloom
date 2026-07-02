"""
/api/tunnel — tunneld 狀態查詢端點。

提供前端查詢 tunneld daemon 是否在線，以及各裝置的 tunnel 資訊。
"""
from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter()


class TunnelInfo(BaseModel):
    udid: str
    address: str
    port: int
    interface: str


class TunnelStatusResponse(BaseModel):
    tunneld_available: bool
    tunnels: list[TunnelInfo]


@router.get("/status", response_model=TunnelStatusResponse)
async def get_tunnel_status(request: Request) -> TunnelStatusResponse:
    """回傳 tunneld daemon 狀態與所有已知 tunnel 資訊。"""
    poller = getattr(request.app.state, "tunneld_poller", None)
    if poller is None:
        return TunnelStatusResponse(tunneld_available=False, tunnels=[])

    tunnels = [
        TunnelInfo(udid=udid, **info)
        for udid, info in poller.tunnels.items()
    ]
    return TunnelStatusResponse(
        tunneld_available=poller.tunneld_available,
        tunnels=tunnels,
    )
