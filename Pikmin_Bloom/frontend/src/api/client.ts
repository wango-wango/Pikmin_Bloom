import type {
  DeviceInfo,
  SetLocationRequest,
  RouteRequest,
  RouteStatus,
  StatusUpdate,
  SavedRoute,
  PostcardLandmark,
} from '../types'

const BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL) || ''

// 空字串 = 相對路徑，走 Vite proxy；有設定 VITE_API_URL 時用絕對路徑
const WS_BASE_URL = BASE_URL ? BASE_URL.replace(/^http/, 'ws') : `ws://${window.location.host}`

async function request<T>(
  path: string,
  options?: RequestInit & { timeoutMs?: number }
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 15000
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  const { timeoutMs: _timeoutMs, ...fetchOptions } = options ?? {}
  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...fetchOptions,
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('請求逾時，請再試一次')
    }
    throw err
  } finally {
    window.clearTimeout(timeout)
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const detail = typeof body.detail === 'object' && body.detail ? body.detail as { error?: string; code?: string } : null
    throw Object.assign(new Error(body.error ?? detail?.error ?? `HTTP ${res.status}`), {
      status: res.status,
      code: body.code ?? detail?.code,
    })
  }
  // 204 No Content
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// Snake_case → camelCase mapping for DeviceInfo
function mapDevice(d: {
  id: string
  name: string
  is_connected: boolean
  model?: string
  developer_mode_enabled?: boolean | null
}): DeviceInfo {
  return {
    id: d.id,
    name: d.name,
    isConnected: d.is_connected,
    model: d.model,
    developerModeEnabled: d.developer_mode_enabled,
  }
}

// Snake_case → camelCase mapping for RouteStatus
function mapRouteStatus(s: {
  state: string
  current_position: { latitude: number; longitude: number } | null
  progress: number
  device_id?: string | null
}): RouteStatus {
  return {
    state: s.state as RouteStatus['state'],
    currentPosition: s.current_position,
    progress: s.progress,
  }
}

