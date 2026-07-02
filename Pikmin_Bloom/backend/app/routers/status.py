from fastapi import APIRouter, Depends

from app.dependencies import get_route_engine
from app.models.schemas import RouteStatus
from app.services.route_engine import RouteEngine

router = APIRouter()


@router.get("", response_model=RouteStatus)
async def get_status(
    route_engine: RouteEngine = Depends(get_route_engine),
) -> RouteStatus:
    """取得目前模擬狀態。"""
    return route_engine.get_status()
