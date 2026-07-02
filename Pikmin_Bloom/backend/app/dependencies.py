"""
FastAPI Dependency Injection：提供 DeviceManager、RouteEngine、WebSocketManager 單例。
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import Request

if TYPE_CHECKING:
    from app.services.device_manager import DeviceManager
    from app.services.route_engine import RouteEngine
    from app.services.ws_manager import WebSocketManager


def get_device_manager(request: Request) -> "DeviceManager":
    return request.app.state.device_manager


def get_route_engine(request: Request) -> "RouteEngine":
    return request.app.state.route_engine


def get_ws_manager(request: Request) -> "WebSocketManager":
    return request.app.state.ws_manager
