import { describe, expect, it } from 'vitest'
import {
  calculateCycleDistanceMeters,
  optimizeFlowerRoute,
  optimizeFlowerRouteDeepSearch,
} from './routeOptimizer'
import type { GPSCoordinate } from '../types'

function coord(latitude: number, longitude: number): GPSCoordinate {
  return { latitude, longitude }
}

describe('optimizeFlowerRoute', () => {
  it('keeps routes with fewer than three points unchanged', () => {
    const points = [coord(25, 121), coord(25.001, 121.001)]

    expect(optimizeFlowerRoute(points)).toEqual(points)
  })

  it('does not mutate the original points array', () => {
    const points = [
      coord(0, 0),
      coord(1, 1),
      coord(0, 1),
      coord(1, 0),
    ]
    const original = [...points]

    optimizeFlowerRoute(points)

    expect(points).toEqual(original)
  })

  it('keeps the original first flower point as the displayed first node', () => {
    const first = coord(0, 0)
    const points = [
      first,
      coord(1, 1),
      coord(0, 1),
      coord(1, 0),
    ]

    const optimized = optimizeFlowerRoute(points)

    expect(optimized[0]).toBe(first)
  })

  it('can improve a simple four-point cycle without mutating the first point', () => {
    const crossing = [
      coord(0, 0),
      coord(1, 1),
      coord(0, 1),
      coord(1, 0),
    ]

    const optimized = optimizeFlowerRoute(crossing)

    expect(calculateCycleDistanceMeters(optimized)).toBeLessThan(calculateCycleDistanceMeters(crossing))
  })
})

describe('optimizeFlowerRouteDeepSearch', () => {
  it('keeps routes with fewer than three points unchanged', () => {
    const points = [coord(25, 121), coord(25.001, 121.001)]

    expect(optimizeFlowerRouteDeepSearch(points)).toEqual(points)
  })

  it('does not mutate the original points array', () => {
    const points = [
      coord(0, 0),
      coord(1, 1),
      coord(0, 1),
      coord(1, 0),
    ]
    const original = [...points]

    optimizeFlowerRouteDeepSearch(points)

    expect(points).toEqual(original)
  })

  it('keeps the original first flower point as the displayed first node', () => {
    const first = coord(0, 0)
    const points = [
      first,
      coord(1, 1),
      coord(0, 1),
      coord(1, 0),
    ]

    const optimized = optimizeFlowerRouteDeepSearch(points)

    expect(optimized[0]).toBe(first)
  })

  it('does not create reversed duplicate route segments in the closed route', () => {
    const points = [
      coord(0, 0),
      coord(0.2, 0.3),
      coord(0.4, 0.1),
      coord(0.6, 0.5),
      coord(0.8, 0.2),
    ]

    const optimized = optimizeFlowerRouteDeepSearch(points)
    const segmentKeys = new Set<string>()

    optimized.forEach((point, index) => {
      const next = optimized[(index + 1) % optimized.length]
      const from = points.indexOf(point)
      const to = points.indexOf(next)
      const key = [from, to].sort((a, b) => a - b).join('-')
      expect(segmentKeys.has(key)).toBe(false)
      segmentKeys.add(key)
    })
  })

  it('searches for a route that is no longer than the fast route', () => {
    const points = [
      coord(41.591824, 2.541382),
      coord(41.592779, 2.542498),
      coord(41.593244, 2.542015),
      coord(41.593982, 2.542466),
      coord(41.594584, 2.542402),
      coord(41.595916, 2.541940),
      coord(41.596237, 2.540621),
      coord(41.597336, 2.542734),
      coord(41.597946, 2.541318),
      coord(41.597529, 2.540213),
      coord(41.598917, 2.541296),
      coord(41.600345, 2.541522),
      coord(41.599165, 2.538861),
      coord(41.601484, 2.541361),
      coord(41.602174, 2.540696),
      coord(41.603971, 2.539043),
      coord(41.604517, 2.539601),
      coord(41.604870, 2.541661),
      coord(41.605158, 2.539515),
      coord(41.604854, 2.538990),
      coord(41.606522, 2.543013),
      coord(41.607581, 2.543592),
      coord(41.606923, 2.540803),
      coord(41.606346, 2.539644),
      coord(41.607990, 2.541093),
      coord(41.608776, 2.538561),
      coord(41.608929, 2.537659),
      coord(41.609522, 2.538067),
      coord(41.609370, 2.539634),
      coord(41.607357, 2.536565),
      coord(41.610373, 2.540224),
      coord(41.610293, 2.541211),
      coord(41.611311, 2.539709),
      coord(41.611985, 2.540106),
      coord(41.612980, 2.539451),
      coord(41.614023, 2.539666),
      coord(41.613589, 2.538539),
      coord(41.613854, 2.537520),
      coord(41.612755, 2.537874),
      coord(41.614929, 2.540921),
      coord(41.616244, 2.540406),
      coord(41.617271, 2.539558),
      coord(41.608720, 2.534494),
      coord(41.610036, 2.534559),
    ]

    const fast = optimizeFlowerRoute(points)
    const deep = optimizeFlowerRouteDeepSearch(points)

    expect(calculateCycleDistanceMeters(deep)).toBeLessThanOrEqual(calculateCycleDistanceMeters(fast))
  })
})
