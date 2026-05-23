import type { Shift, AvailabilitySubmission, ShiftAssignment } from './types'
import type { ResidentPreferences } from './db'

function isWeekend(date: string): boolean {
  return [0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay())
}

function weightedRandom(keys: string[], weight: (k: string) => number): string {
  const total = keys.reduce((sum, k) => sum + weight(k), 0)
  let r = Math.random() * total
  for (const k of keys) {
    r -= weight(k)
    if (r <= 0) return k
  }
  return keys[keys.length - 1]
}

export function generateSchedule(
  shifts: Shift[],
  submissions: AvailabilitySubmission[],
  prefsByUserId: Record<string, ResidentPreferences> = {}
): ShiftAssignment[] {
  const sortedShifts = [...shifts].sort((a, b) =>
    a.date === b.date ? a.clinic.localeCompare(b.clinic) : a.date.localeCompare(b.date)
  )

  const subByKey = new Map<string, AvailabilitySubmission>()
  for (const sub of submissions) {
    subByKey.set(sub.userId ?? sub.residentName, sub)
  }

  const totalAssignments: Record<string, number> = {}
  const maxShiftsMap: Record<string, number> = {}
  // Set of available shift IDs per key for O(1) lookup
  const availableIds = new Map<string, Set<string>>()
  for (const [key, sub] of subByKey) {
    totalAssignments[key] = 0
    if (sub.maxShifts && sub.maxShifts > 0) maxShiftsMap[key] = sub.maxShifts
    availableIds.set(key, new Set(sub.availableShiftIds))
  }

  // Pre-compute: for each (key, date) → set of clinics the candidate is available at
  const availClinics = new Map<string, Map<string, Set<string>>>()
  for (const [key] of subByKey) {
    const byDate = new Map<string, Set<string>>()
    availClinics.set(key, byDate)
    const ids = availableIds.get(key)!
    for (const shift of shifts) {
      if (!ids.has(shift.id)) continue
      let clinics = byDate.get(shift.date)
      if (!clinics) { clinics = new Set(); byDate.set(shift.date, clinics) }
      clinics.add(shift.clinic)
    }
  }

  // Clinics running on each date
  const runningClinics = new Map<string, Set<string>>()
  for (const shift of shifts) {
    let s = runningClinics.get(shift.date)
    if (!s) { s = new Set(); runningClinics.set(shift.date, s) }
    s.add(shift.clinic)
  }

  const assignedOnDate: Record<string, Set<string>> = {}
  const assignments: ShiftAssignment[] = []

  for (const shift of sortedShifts) {
    if (!assignedOnDate[shift.date]) assignedOnDate[shift.date] = new Set()

    const candidates = [...subByKey.keys()].filter((key) =>
      availableIds.get(key)!.has(shift.id) &&
      !assignedOnDate[shift.date].has(key) &&
      totalAssignments[key] < (maxShiftsMap[key] ?? Infinity)
    )

    if (candidates.length === 0) {
      assignments.push({ shiftId: shift.id, residentName: null, userId: null })
      continue
    }

    const weekend = isWeekend(shift.date)
    const todayRunning = runningClinics.get(shift.date) ?? new Set<string>()

    const assignedKey = weightedRandom(candidates, (key) => {
      const sub = subByKey.get(key)!
      if (!sub.userId) return 1
      const prefs = prefsByUserId[sub.userId]
      if (!prefs) return 1

      const ranking = weekend ? prefs.weekendRanking : prefs.weekdayRanking
      if (!ranking || ranking.length === 0) return 1

      // Clinics running today that the candidate is available at
      const candidateClinics = availClinics.get(key)?.get(shift.date) ?? new Set<string>()
      const K = candidateClinics.size
      if (K === 0) return 1

      // Filter ranking to clinics both running today and available to this candidate
      const filteredRanking = ranking.filter((c) => todayRunning.has(c) && candidateClinics.has(c))
      const M = filteredRanking.length

      const rankIndex = filteredRanking.indexOf(shift.clinic)
      if (rankIndex >= 0) {
        // Budget-neutral formula: weight(R, K) = 2(K+1-R)/(K+1)
        const R = rankIndex + 1
        return 2 * (K + 1 - R) / (K + 1)
      }
      // Unranked clinic
      return (K - M + 1) / (K + 1)
    })

    const sub = subByKey.get(assignedKey)!
    assignments.push({ shiftId: shift.id, residentName: sub.residentName, userId: sub.userId ?? null })
    totalAssignments[assignedKey]++
    assignedOnDate[shift.date].add(assignedKey)
  }

  return assignments
}
