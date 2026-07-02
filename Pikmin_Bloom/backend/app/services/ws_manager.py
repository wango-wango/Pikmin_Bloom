"""
WebSocketManager：管理所有已連線的 WebSocket 客戶端，提供廣播功能。
"""
from __future__ import annotations

import logging

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class WebSocketManager:
    """管理 WebSocket 連線並廣播訊息給所有已連線客戶端。"""

    def __init__(self) -> None:
        self._connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        """接受並記錄新的 WebSocket 連線。"""
        await websocket.accept()
        self._connections.append(websocket)
        logger.info("WebSocket 客戶端連線，目前連線數：%d", len(self._connections))

    async def disconnect(self, websocket: WebSocket) -> None:
        """移除已斷線的 WebSocket 連線。"""
        if websocket in self._connections:
            self._connections.remove(websocket)
        logger.info("WebSocket 客戶端斷線，目前連線數：%d", len(self._connections))

    async def broadcast(self, message: dict) -> None:
        """廣播 JSON 訊息給所有已連線客戶端。

        單一客戶端發送失敗不影響其他客戶端。
        """
        disconnected: list[WebSocket] = []
        for ws in list(self._connections):
            try:
                await ws.send_json(message)
            except Exception as exc:  # noqa: BLE001
                logger.warning("廣播至客戶端失敗，將移除：%s", exc)
                disconnected.append(ws)

        for ws in disconnected:
            await self.disconnect(ws)