export const apiClient = {
  async getDevices(): Promise<DeviceInfo[]> {
    const data = await request<
      { id: string; name: string; is_connected: boolean; model?: string; developer_mode_enabled?: boolean | null }[]
    >('/api/devices')
    return data.map(mapDevice)
  },

  async revealDeveloperMode(deviceId: string): Promise<void> {
    await request<void>(`/api/devices/${encodeURIComponent(deviceId)}/developer-mode/reveal`, {
      method: 'POST',
      timeoutMs: 22000,
    })
  },

  async setLocation(req: SetLocationRequest): Promise<void> {
    await request<void>('/api/location', {
      method: 'POST',
      timeoutMs: 22000,
      body: JSON.stringify({
        latitude: req.latitude,
        longitude: req.longitude,
        device_id: req.deviceId,
      }),
    })
  },

  async searchLocation(query: string): Promise<{ name: string; latitude: number; longitude: number }[]> {
    return request<{ name: string; latitude: number; longitude: number }[]>(`/api/geolocation/search?q=${encodeURIComponent(query)}`)
  },

  async startRoute(req: RouteRequest): Promise<void> {
    await request<void>('/api/route/start', {
      method: 'POST',
      body: JSON.stringify({
        device_id: req.deviceId,
        waypoints: req.waypoints,
        speed: req.speed,
        loop: req.loop,
      }),
    })
  },

  async pauseRoute(): Promise<void> {
    await request<void>('/api/route/pause', { method: 'POST' })
  },

  async resumeRoute(): Promise<void> {
    await request<void>('/api/route/resume', { method: 'POST' })
  },

  async stopRoute(): Promise<void> {
    await request<void>('/api/route/stop', { method: 'POST' })
  },

  async getStatus(): Promise<RouteStatus> {
    const data = await request<{
      state: string
      current_position: { latitude: number; longitude: number } | null
      progress: number
      device_id?: string | null
    }>('/api/status')
    return mapRouteStatus(data)
  },

  async setRsd(deviceId: string, address: string, port: number): Promise<void> {
    await request<void>('/api/rsd', {
      method: 'POST',
      body: JSON.stringify({ device_id: deviceId, address, port }),
    })
  },

  async resetLocation(deviceId: string): Promise<void> {
    await request<void>('/api/location/reset', {
      method: 'POST',
      body: JSON.stringify({ device_id: deviceId }),
    })
  },

  async getGeolocation(): Promise<{ latitude: number; longitude: number; city: string }> {
    return request('/api/geolocation')
  },

  async getNearbyPostcards(payload: {
    latitude: number
    longitude: number
    radiusM: number
    limit?: number
  }): Promise<PostcardLandmark[]> {
    const data = await request<{
      id: string
      name: string
      coordinate: { latitude: number; longitude: number }
      image_url: string
      tags: string[]
      distance_m?: number | null
      holder_count: number
    }[]>('/api/postcards/nearby', {
      method: 'POST',
      timeoutMs: 18000,
      body: JSON.stringify({
        latitude: payload.latitude,
        longitude: payload.longitude,
        radius_m: Math.round(payload.radiusM),
        limit: payload.limit ?? 120,
      }),
    })
    return data.map((postcard) => ({
      id: postcard.id,
      name: postcard.name,
      coordinate: postcard.coordinate,
      imageUrl: postcard.image_url,
      tags: postcard.tags,
      distanceM: postcard.distance_m ?? null,
      holderCount: postcard.holder_count,
    }))
  },

  async getPostcardsInBounds(payload: {
    north: number
    south: number
    east: number
    west: number
    limit?: number
  }, source: 'atlas' | 'pikoohiong' = 'atlas'): Promise<PostcardLandmark[]> {
    const data = await request<{
      id: string
      name: string
      coordinate: { latitude: number; longitude: number }
      image_url: string
      tags: string[]
      distance_m?: number | null
      holder_count: number
      source?: string
      postcard_type?: string | null
      city?: string | null
      country?: string | null
      is_ai_detected?: boolean
      uploader_name?: string | null
      created_at?: string | null
    }[]>(source === 'pikoohiong' ? '/api/postcards/pikoohiong/bounds' : '/api/postcards/bounds', {
      method: 'POST',
      timeoutMs: 24000,
      body: JSON.stringify({
        north: payload.north,
        south: payload.south,
        east: payload.east,
        west: payload.west,
        limit: payload.limit ?? 300,
      }),
    })
    return data.map((postcard) => ({
      id: postcard.id,
      name: postcard.name,
      coordinate: postcard.coordinate,
      imageUrl: postcard.image_url,
      tags: postcard.tags,
      distanceM: postcard.distance_m ?? null,
      holderCount: postcard.holder_count,
      source: postcard.source,
      postcardType: postcard.postcard_type ?? null,
      city: postcard.city ?? null,
      country: postcard.country ?? null,
      isAiDetected: postcard.is_ai_detected ?? false,
      uploaderName: postcard.uploader_name ?? null,
      createdAt: postcard.created_at ?? null,
    }))
  },



  async getLandmarks(): Promise<{ id: string; name: string; coordinate: { latitude: number; longitude: number }; landmarkType: 'flower' | 'mushroom' | 'postcard'; region: string }[]> {
    return request('/api/landmarks')
  },

  async createLandmark(payload: {
    name: string
    coordinate: { latitude: number; longitude: number }
    landmarkType: 'flower' | 'mushroom' | 'postcard'
    region: string
  }): Promise<{ id: string; name: string; coordinate: { latitude: number; longitude: number }; landmarkType: 'flower' | 'mushroom' | 'postcard'; region: string }> {
    return request('/api/landmarks', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  async updateLandmark(landmarkId: string, payload: {
    name: string
    coordinate: { latitude: number; longitude: number }
    landmarkType: 'flower' | 'mushroom' | 'postcard'
    region: string
  }): Promise<{ id: string; name: string; coordinate: { latitude: number; longitude: number }; landmarkType: 'flower' | 'mushroom' | 'postcard'; region: string }> {
    return request(`/api/landmarks/${landmarkId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
  },

  async deleteLandmark(landmarkId: string): Promise<void> {
    await request(`/api/landmarks/${landmarkId}`, { method: 'DELETE' })
  },

  async getSavedRoutes(): Promise<SavedRoute[]> {
    return request('/api/saved-routes')
  },

  async createSavedRoute(payload: {
    name: string
    waypoints: { latitude: number; longitude: number }[]
  }): Promise<SavedRoute> {
    return request('/api/saved-routes', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  async updateSavedRoute(routeId: string, payload: {
    name: string
    waypoints: { latitude: number; longitude: number }[]
  }): Promise<SavedRoute> {
    return request(`/api/saved-routes/${routeId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
  },

  async deleteSavedRoute(routeId: string): Promise<void> {
    await request(`/api/saved-routes/${routeId}`, { method: 'DELETE' })
  },

  async getTunnelStatus(): Promise<{
    tunneldAvailable: boolean
    tunnels: { udid: string; address: string; port: number; interface: string }[]
  }> {
    const data = await request<{
      tunneld_available: boolean
      tunnels: { udid: string; address: string; port: number; interface: string }[]
    }>('/api/tunnel/status')
    return {
      tunneldAvailable: data.tunneld_available,
      tunnels: data.tunnels,
    }
  },
}

const MAX_RETRIES = 5
const BASE_DELAY_MS = 1000

export function createStatusWebSocket(
  onMessage: (status: StatusUpdate) => void
): WebSocket {
  let ws: WebSocket
  let retryCount = 0
  let closed = false

  function connect(): WebSocket {
    const socket = new WebSocket(`${WS_BASE_URL}/ws/status`)

    socket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data as string) as StatusUpdate
        onMessage(data)
      } catch {
        // ignore malformed messages
      }
    })

    socket.addEventListener('close', () => {
      if (closed) return
      if (retryCount >= MAX_RETRIES) {
        onMessage({ type: 'status', data: { connected: false, reconnecting: false } })
        return
      }
      const delay = BASE_DELAY_MS * Math.pow(2, retryCount) // 1s, 2s, 4s, 8s, 16s
      retryCount++
      onMessage({ type: 'status', data: { connected: false, reconnecting: true, attempt: retryCount } })
      setTimeout(() => {
        if (!closed) {
          ws = connect()
        }
      }, delay)
    })

    socket.addEventListener('open', () => {
      retryCount = 0
      onMessage({ type: 'status', data: { connected: true, reconnecting: false } })
    })

    socket.addEventListener('error', () => {
      // error is always followed by close; handled there
    })

    return socket
  }

  ws = connect()

  // Proxy object so callers can call ws.close() to stop reconnecting
  return new Proxy({} as WebSocket, {
    get(_target, prop) {
      if (prop === 'close') {
        return () => {
          closed = true
          ws.close()
        }
      }
      const value = (ws as unknown as Record<string | symbol, unknown>)[prop]
      return typeof value === 'function' ? value.bind(ws) : value
    },
  })
}
