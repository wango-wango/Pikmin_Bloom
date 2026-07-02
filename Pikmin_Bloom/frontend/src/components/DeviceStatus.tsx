import { useEffect } from 'react'
import { useDevice } from '../hooks/useDevice'
import type { DeviceInfo } from '../types'

interface DeviceStatusProps {
  devices?: DeviceInfo[]
  selectedDevice?: DeviceInfo | null
  onSelectDevice?: (id: string) => void
  onDeviceSelect?: (device: DeviceInfo | null) => void
  isLoading?: boolean
  error?: string | null
}

export function DeviceStatus({
  devices,
  selectedDevice,
  onSelectDevice,
  onDeviceSelect,
  isLoading,
  error,
}: DeviceStatusProps) {
  const needsFallback =
    devices === undefined ||
    selectedDevice === undefined ||
    onSelectDevice === undefined ||
    isLoading === undefined ||
    error === undefined

  const deviceState = useDevice(needsFallback)
  const resolvedDevices = devices ?? deviceState.devices
  const resolvedSelectedDevice = selectedDevice ?? deviceState.selectedDevice
  const resolvedSelectDevice = onSelectDevice ?? deviceState.selectDevice
  const resolvedLoading = isLoading ?? deviceState.isLoading
  const resolvedError = error ?? deviceState.error

  useEffect(() => {
    onDeviceSelect?.(resolvedSelectedDevice)
  }, [onDeviceSelect, resolvedSelectedDevice])

  if (resolvedLoading) {
    return <div className="helper-text">載入裝置中...</div>
  }

  if (resolvedError) {
    return <div className="helper-text helper-text--error">錯誤：{resolvedError}</div>
  }

  if (resolvedDevices.length === 0) {
    return null
  }

  return (
    <div className="device-select">
      <label className="field">
        <span>選擇裝置</span>
        <div className="device-select-wrap">
          <span className={`device-led select-led ${resolvedSelectedDevice?.isConnected ? 'is-online' : 'is-offline'}`} />
          <span className="sr-only">{resolvedSelectedDevice?.isConnected ? '已連線' : '未連線'}</span>
          <select
            value={resolvedSelectedDevice?.id ?? ''}
            onChange={(e) => resolvedSelectDevice(e.target.value)}
            className="device-select-input"
          >
            <option value="" disabled>
              請選擇裝置
            </option>
            {resolvedDevices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
                {device.model ? ` (${device.model})` : ''}
              </option>
            ))}
          </select>
        </div>
      </label>

    </div>
  )
}
