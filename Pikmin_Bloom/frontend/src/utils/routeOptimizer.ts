import type { GPSCoordinate } from '../types'

const EARTH_RADIUS_METERS = 6371000
const DEEP_SEARCH_SEED = 20260605

function toRadians(value: number): number {
  return (value * Math.PI) / 180
}

export function calculateDistanceMeters(a: GPSCoordinate, b: GPSCoordinate): number {
  const dLat = toRadians(b.latitude - a.latitude)
  const dLng = toRadians(b.longitude - a.longitude)
  const lat1 = toRadians(a.latitude)
  const lat2 = toRadians(b.latitude)
  const h = (
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  )
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h))
}

export function calculateCycleDistanceMeters(points: GPSCoordinate[]): number {
  if (points.length < 2) return 0
  return points.reduce((total, point, index) => {
    const next = points[(index + 1) % points.length]
    return total + calculateDistanceMeters(point, next)
  }, 0)
}

function createSeededRandom(seed: number): () => number {
  let current = seed
  return () => {
    current += 0x6D2B79F5
    let value = current
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function buildDistanceMatrix(points: GPSCoordinate[]): number[][] {
  return points.map((from) => points.map((to) => calculateDistanceMeters(from, to)))
}

function orderCycleDistance(order: number[], distances: number[][]): number {
  return order.reduce((total, from, index) => {
    const to = order[(index + 1) % order.length]
    return total + distances[from][to]
  }, 0)
}

function nearestNeighborOrder(points: GPSCoordinate[], startIndex: number): GPSCoordinate[] {
  const remaining = points.map((point, index) => ({ point, index }))
  const ordered: GPSCoordinate[] = []
  let currentIndex = startIndex

  while (remaining.length > 0) {
    const selectedIndex = remaining.findIndex((item) => item.index === currentIndex)
    const [selected] = remaining.splice(selectedIndex >= 0 ? selectedIndex : 0, 1)
    ordered.push(selected.point)
    if (remaining.length === 0) break

    let nearest = remaining[0]
    let nearestDistance = calculateDistanceMeters(selected.point, nearest.point)
    for (const candidate of remaining.slice(1)) {
      const distance = calculateDistanceMeters(selected.point, candidate.point)
      if (distance < nearestDistance) {
        nearest = candidate
        nearestDistance = distance
      }
    }
    currentIndex = nearest.index
  }

  return ordered
}

function twoOptCycle(points: GPSCoordinate[]): GPSCoordinate[] {
  if (points.length < 4) return [...points]

  let best = [...points]
  let improved = true

  while (improved) {
    improved = false
    for (let i = 1; i < best.length - 2; i += 1) {
      for (let k = i + 1; k < best.length - 1; k += 1) {
        const currentDistance = (
          calculateDistanceMeters(best[i - 1], best[i]) +
          calculateDistanceMeters(best[k], best[k + 1])
        )
        const swappedDistance = (
          calculateDistanceMeters(best[i - 1], best[k]) +
          calculateDistanceMeters(best[i], best[k + 1])
        )
        if (swappedDistance + 0.0001 < currentDistance) {
          best = [
            ...best.slice(0, i),
            ...best.slice(i, k + 1).reverse(),
            ...best.slice(k + 1),
          ]
          improved = true
        }
      }
    }
  }

  return best
}

function rotateToOriginalStart(points: GPSCoordinate[], originalStart: GPSCoordinate): GPSCoordinate[] {
  const startIndex = points.findIndex((point) => point === originalStart)
  if (startIndex <= 0) return points
  return [...points.slice(startIndex), ...points.slice(0, startIndex)]
}

export function optimizeFlowerRoute(points: GPSCoordinate[]): GPSCoordinate[] {
  if (points.length < 3) return [...points]

  let bestRoute = twoOptCycle(nearestNeighborOrder(points, 0))
  let bestDistance = calculateCycleDistanceMeters(bestRoute)

  for (let startIndex = 1; startIndex < points.length; startIndex += 1) {
    const candidate = twoOptCycle(nearestNeighborOrder(points, startIndex))
    const distance = calculateCycleDistanceMeters(candidate)
    if (distance < bestDistance) {
      bestRoute = candidate
      bestDistance = distance
    }
  }

  return rotateToOriginalStart(bestRoute, points[0])
}

function nearestNeighborIndexOrder(distances: number[][], startIndex: number): number[] {
  const remaining = new Set(distances.map((_, index) => index))
  const ordered: number[] = []
  let currentIndex = startIndex

  while (remaining.size > 0) {
    ordered.push(currentIndex)
    remaining.delete(currentIndex)
    if (remaining.size === 0) break

    let nearest = -1
    let nearestDistance = Infinity
    for (const candidate of remaining) {
      const distance = distances[currentIndex][candidate]
      if (distance < nearestDistance) {
        nearest = candidate
        nearestDistance = distance
      }
    }
    currentIndex = nearest
  }

  return ordered
}

function randomizedNearestNeighborIndexOrder(
  distances: number[][],
  startIndex: number,
  random: () => number,
  candidateLimit: number,
): number[] {
  const remaining = new Set(distances.map((_, index) => index))
  const ordered: number[] = []
  let currentIndex = startIndex

  while (remaining.size > 0) {
    ordered.push(currentIndex)
    remaining.delete(currentIndex)
    if (remaining.size === 0) break

    const candidates = [...remaining]
      .map((index) => ({ index, distance: distances[currentIndex][index] }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, Math.min(candidateLimit, remaining.size))

    const weights = candidates.map((candidate, index) => 1 / ((candidate.distance + 1) * (index + 1)))
    const totalWeight = weights.reduce((total, weight) => total + weight, 0)
    let pick = random() * totalWeight
    let selected = candidates[candidates.length - 1].index

    for (let index = 0; index < candidates.length; index += 1) {
      pick -= weights[index]
      if (pick <= 0) {
        selected = candidates[index].index
        break
      }
    }
    currentIndex = selected
  }

  return ordered
}

function twoOptIndexCycle(order: number[], distances: number[][]): number[] {
  if (order.length < 4) return [...order]

  let best = [...order]
  let improved = true

  while (improved) {
    improved = false
    for (let i = 1; i < best.length - 1; i += 1) {
      for (let k = i + 1; k < best.length; k += 1) {
        const beforeI = best[i - 1]
        const atI = best[i]
        const atK = best[k]
        const afterK = best[(k + 1) % best.length]
        const currentDistance = distances[beforeI][atI] + distances[atK][afterK]
        const swappedDistance = distances[beforeI][atK] + distances[atI][afterK]

        if (swappedDistance + 0.0001 < currentDistance) {
          best = [
            ...best.slice(0, i),
            ...best.slice(i, k + 1).reverse(),
            ...best.slice(k + 1),
          ]
          improved = true
        }
      }
    }
  }

  return best
}

function rotateIndexOrderToStart(order: number[], startIndex: number): number[] {
  const index = order.indexOf(startIndex)
  if (index <= 0) return order
  return [...order.slice(index), ...order.slice(0, index)]
}

export function optimizeFlowerRouteDeepSearch(points: GPSCoordinate[]): GPSCoordinate[] {
  if (points.length < 3) return [...points]

  const distances = buildDistanceMatrix(points)
  let bestOrder = twoOptIndexCycle(nearestNeighborIndexOrder(distances, 0), distances)
  let bestDistance = orderCycleDistance(bestOrder, distances)

  for (let startIndex = 1; startIndex < points.length; startIndex += 1) {
    const candidate = twoOptIndexCycle(nearestNeighborIndexOrder(distances, startIndex), distances)
    const distance = orderCycleDistance(candidate, distances)
    if (distance < bestDistance) {
      bestOrder = candidate
      bestDistance = distance
    }
  }

  for (let seed = 1; seed <= 96; seed += 1) {
    const random = createSeededRandom(DEEP_SEARCH_SEED + seed)
    for (let startIndex = 0; startIndex < points.length; startIndex += 1) {
      const candidate = twoOptIndexCycle(
        randomizedNearestNeighborIndexOrder(distances, startIndex, random, 6),
        distances,
      )
      const distance = orderCycleDistance(candidate, distances)
      if (distance < bestDistance) {
        bestOrder = candidate
        bestDistance = distance
      }
    }
  }

  return rotateIndexOrderToStart(bestOrder, 0).map((index) => points[index])
}
