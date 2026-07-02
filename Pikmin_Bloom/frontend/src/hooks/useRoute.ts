import { useState, useEffect, useCallback, useRef } from 'react'
import { apiClient, createStatusWebSocket } from '../api/client'
import type { GPSCoordinate, RouteStatus, StatusUpdate } from '../types'

const INITIAL_ROUTE_STATUS: RouteStatus = {
  state: 'idle',
  currentPosition: null,
  progress: 0,
}

interface ActiveRouteOptions {
  speed: number
  loop: boolean
}

export function useRoute(
  deviceId: string | null,
  initialPosition?: GPSCoordinate | null,
  onRouteError?: (message: string) => void,
): {
  waypoints: GPSCoordinate[]
  addWaypoint: (coord: GPSCoordinate) => void
  updateWaypoint: (index: number, coord: GPSCoordinate) => void
  replaceWaypoints: (coords: GPSCoordinate[]) => void
  removeWaypoint: (index: number) => void
  clearWaypoints: () => void
  routeStatus: RouteStatus
  startRoute: (speed: number, loop: boolean) => Promise<void>
  pauseRoute: () => Promise<void>
  resumeRoute: () => Promise<void>
  stopRoute: () => Promise<void>
  resetLocation: () => Promise<void>
  syncCurrentPosition: (coord: GPSCoordinate | null, nextState?: RouteStatus['state']) => void
} {
  const [waypoints, setWaypoints] = useState<GPSCoordinate[]>([])
  const [routeStatus, setRouteStatus] = useState<RouteStatus>(INITIAL_ROUTE_STATUS)
  const currentPositionRef = useRef<GPSCoordinate | null>(initialPosition ?? null)
  const lastWsPositionAtRef = useRef(0)
  const activeRouteOptionsRef = useRef<ActiveRouteOptions | null>(null)

  useEffect(() => {
    if (initialPosition && !currentPositionRef.current) {
      currentPositionRef.current = initialPosition
    }
  }, [initialPosition])

  const handleWsMessage = useCallback((update: StatusUpdate) => {
    if (update.type === 'position') {
      const data = update.data as { latitude?: number; longitude?: number; progress?: number }
      if (data.latitude !== undefined && data.longitude !== undefined) {
        lastWsPositionAtRef.current = Date.now()
        const coord: GPSCoordinate = { latitude: data.latitude, longitude: data.longitude }
        currentPositionRef.current = coord
        setRouteStatus((prev) => ({
          ...prev,
          state: 'moving',
          currentPosition: coord,
          progress: data.progress ?? prev.progress,
        }))
      }
      return
    }

    if (update.type === 'status') {
      const data = update.data as Partial<{
        state: RouteStatus['state']
        current_position: GPSCoordinate | null
        progress: number
      }>
      if (
        data.state === undefined &&
        data.current_position === undefined &&
        data.progress === undefined
      ) {
        return
      }

      setRouteStatus((prev) => {
        const next: RouteStatus = {
          state: (data.state as RouteStatus['state']) ?? prev.state,
          currentPosition: data.current_position ?? prev.currentPosition,
          progress: data.progress ?? prev.progress,
        }
        currentPositionRef.current = next.currentPosition
        return next
      })
      return
    }

    if (update.type === 'route_error') {
      const data = update.data as { message?: string }
      if (data.message) {
        onRouteError?.(data.message)
      }
    }
  }, [onRouteError])

  useEffect(() => {
    const ws = createStatusWebSocket(handleWsMessage)
    return () => {
      ws.close()
    }
  }, [handleWsMessage])

  useEffect(() => {
    if (!deviceId) return

    let cancelled = false
    const timer = setInterval(async () => {
      // WS 仍在穩定推送時，不要用輪詢結果覆蓋，避免位置拉扯
      if (
        (routeStatus.state === 'moving' || routeStatus.state === 'paused') &&
        Date.now() - lastWsPositionAtRef.current < 1500
      ) return

      try {
        const status = await apiClient.getStatus()
        if (cancelled) return
        setRouteStatus((prev) => {
          const next: RouteStatus = {
            state: status.state ?? prev.state,
            currentPosition: status.currentPosition ?? prev.currentPosition,
            progress: status.progress ?? prev.progress,
          }
          currentPositionRef.current = next.currentPosition
          return next
        })
      } catch {
        // fallback polling should be silent
      }
    }, routeStatus.state === 'moving' || routeStatus.state === 'paused' ? 500 : 1500)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [deviceId, routeStatus.state])

  const addWaypoint = useCallback((coord: GPSCoordinate) => {
    setWaypoints((prev) => [...prev, coord])
  }, [])

  const updateWaypoint = useCallback((index: number, coord: GPSCoordinate) => {
    setWaypoints((prev) => prev.map((waypoint, i) => (i === index ? coord : waypoint)))
  }, [])

  const replaceWaypoints = useCallback((coords: GPSCoordinate[]) => {
    setWaypoints(coords)
  }, [])

  const removeWaypoint = useCallback((index: number) => {
    setWaypoints((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const clearWaypoints = useCallback(() => {
    setWaypoints([])
  }, [])

  const startRoute = useCallback(
    async (speed: number, loop: boolean) => {
      if (!deviceId) throw new Error('No device selected')
      await apiClient.startRoute({ deviceId, waypoints, speed, loop })
      activeRouteOptionsRef.current = { speed, loop }
      setRouteStatus((prev) => ({ ...prev, state: 'moving', progress: 0 }))
    },
    [deviceId, waypoints],
  )

  const pauseRoute = useCallback(async () => {
    await apiClient.pauseRoute()
    setRouteStatus((prev) => ({ ...prev, state: 'paused' }))
  }, [])

  const resumeRoute = useCallback(
    async () => {
      await apiClient.resumeRoute()
      setRouteStatus((prev) => ({ ...prev, state: 'moving' }))
    },
    [],
  )

  const stopRoute = useCallback(async () => {
    await apiClient.stopRoute()
    activeRouteOptionsRef.current = null
    setRouteStatus((prev) => ({ ...prev, state: 'idle', progress: 0 }))
  }, [])

  const resetLocation = useCallback(async () => {
    if (!deviceId) throw new Error('No device selected')
    await apiClient.resetLocation(deviceId)
    activeRouteOptionsRef.current = null
    setRouteStatus((prev) => ({ ...prev, currentPosition: null, state: 'idle', progress: 0 }))
    currentPositionRef.current = null
  }, [deviceId])

  const syncCurrentPosition = useCallback((coord: GPSCoordinate | null, nextState?: RouteStatus['state']) => {
    setRouteStatus((prev) => ({
      ...prev,
      currentPosition: coord,
      state: nextState ?? prev.state,
      progress: nextState === 'idle' ? 0 : prev.progress,
    }))
    currentPositionRef.current = coord
  }, [])

  return {
    waypoints,
    addWaypoint,
    updateWaypoint,
    replaceWaypoints,
    removeWaypoint,
    clearWaypoints,
    routeStatus,
    startRoute,
    pauseRoute,
    resumeRoute,
    stopRoute,
    resetLocation,
    syncCurrentPosition,
  }
}
