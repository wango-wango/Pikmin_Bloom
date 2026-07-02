#!/usr/bin/env python3
from __future__ import annotations

import os
import shlex
import subprocess
import urllib.request
import json
import time
import asyncio
from datetime import datetime

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import sys
PMD3_ENV = os.environ.get("PMD3_COMMAND") or os.environ.get("PMD3_PATH")
if PMD3_ENV:
    PMD3 = shlex.split(PMD3_ENV)
else:
    PMD3 = [sys.executable, "-m", "pymobiledevice3"]
DEFAULT_RSD_HOST = os.environ.get("RSD_HOST", "127.0.0.1")
TUNNELD_URL = os.environ.get("TUNNELD_URL", "http://127.0.0.1:49151")
LOG_PATH = os.environ.get("HOST_BRIDGE_LOG_PATH", "/tmp/host_location_bridge.log")

app = FastAPI(title="Host Location Bridge", version="0.1.0")
_device_locks: dict[str, asyncio.Lock] = {}
_location_procs: dict[str, list[subprocess.Popen[str]]] = {}
_location_sessions: dict[str, object] = {}
_location_contexts: dict[str, list[object]] = {}


class SetLocationReq(BaseModel):
    device_id: str
    latitude: float
    longitude: float


class ClearLocationReq(BaseModel):
    device_id: str


class DeviceInfoResp(BaseModel):
    name: str | None = None
    model: str | None = None


class UsbDeviceResp(BaseModel):
    id: str
    name: str
    is_connected: bool = True
    model: str | None = None


@app.get("/health")
def health() -> dict[str, str | bool]:
    return {"ok": True, "service": "pikomin-host-bridge"}


def _run(cmd: list[str], timeout_sec: int = 30) -> None:
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"\n[{datetime.now().isoformat()}] RUN {' '.join(cmd)} timeout={timeout_sec}\n")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec)
    except subprocess.TimeoutExpired as exc:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().isoformat()}] TIMEOUT after {timeout_sec}s\n")
        raise HTTPException(status_code=504, detail=f"[cmd={' '.join(cmd)}] timeout after {timeout_sec}s") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "command failed").strip()
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().isoformat()}] FAIL code={proc.returncode}\nSTDERR:\n{proc.stderr}\nSTDOUT:\n{proc.stdout}\n")
        raise HTTPException(status_code=400, detail=f"[cmd={' '.join(cmd)}] {detail}")
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"[{datetime.now().isoformat()}] OK\n")


def _pmd3_cmd(*args: str) -> list[str]:
    return [*PMD3, *args]


def _spawn_location_process(cmd: list[str]) -> subprocess.Popen[str]:
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"\n[{datetime.now().isoformat()}] SPAWN {' '.join(cmd)}\n")

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"[cmd={' '.join(cmd)}] spawn failed: {exc}") from exc

    time.sleep(0.8)
    if proc.poll() is not None:
        stdout, stderr = proc.communicate(timeout=1)
        detail = (stderr or stdout or f"process exited with code {proc.returncode}").strip()
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().isoformat()}] EXIT code={proc.returncode}\nSTDERR:\n{stderr}\nSTDOUT:\n{stdout}\n")
        raise HTTPException(status_code=400, detail=f"[cmd={' '.join(cmd)}] {detail}")

    return proc


def _terminate_location_process(device_id: str) -> None:
    procs = _location_procs.pop(device_id, [])
    if not procs:
        return
    for proc in procs:
        _terminate_process(device_id, proc)


def _terminate_process(device_id: str, proc: subprocess.Popen[str]) -> None:
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"[{datetime.now().isoformat()}] TERM pid={proc.pid} device={device_id}\n")

    try:
        proc.terminate()
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)
    except Exception:
        pass


def _resolve_rsd(device_id: str) -> tuple[str, int]:
    try:
        with urllib.request.urlopen(TUNNELD_URL, timeout=3) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"讀取 tunneld 失敗: {exc}") from exc

    details = payload.get(device_id) or []
    if not details:
        raise HTTPException(status_code=404, detail=f"找不到裝置 tunnel: {device_id}")

    info = details[0]
    address = info.get("tunnel-address")
    port = info.get("tunnel-port")
    if not address or not port:
        raise HTTPException(status_code=500, detail=f"tunnel 資訊不完整: {device_id}")
    return str(address), int(port)


