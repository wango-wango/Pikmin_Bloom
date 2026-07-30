export interface GPSCoordinate {
  latitude: number
  longitude: number
}

export interface SavedLandmark {
  id: string
  name: string
  coordinate: GPSCoordinate
  landmarkType: 'flower' | 'mushroom' | 'postcard'
  region: string
  tags: string[]
}

export interface PostcardLandmark {
  id: string
  name: string
  coordinate: GPSCoordinate
  imageUrl: string
  tags: string[]
  distanceM?: number | null
  holderCount?: number
  source?: 'atlas' | 'pikoohiong' | string
  postcardType?: string | null
  city?: string | null
  country?: string | null
  isAiDetected?: boolean
  uploaderName?: string | null
  createdAt?: string | null
}

export interface SavedRoute {
  id: string
  name: string
  waypoints: GPSCoordinate[]
  createdAt: string
  updatedAt: string
}

export interface DeviceInfo {
  id: string
  name: string
  isConnected: boolean
  model?: string
  developerModeEnabled?: boolean | null
}

export interface SetLocationRequest {
  latitude: number
  longitude: number
  deviceId: string
}

export interface RouteRequest {
  deviceId: string
  waypoints: GPSCoordinate[]
  speed: number
  loop: boolean
}

export type SimulationState = 'idle' | 'moving' | 'paused'

export interface RouteStatus {
  state: SimulationState
  currentPosition: GPSCoordinate | null
  progress: number // 0.0 ~ 1.0
  waypoints?: GPSCoordinate[]
}

export interface StatusUpdate {
  type: string
  data: Record<string, unknown>
}
