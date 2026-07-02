"""
TunneldPoller：定期查詢本機 tunneld daemon，自動更新 DeviceManager 的 RSD 資訊。

使用方式：
  1. 在主機執行一次：sudo pymobiledevice3 remote tunneld
  2. TunneldPoller 會自動偵測所有 USB/WiFi 裝置的 tunnel，不需手動貼 RSD。

tunneld HTTP API（預設 127.0.0.1:49151）：
  GET / → { "<udid>": [{"tunnel-address": "...", "tunnel-port": 12345, "interface": "..."}] }
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from app.services.device_manager import DeviceManager

logger = logging.getLogger(__name__)

TUNNELD_HOST = os.environ.get("TUNNELD_HOST", "127.0.0.1")
TUNNELD_PORT = int(os.environ.get("TUNNELD_PORT", "49151"))
TUNNELD_URL = os.environ.get("TUNNELD_URL", f"http://{TUNNELD_HOST}:{TUNNELD_PORT}")
RSD_ADDRESS_OVERRIDE = os.environ.get("RSD_ADDRESS_OVERRIDE", "").strip()
POLL_INTERVAL = 5  # 秒


class TunneldPoller:
    """定期查詢 tunneld daemon，自動將 RSD 資訊注入 DeviceManager。

    Args:
        device_manager: 要更新 RSD 資訊的 DeviceManager 實例。
        poll_interval: 查詢間隔（秒），預設 5 秒。
        tunneld_url: tunneld HTTP API 位址，預設 http://127.0.0.1:49151。
    """

    def __init__(
        self,
        device_manager: DeviceManager,
        poll_interval: int = POLL_INTERVAL,
        tunneld_url: str = TUNNELD_URL,
    ) -> None:
        self._dm = device_manager
        self._poll_interval = poll_interval
        self._tunneld_url = tunneld_url

        # 目前已知的 tunnel 狀態：udid -> {"address": str, "port": int, "interface": str}
        self._tunnels: dict[str, dict] = {}
        self._tunneld_available: bool = False

    # ── 公開屬性 ──────────────────────────────────────────────────────────────

    @property
    def tunneld_available(self) -> bool:
        """tunneld daemon 是否在線。"""
        return self._tunneld_available

    @property
    def tunnels(self) -> dict[str, dict]:
        """目前所有已知的 tunnel 資訊（唯讀快照）。"""
        return dict(self._tunnels)

    # ── 背景輪詢 ──────────────────────────────────────────────────────────────

    async def start_polling(self) -> None:
        """背景任務：每 poll_interval 秒查詢一次 tunneld，更新 DeviceManager RSD 資訊。"""
        logger.info("TunneldPoller 啟動，查詢位址：%s", self._tunneld_url)
        async with httpx.AsyncClient(timeout=3.0) as client:
            while True:
                await self._poll_once(client)
                await asyncio.sleep(self._poll_interval)

    async def _poll_once(self, client: httpx.AsyncClient) -> None:
        """執行一次 tunneld 查詢，更新內部狀態與 DeviceManager。"""
        try:
            resp = await client.get(self._tunneld_url)
            resp.raise_for_status()
            data: dict[str, list[dict]] = resp.json()
        except httpx.ConnectError:
            if self._tunneld_available:
                logger.warning(
                    "tunneld 連線失敗（%s）。請確認已執行：sudo pymobiledevice3 remote tunneld",
                    self._tunneld_url,
                )
            self._tunneld_available = False
            self._tunnels = {}
            return
        except Exception as exc:  # noqa: BLE001
            logger.warning("tunneld 查詢失敗: %s", exc)
            self._tunneld_available = False
            self._tunnels = {}
            return

        if not self._tunneld_available:
            logger.info("tunneld 已上線，開始自動管理 RSD tunnel。")
        self._tunneld_available = True

        new_tunnels: dict[str, dict] = {}
        for udid, details_list in data.items():
            if not details_list:
                continue
            # 取第一個可用的 tunnel（通常只有一個）
            detail = details_list[0]
            address = detail.get("tunnel-address", "")
            port = detail.get("tunnel-port", 0)
            interface = detail.get("interface", "")
            if RSD_ADDRESS_OVERRIDE:
                address = RSD_ADDRESS_OVERRIDE
            # tunneld 某些版本會帶裝置識別資訊，優先拿來顯示名稱
            device_name = (
                detail.get("device-name")
                or detail.get("name")
                or detail.get("DeviceName")
                or ""
            )
            product_type = (
                detail.get("product-type")
                or detail.get("ProductType")
                or None
            )
            if not address or not port:
                continue
            new_tunnels[udid] = {
                "address": address,
                "port": port,
                "interface": interface,
                "name": device_name,
                "model": product_type,
            }

        # 更新 DeviceManager 的 RSD 資訊，並確保裝置存在於 registry
        for udid, info in new_tunnels.items():
            old = self._tunnels.get(udid)
            if old != info:
                self._dm.set_rsd_info(udid, info["address"], info["port"])
                logger.info(
                    "tunneld 自動設定 RSD：device=%s addr=%s port=%d interface=%s",
                    udid, info["address"], info["port"], info["interface"],
                )
            # WiFi 裝置不會出現在 USB 掃描結果，需手動確保 registry 有此裝置
            self._dm.ensure_device(udid, name=info.get("name") or None, model=info.get("model"))

        # 移除已消失的 tunnel 對應裝置（僅限 tunneld 管理的，不影響 USB 裝置）
        for udid in set(self._tunnels) - set(new_tunnels):
            self._dm.remove_tunneld_device(udid)

        self._tunnels = new_tunnels