def _get_device_lock(device_id: str) -> asyncio.Lock:
    lock = _device_locks.get(device_id)
    if lock is None:
        lock = asyncio.Lock()
        _device_locks[device_id] = lock
    return lock


@app.post("/set-location")
async def set_location(req: SetLocationReq) -> dict:
    address, port = _resolve_rsd(req.device_id)
    lock = _get_device_lock(req.device_id)
    async with lock:
        try:
            session = await _get_location_session(req.device_id, address, port)
            await session.set(req.latitude, req.longitude)
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(f"[{datetime.now().isoformat()}] LocationSimulation.set OK device={req.device_id} lat={req.latitude:.6f} lng={req.longitude:.6f}\n")
        except HTTPException:
            raise
        except Exception as exc:
            await _close_location_session(req.device_id)
            raise HTTPException(status_code=400, detail=f"LocationSimulation.set failed: {exc}") from exc
    return {"success": True}


async def _get_location_session(device_id: str, address: str, port: int):
    session = _location_sessions.get(device_id)
    if session is not None:
        return session

    try:
        from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
        from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
        from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation

        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().isoformat()}] CREATE LocationSimulation device={device_id} addr={address} port={port}\n")
        rsd_service = RemoteServiceDiscoveryService((address, port))
        await rsd_service.connect()
        dvt = DvtProvider(rsd_service)
        await dvt.__aenter__()
        session = LocationSimulation(dvt)
        await session.__aenter__()
        _location_contexts[device_id] = [session, dvt, rsd_service]
        _location_sessions[device_id] = session
        return session
    except Exception as exc:
        await _close_location_session(device_id)
        raise HTTPException(status_code=400, detail=f"LocationSimulation session failed: {exc}") from exc


async def _close_location_session(device_id: str) -> None:
    _location_sessions.pop(device_id, None)
    contexts = _location_contexts.pop(device_id, None)
    if not contexts:
        return
    for ctx in contexts:
        try:
            await ctx.__aexit__(None, None, None)
        except Exception:
            pass


@app.get("/usb-devices", response_model=list[UsbDeviceResp])
def list_usb_devices() -> list[UsbDeviceResp]:
    cmd = _pmd3_cmd("usbmux", "list", "--usb")
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"\n[{datetime.now().isoformat()}] RUN {' '.join(cmd)} timeout=8\n")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
    except subprocess.TimeoutExpired as exc:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().isoformat()}] TIMEOUT after 8s\n")
        raise HTTPException(status_code=504, detail="usb device lookup timeout") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "command failed").strip()
        raise HTTPException(status_code=400, detail=detail)

    data = json.loads(proc.stdout or "[]")
    devices: list[UsbDeviceResp] = []
    for entry in data:
        if entry.get("ConnectionType") != "USB":
            continue
        device_id = entry.get("Identifier") or entry.get("UniqueDeviceID")
        if not device_id:
            continue
        devices.append(UsbDeviceResp(
            id=device_id,
            name=entry.get("DeviceName") or device_id,
            model=entry.get("ProductType"),
        ))
    return devices


@app.get("/device-info/{device_id}", response_model=DeviceInfoResp)
def get_device_info(device_id: str) -> DeviceInfoResp:
    address, port = _resolve_rsd(device_id)
    cmd = _pmd3_cmd("lockdown", "get", "--rsd", address, str(port))
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"\n[{datetime.now().isoformat()}] RUN {' '.join(cmd)} timeout=8\n")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
    except subprocess.TimeoutExpired as exc:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().isoformat()}] TIMEOUT after 8s\n")
        raise HTTPException(status_code=504, detail="device info lookup timeout") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "command failed").strip()
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().isoformat()}] FAIL code={proc.returncode}\n{detail}\n")
        raise HTTPException(status_code=400, detail=detail)

    payload = json.loads(proc.stdout)
    return DeviceInfoResp(
        name=payload.get("DeviceName"),
        model=payload.get("ProductType"),
    )


@app.post("/clear-location")
async def clear_location(req: ClearLocationReq) -> dict:
    address, port = _resolve_rsd(req.device_id)
    cmd = _pmd3_cmd("developer", "dvt", "simulate-location", "clear", "--rsd", address, str(port))
    lock = _get_device_lock(req.device_id)
    async with lock:
        _terminate_location_process(req.device_id)
        session = _location_sessions.get(req.device_id)
        if session is not None:
            try:
                await session.clear()
            finally:
                await _close_location_session(req.device_id)
        _run(cmd, timeout_sec=20)
    return {"success": True}
