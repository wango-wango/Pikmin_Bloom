import { useState, useEffect, useCallback, useRef } from 'react'
import { apiClient } from '../api/client'
import type { DeviceInfo } from '../types'

const POLL_INTERVAL_MS = 5000

export function useDevice(enabled = true): {
  devices: DeviceInfo[]
  selectedDevice: DeviceInfo | null
  selectDevice: (id: string) => void
  isLoading: boolean
  error: string | null
} {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selectedDevice, setSelectedDevice] = useState<DeviceInfo | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchDevices = useCallback(async () => {
    try {
      const data = await apiClient.getDevices()
      setDevices(data)
      setError(null)
      // Auto-select first device if none selected; deselect if disconnected
      setSelectedDevice((prev) => {
        if (prev === null) return data[0] ?? null
        return data.find((d) => d.id === prev.id) ?? null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch devices')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false)
      return
    }

    fetchDevices()
    intervalRef.current = setInterval(fetchDevices, POLL_INTERVAL_MS)
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
      }
    }
  }, [enabled, fetchDevices])

  const selectDevice = useCallback(
    (id: string) => {
      const device = devices.find((d) => d.id === id) ?? null
      setSelectedDevice(device)
    },
    [devices],
  )

  return { devices, selectedDevice, selectDevice, isLoading, error }
}
