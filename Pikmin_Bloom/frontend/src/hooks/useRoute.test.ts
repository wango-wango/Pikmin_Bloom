import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRoute } from './useRoute'
import { apiClient } from '../api/client'

vi.mock('../api/client', () => ({
  apiClient: {
    startRoute: vi.fn(),
    pauseRoute: vi.fn(),
    resumeRoute: vi.fn(),
    stopRoute: vi.fn(),
    resetLocation: vi.fn(),
    getStatus: vi.fn(),
  },
  createStatusWebSocket: vi.fn(() => ({ close: vi.fn() })),
}))

const waypoints = [
  { latitude: 25, longitude: 121.5 },
  { latitude: 25.001, longitude: 121.5 },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(apiClient.getStatus).mockResolvedValue({
    state: 'idle',
    currentPosition: null,
    progress: 0,
  })
})

describe('useRoute', () => {
  it('resumes a paused route without restarting from the beginning', async () => {
    const { result } = renderHook(() => useRoute('device-001'))

    act(() => {
      result.current.replaceWaypoints(waypoints)
    })

    await act(async () => {
      await result.current.startRoute(5, false)
    })

    await act(async () => {
      await result.current.pauseRoute()
    })

    await act(async () => {
      await result.current.resumeRoute()
    })

    expect(apiClient.pauseRoute).toHaveBeenCalledTimes(1)
    expect(apiClient.resumeRoute).toHaveBeenCalledTimes(1)
    expect(apiClient.startRoute).toHaveBeenCalledTimes(1)
    expect(apiClient.stopRoute).not.toHaveBeenCalled()
    expect(result.current.routeStatus.state).toBe('moving')
  })
})
