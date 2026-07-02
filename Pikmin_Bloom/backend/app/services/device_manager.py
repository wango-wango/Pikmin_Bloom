"""
DeviceManager：封裝 pymobiledevice3 操作，管理 iOS 裝置連線與 GPS 指令傳送。

iOS 17+ (含 iOS 26) 需透過 RSD tunnel 方式操作。
請先在主機執行：sudo pymobiledevice3 remote tunneld
TunneldPoller 會自動讀取 RSD 資訊，不需手動設定。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
from typing import Callable, Awaitable
import httpx

from app.models.schemas import DeviceInfo, GPSCoordinate

PMD3 = os.environ.get("PMD3_PATH", "pymobiledevice3")
PMD3_COMMAND = shlex.split(os.environ.get("PMD3_COMMAND", "").strip()) or [PMD3]
HOST_BRIDGE_URL = os.environ.get("HOST_BRIDGE_URL", "").strip()
logger = logging.getLogger(__name__)


def pmd3_cmd(*args: str) -> list[str]:
    return [*PMD3_COMMAND, *args]


def _decode_process_output(data: bytes | None) -> str:
    if not data:
        return ""
    return data.decode("utf-8", errors="replace").strip()


def _developer_mode_hint(detail: str) -> str:
    lowered = detail.lower()
    hints: list[str] = []
    if "dtservicehub" in lowered or "invalidservice" in lowered or "no such service" in lowered:
        hints.append(
            "iPhone 沒有開放 DVT / dtservicehub。請確認 Developer Mode 已開啟，並且 iOS 17+ 已掛載 DDI。"
        )
    if "developer mode" in lowered or "amfi" in lowered:
        hints.append("請在 iPhone 設定 > 隱私權與安全性 開啟 Developer Mode，重開機後再次確認。")
    if "rsd" in lowered or "tunnel" in lowered:
        hints.append("請確認 Pikomin Tunnel 仍在執行，Windows 端需用系統管理員身分啟動。")
    if hints:
        return f"{detail} {' '.join(hints)}"
    return detail

# ── 自訂例外 ──────────────────────────────────────────────────────────────────

class DeviceNotFoundError(Exception):
    """指定的 device_id 不存在於已連線裝置清單中。"""

    def __init__(self, device_id: str) -> None:
        self.device_id = device_id
        super().__init__(f"Device not found: {device_id}")


class LocationSetError(Exception):
    """pymobiledevice3 設定 GPS 位置失敗。"""

    def __init__(self, device_id: str, reason: str = "") -> None:
        self.device_id = device_id
        self.reason = reason
        super().__init__(f"Failed to set location on {device_id}: {reason}")


# ── Mock 裝置常數 ─────────────────────────────────────────────────────────────

_MOCK_DEVICE = DeviceInfo(
    id="mock-device-001",
    name="Mock iPhone",
    is_connected=True,
    model="iPhone (Mock)",
)


# ── DeviceManager ─────────────────────────────────────────────────────────────

class DeviceManager:
    """管理 iOS 裝置連線狀態與 GPS 模擬指令。

    Args:
        mock_mode: 若為 True，不呼叫 pymobiledevice3，以假裝置回應所有操作。
                   預設從環境變數 ``MOCK_MODE`` 讀取（值為 ``"true"`` 時啟用）。
    """

    def __init__(self, mock_mode: bool | None = None) -> None:
        if mock_mode is None:
            mock_mode = os.environ.get("MOCK_MODE", "").lower() == "true"
        self.mock_mode: bool = mock_mode

        # device_id -> DeviceInfo
        self._registry: dict[str, DeviceInfo] = {}

        # device_id -> (rsd_address, rsd_port)
        self._rsd_info: dict[str, tuple[str, int]] = {}

        # device_id -> 正在執行的 simulate-location 程序（stop 用）
        self._location_procs: dict[str, asyncio.subprocess.Process] = {}

        # device_id -> 快取的 LocationSimulation 連線
        self._location_sessions: dict[str, object] = {}
        # device_id -> 對應的 RSD / DvtProvider context（用於關閉）
        self._location_contexts: dict[str, list] = {}
        # 保護同一裝置不同時建立多個連線
        self._session_locks: dict[str, asyncio.Lock] = {}

        # device_id -> power-assertion process (用於保持 Wi-Fi 連線)
        self._power_assertions: dict[str, asyncio.subprocess.Process] = {}

        # tunneld 自動加入的裝置 ID（WiFi 裝置，非 USB 掃描）
        self._tunneld_device_ids: set[str] = set()

        # 事件回呼（可由外部設定）
        self.on_device_connected: Callable[[DeviceInfo], Awaitable[None]] | None = None
        self.on_device_disconnected: Callable[[DeviceInfo], Awaitable[None]] | None = None

        if self.mock_mode:
            logger.warning("DeviceManager 以 mock mode 啟動，不會存取實體 USB 裝置。")
            self._registry[_MOCK_DEVICE.id] = _MOCK_DEVICE

    # ── 公開介面 ──────────────────────────────────────────────────────────────

    async def list_devices(self) -> list[DeviceInfo]:
        """回傳目前已連線的裝置清單。

        Mock mode 下固定回傳 mock-device-001。
        """
        if self.mock_mode:
            return [_MOCK_DEVICE]
        if HOST_BRIDGE_URL:
            return await self._list_usb_devices_via_host_bridge()
        return list(self._registry.values())

    async def set_location(
        self,
        device_id: str,
        coordinate: GPSCoordinate,
    ) -> None:
        """設定指定裝置的模擬 GPS 位置。

        Args:
            device_id: 目標裝置 ID。
            coordinate: 目標 GPS 座標。

        Raises:
            DeviceNotFoundError: 裝置不存在。
            LocationSetError: pymobiledevice3 呼叫失敗（非 mock mode）。
        """
        device = self.get_device(device_id)
        # 自癒：若 registry 暫時抖動遺失，但 RSD 仍存在，先補回裝置再執行。
        if device is None and device_id in self._rsd_info:
            self.ensure_device(device_id)
            device = self.get_device(device_id)
        if device is None:
            raise DeviceNotFoundError(device_id)

        if self.mock_mode:
            logger.info(
                "[mock] set_location device=%s lat=%.6f lng=%.6f",
                device_id,
                coordinate.latitude,
                coordinate.longitude,
            )
            return

        if HOST_BRIDGE_URL:
            await self._host_bridge_set_location(device_id, coordinate)
            return
        await self._pymobiledevice_set_location(device_id, coordinate)

    async def stop_simulation(self, device_id: str) -> None:
        """停止指定裝置的 GPS 模擬，恢復真實位置。

        Args:
            device_id: 目標裝置 ID。

        Raises:
            DeviceNotFoundError: 裝置不存在。
        """
        device = self.get_device(device_id)
        if device is None:
            raise DeviceNotFoundError(device_id)

        if self.mock_mode:
            logger.info("[mock] stop_simulation device=%s", device_id)
            return

        if HOST_BRIDGE_URL:
            await self._host_bridge_stop_simulation(device_id)
            return
        await self._pymobiledevice_stop_simulation(device_id)

    async def reveal_developer_mode(self, device_id: str) -> None:
        """Ask iOS to show the Developer Mode toggle in Settings.

        This does not enable Developer Mode by itself. The user still has to
        turn it on from the iPhone and confirm after the reboot.
        """
        device = self.get_device(device_id)
        if device is None:
            raise DeviceNotFoundError(device_id)
        if self.mock_mode:
            logger.info("[mock] reveal_developer_mode device=%s", device_id)
            return
        try:
            from pymobiledevice3.lockdown import create_using_usbmux
            from pymobiledevice3.services.amfi import AmfiService

            lockdown = await create_using_usbmux(serial=device_id, autopair=True, connection_type="USB")
            await AmfiService(lockdown).reveal_developer_mode_option_in_ui()
            logger.info("Developer Mode reveal requested device=%s", device_id)
        except Exception as exc:
            detail = str(exc).strip() or exc.__class__.__name__
            raise RuntimeError(
                "無法顯示 Developer Mode 選項。請確認 iPhone 已用 USB 連接、已解鎖並信任此電腦。"
                f" 原始錯誤: {detail}"
            ) from exc

    async def _host_bridge_set_location(self, device_id: str, coordinate: GPSCoordinate) -> None:
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(
                    f"{HOST_BRIDGE_URL}/set-location",
                    json={
                        "device_id": device_id,
                        "latitude": coordinate.latitude,
                        "longitude": coordinate.longitude,
                    },
                )
                if resp.status_code >= 400:
                    raise LocationSetError(
                        device_id,
                        f"host bridge set-location HTTP {resp.status_code}: {resp.text}",
                    )
        except Exception as exc:
            detail = str(exc).strip() or repr(exc)
            raise LocationSetError(device_id, f"host bridge set-location 失敗: {detail}") from exc

    async def _host_bridge_stop_simulation(self, device_id: str) -> None:
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(
                    f"{HOST_BRIDGE_URL}/clear-location",
                    json={"device_id": device_id},
                )
                if resp.status_code >= 400:
                    raise LocationSetError(
                        device_id,
                        f"host bridge clear-location HTTP {resp.status_code}: {resp.text}",
                    )
        except Exception as exc:
            detail = str(exc).strip() or repr(exc)
            raise LocationSetError(device_id, f"host bridge clear-location 失敗: {detail}") from exc

    async def _list_usb_devices_via_host_bridge(self) -> list[DeviceInfo]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f"{HOST_BRIDGE_URL}/usb-devices")
            resp.raise_for_status()
            devices = [DeviceInfo.model_validate(item) for item in resp.json()]
        except Exception as exc:  # noqa: BLE001
            logger.warning("host bridge USB 裝置查詢失敗: %s", exc)
            return [
                device
                for device_id, device in self._registry.items()
                if device_id not in self._tunneld_device_ids
            ]

        for device in devices:
            self._registry[device.id] = device
            self._tunneld_device_ids.discard(device.id)
        return devices

    def get_device(self, device_id: str) -> DeviceInfo | None:
        """取得單一裝置資訊，不存在回傳 None。"""
        if self.mock_mode:
            return _MOCK_DEVICE if device_id == _MOCK_DEVICE.id else None
        return self._registry.get(device_id)

    def set_rsd_info(self, device_id: str, address: str, port: int) -> None:
        """設定裝置的 RSD tunnel 資訊（iOS 17+ 必須）。"""
        old = self._rsd_info.get(device_id)
        self._rsd_info[device_id] = (address, port)
        logger.info("RSD info 已設定 device=%s addr=%s port=%d", device_id, address, port)
        # RSD 資訊變更時，清除舊的快取連線（下次 set_location 時重建），並啟動 power-assertion 避免裝置休眠斷線
        if old != (address, port):
            if device_id in self._location_sessions:
                asyncio.ensure_future(self._close_location_session(device_id))
                logger.info("RSD 已更新，清除 LocationSimulation 快取 device=%s", device_id)
            asyncio.ensure_future(self._start_power_assertion(device_id, address, port))
            asyncio.ensure_future(self._fetch_device_metadata_via_rsd(device_id, address, port))

    async def _start_power_assertion(self, device_id: str, addr: str, port: int) -> None:
        if device_id in self._power_assertions:
            try:
                self._power_assertions[device_id].terminate()
            except Exception:
                pass
        
        cmd = pmd3_cmd(
            "power-assertion", "AMDPowerAssertionTypeWirelessSync", "pikomin", "86400",
            "--rsd", addr, str(port)
        )
        logger.info("啟動 power-assertion 以保持 Wi-Fi 連線: device=%s", device_id)
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            self._power_assertions[device_id] = proc
        except Exception as exc:
            logger.warning("無法啟動 power-assertion: %s", exc)

    def ensure_device(self, device_id: str, name: str | None = None, model: str | None = None) -> None:
        """確保裝置存在於 registry（供 tunneld WiFi 裝置使用）。

        若裝置已在 registry 則不做任何事；
        若不存在則建立一筆記錄，並嘗試透過 pymobiledevice3 查詢真實裝置名稱。
        """
        if self.mock_mode:
            return
        if device_id not in self._registry:
            resolved_name = (name or "").strip() or device_id
            device = DeviceInfo(
                id=device_id,
                name=resolved_name,
                is_connected=True,
                model=model,
            )
            self._registry[device_id] = device
            self._tunneld_device_ids.add(device_id)
            logger.info("tunneld 裝置加入 registry: %s", device_id)
            if self.on_device_connected is not None:
                asyncio.ensure_future(self.on_device_connected(device))
            # 若初始名稱仍是 UDID，再背景查詢真實裝置名稱
            if resolved_name == device_id:
                asyncio.ensure_future(self._fetch_device_name(device_id))
        elif name and device_id in self._registry:
            current = self._registry[device_id]
            if current.name == device_id:
                self._registry[device_id] = DeviceInfo(
                    id=device_id,
                    name=name,
                    is_connected=True,
                    model=model or current.model,
                )
                logger.info("tunneld 裝置名稱更新: %s → %s", device_id, name)

    async def _fetch_device_name(self, device_id: str) -> None:
        """背景查詢裝置真實名稱，更新 registry。"""
        try:
            proc = await asyncio.create_subprocess_exec(
                *pmd3_cmd("usbmux", "list"),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.communicate()
                logger.debug("usbmux 裝置名稱查詢逾時: %s", device_id)
                return
            if proc.returncode != 0:
                return
            raw = stdout.decode().strip()
            lines = raw.splitlines()
            json_start = next((i for i, l in enumerate(lines) if l.strip().startswith("[")), None)
            if json_start is None:
                return
            data = json.loads("\n".join(lines[json_start:]))
            for entry in data:
                if entry.get("Identifier") == device_id:
                    name = entry.get("DeviceName", device_id)
                    model = entry.get("ProductType")
                    self._update_device_metadata(device_id, name=name, model=model)
                    return
        except Exception as exc:  # noqa: BLE001
            logger.debug("查詢裝置名稱失敗 %s: %s", device_id, exc)

    async def _fetch_device_metadata_via_rsd(self, device_id: str, address: str, port: int) -> None:
        """透過 RSD lockdown 查詢裝置名稱，避免只顯示 UDID。"""
        if HOST_BRIDGE_URL:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.get(f"{HOST_BRIDGE_URL}/device-info/{device_id}")
                if resp.status_code < 400:
                    payload = resp.json()
                    self._update_device_metadata(
                        device_id,
                        name=payload.get("name"),
                        model=payload.get("model"),
                    )
                    return
            except Exception as exc:  # noqa: BLE001
                logger.debug("host bridge 裝置名稱查詢失敗 %s: %s", device_id, exc)

        try:
            proc = await asyncio.create_subprocess_exec(
                PMD3, "lockdown", "get",
                "--rsd", address, str(port),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=6)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.communicate()
                logger.debug("RSD 裝置名稱查詢逾時: %s", device_id)
                return

            if proc.returncode != 0:
                return

            payload = json.loads(stdout.decode().strip())
            if not isinstance(payload, dict):
                return
            name = payload.get("DeviceName")
            model = payload.get("ProductType")
            self._update_device_metadata(
                device_id,
                name=str(name) if name else None,
                model=str(model) if model else None,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("RSD 裝置名稱查詢失敗 %s: %s", device_id, exc)

    def _update_device_metadata(
        self,
        device_id: str,
        name: str | None = None,
        model: str | None = None,
    ) -> None:
        device = self._registry.get(device_id)
        if device is None:
            return

        next_name = (name or "").strip()
        next_model = (model or "").strip()
        should_update_name = bool(next_name) and device.name == device_id
        should_update_model = bool(next_model) and device.model != next_model
        if not should_update_name and not should_update_model:
            return

        self._registry[device_id] = DeviceInfo(
            id=device.id,
            name=next_name if should_update_name else device.name,
            is_connected=True,
            model=next_model if should_update_model else device.model,
        )
        logger.info(
            "裝置資訊已更新: %s name=%s model=%s",
            device_id,
            self._registry[device_id].name,
            self._registry[device_id].model,
        )

    def remove_tunneld_device(self, device_id: str) -> None:
        """移除由 tunneld 管理、且 tunnel 已消失的裝置。

        只移除透過 ensure_device 加入的裝置，不影響 USB 掃描到的裝置。
        """
        if device_id not in self._tunneld_device_ids:
            return
        self._tunneld_device_ids.discard(device_id)
        device = self._registry.pop(device_id, None)
        if device is not None:
            logger.info("tunneld 裝置移出 registry: %s", device_id)
            disconnected = DeviceInfo(
                id=device.id, name=device.name,
                is_connected=False, model=device.model,
            )
            if self.on_device_disconnected is not None:
                asyncio.ensure_future(self.on_device_disconnected(disconnected))

    # ── 背景輪詢 ──────────────────────────────────────────────────────────────

    async def start_device_polling(self) -> None:
        """背景任務：每 5 秒掃描一次 USB 裝置，更新內部裝置清單。

        Mock mode 下不掃描 USB，直接維持假裝置。
        """
        if self.mock_mode:
            logger.info("[mock] start_device_polling：維持假裝置，不掃描 USB。")
            # mock mode 不需要輪詢，直接 idle
            while True:
                await asyncio.sleep(5)

        while True:
            try:
                connected = await self._scan_usb_devices()
                self._update_device_registry(connected)
            except Exception as exc:  # noqa: BLE001
                logger.warning("裝置掃描失敗: %s", exc)
            await asyncio.sleep(5)

    # ── 內部方法 ──────────────────────────────────────────────────────────────

    def _update_device_registry(self, connected: list[DeviceInfo]) -> None:
        """比對新舊裝置清單，觸發連線/斷線事件。

        Args:
            connected: 最新掃描到的裝置清單。
        """
        # USB 掃描偶發空陣列時，避免把仍可用的裝置全部誤判為斷線。
        if not connected:
            logger.warning("USB 掃描結果為空，略過本輪 registry 更新以避免誤判斷線。")
            return

        connected_ids = {d.id for d in connected}
        existing_ids = set(self._registry.keys())

        # 新增裝置
        for device in connected:
            if device.id not in existing_ids:
                self._registry[device.id] = device
                logger.info("裝置連線: %s (%s)", device.id, device.name)
                if self.on_device_connected is not None:
                    asyncio.ensure_future(self.on_device_connected(device))
            else:
                self._update_device_metadata(device.id, name=device.name, model=device.model)

        # 消失裝置
        for device_id in existing_ids - connected_ids:
            device = self._registry.pop(device_id)
            device = DeviceInfo(
                id=device.id,
                name=device.name,
                is_connected=False,
                model=device.model,
            )
            logger.info("裝置斷線: %s (%s)", device.id, device.name)
            if self.on_device_disconnected is not None:
                asyncio.ensure_future(self.on_device_disconnected(device))

    async def _scan_usb_devices(self) -> list[DeviceInfo]:
        """呼叫 pymobiledevice3 CLI 掃描 USB 裝置，回傳裝置清單。"""
        import json
        try:
            proc = await asyncio.create_subprocess_exec(
                *pmd3_cmd("usbmux", "list", "--usb"),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await proc.communicate()
            raw = stdout.decode().strip()
            # 去掉 urllib3 warning 行，只取 JSON 部分
            lines = raw.splitlines()
            json_start = next((i for i, l in enumerate(lines) if l.strip().startswith("[")), None)
            if json_start is None:
                return []
            data = json.loads("\n".join(lines[json_start:]))
            devices: list[DeviceInfo] = []
            for entry in data:
                if entry.get("ConnectionType") != "USB":
                    continue
                devices.append(DeviceInfo(
                    id=entry["Identifier"],
                    name=entry.get("DeviceName", entry["Identifier"]),
                    is_connected=True,
                    model=entry.get("ProductType"),
                ))
            return devices
        except Exception as exc:  # noqa: BLE001
            logger.warning("USB 掃描失敗: %s", exc)
            return []

    async def _pymobiledevice_set_location(
        self,
        device_id: str,
        coordinate: GPSCoordinate,
    ) -> None:
        """透過快取的 LocationSimulation 連線設定 GPS 位置（iOS 17+）。

        第一次呼叫時建立 RSD 連線並快取；後續呼叫直接複用，不重新連線。
        若連線已失效，自動重建。
        """
        rsd = self._rsd_info.get(device_id)
        if not rsd:
            raise LocationSetError(
                device_id,
                "RSD tunnel not available. 請確認 tunneld 已啟動。",
            )

        # 確保每個裝置有自己的 lock
        if device_id not in self._session_locks:
            self._session_locks[device_id] = asyncio.Lock()

        async with self._session_locks[device_id]:
            session = self._location_sessions.get(device_id)
            if session is None:
                try:
                    session = await self._create_location_session(device_id, rsd)
                    self._location_sessions[device_id] = session
                except LocationSetError as exc:
                    logger.warning(
                        "LocationSimulation 建立失敗，改用 CLI fallback: device=%s error=%s",
                        device_id,
                        exc,
                    )
                    if await self._pymobiledevice_set_location_via_legacy(device_id, coordinate):
                        return
                    await self._pymobiledevice_set_location_via_cli(device_id, coordinate, rsd)
                    return

            try:
                await session.set(coordinate.latitude, coordinate.longitude)
                logger.debug(
                    "set_location OK device=%s lat=%.6f lng=%.6f",
                    device_id, coordinate.latitude, coordinate.longitude,
                )
            except Exception as exc:
                # 連線失效時改走 CLI，避免單點模式完全失效。
                logger.warning("LocationSimulation.set 失敗，改用 CLI fallback: %s", exc)
                await self._close_location_session(device_id)
                if await self._pymobiledevice_set_location_via_legacy(device_id, coordinate):
                    return
                await self._pymobiledevice_set_location_via_cli(device_id, coordinate, rsd)

    async def _create_location_session(
        self,
        device_id: str,
        rsd: tuple[str, int],
    ) -> object:
        """建立並回傳一個已連線的 LocationSimulation 實例，同時快取 context 供關閉用。"""
        from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
        from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
        from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation

        addr, port = rsd
        logger.info("建立 LocationSimulation 連線 device=%s addr=%s port=%d", device_id, addr, port)
        try:
            rsd_service = RemoteServiceDiscoveryService((addr, port))
            await rsd_service.connect()
            dvt = DvtProvider(rsd_service)
            await dvt.__aenter__()
            session = LocationSimulation(dvt)
            await session.__aenter__()
            # 記錄 context 供之後關閉
            self._location_contexts[device_id] = [session, dvt, rsd_service]
            return session
        except Exception as exc:
            raise LocationSetError(device_id, f"無法建立 LocationSimulation 連線: {exc}") from exc

    async def _close_location_session(self, device_id: str) -> None:
        """關閉並清除快取的 LocationSimulation 連線。"""
        self._location_sessions.pop(device_id, None)
        contexts = self._location_contexts.pop(device_id, None)
        if contexts:
            session, dvt, rsd_service = contexts
            for ctx in [session, dvt, rsd_service]:
                try:
                    await ctx.__aexit__(None, None, None)
                except Exception:
                    pass

    async def _pymobiledevice_set_location_via_legacy(
        self,
        device_id: str,
        coordinate: GPSCoordinate,
    ) -> bool:
        """Try the older com.apple.dt.simulatelocation service."""
        try:
            from pymobiledevice3.lockdown import create_using_usbmux
            from pymobiledevice3.services.simulate_location import DtSimulateLocation

            lockdown = await create_using_usbmux(serial=device_id, autopair=True)
            service = DtSimulateLocation(lockdown)
            result = service.set(coordinate.latitude, coordinate.longitude)
            if asyncio.iscoroutine(result):
                await result
            logger.info("Legacy location set OK device=%s", device_id)
            return True
        except Exception as exc:
            logger.info("Legacy location fallback unavailable device=%s error=%s", device_id, exc)
            return False

    async def _pymobiledevice_set_location_via_cli(
        self,
        device_id: str,
        coordinate: GPSCoordinate,
        rsd: tuple[str, int],
    ) -> None:
        """CLI fallback：用 simulate-location 指令設定位置。"""
        addr, port = rsd

        if device_id in self._location_procs:
            old_proc = self._location_procs.pop(device_id)
            try:
                old_proc.terminate()
            except Exception:
                pass

        cmd = pmd3_cmd(
            "developer", "dvt", "simulate-location", "set",
            "--rsd", addr, str(port), "--",
            str(coordinate.latitude), str(coordinate.longitude),
        )
        logger.debug("執行 CLI set_location fallback: %s", " ".join(cmd))
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=1.5)
            except asyncio.TimeoutError:
                self._location_procs[device_id] = proc
                return
            detail = "\n".join(
                text for text in (_decode_process_output(stdout), _decode_process_output(stderr)) if text
            )
            if proc.returncode != 0:
                detail = detail or f"pymobiledevice3 exited with code {proc.returncode}"
                raise LocationSetError(device_id, _developer_mode_hint(detail))
            self._location_procs[device_id] = proc
        except Exception as exc:
            if isinstance(exc, LocationSetError):
                raise
            raise LocationSetError(device_id, str(exc)) from exc

    async def _pymobiledevice_stop_simulation(self, device_id: str) -> None:
        """停止 GPS 模擬，清除快取連線。"""
        # 先嘗試用快取連線送 clear
        session = self._location_sessions.get(device_id)
        if session is not None:
            try:
                await session.clear()
                logger.info("stop_simulation OK device=%s", device_id)
            except Exception as exc:
                logger.warning("LocationSimulation.clear 失敗，改用 CLI fallback: %s", exc)
            finally:
                await self._close_location_session(device_id)
            if device_id not in self._location_procs:
                return

        # fallback：用 CLI（無快取連線時）
        rsd = self._rsd_info.get(device_id)
        if not rsd:
            raise LocationSetError(device_id, "RSD tunnel not available.")
        addr, port = rsd

        if device_id in self._location_procs:
            old_proc = self._location_procs.pop(device_id)
            try:
                old_proc.terminate()
            except Exception:
                pass

        cmd = pmd3_cmd(
            "developer", "dvt", "simulate-location", "clear",
            "--rsd", addr, str(port),
        )
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()
            if proc.returncode != 0:
                detail = "\n".join(
                    text for text in (_decode_process_output(stdout), _decode_process_output(stderr)) if text
                )
                detail = detail or f"pymobiledevice3 exited with code {proc.returncode}"
                raise LocationSetError(device_id, _developer_mode_hint(detail))
            self._location_procs[device_id] = proc
        except Exception as exc:
            if isinstance(exc, LocationSetError):
                raise
            raise LocationSetError(device_id, str(exc)) from exc
