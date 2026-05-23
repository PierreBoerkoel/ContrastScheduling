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
  const subByKey = new Map<string, AvailabilitySubmission>()
  for (const sub of submissions) {
    subByKey.set(sub.userId ?? sub.residentName, sub)
  }

  const totalAssignments: Record<string, number> = {}
  const maxShiftsMap: Record<string, number> = {}
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

  // Compute preference weight for a candidate on a specific shift.
  // Budget-neutral formula: weight(R, K) = 2(K+1-R)/(K+1) for ranked clinics,
  // (K-M+1)/(K+1) for unranked, 1 for no preferences.
  function computeWeight(key: string, shift: Shift, weekend: boolean): number {
    const sub = subByKey.get(key)!
    if (!sub.userId) return 1
    const prefs = prefsByUserId[sub.userId]
    if (!prefs) return 1

    const ranking = weekend ? prefs.weekendRanking : prefs.weekdayRanking
    if (!ranking || ranking.length === 0) return 1

    const todayRunning = runningClinics.get(shift.date) ?? new Set<string>()
    const candidateClinics = availClinics.get(key)?.get(shift.date) ?? new Set<string>()
    const K = candidateClinics.size
    if (K === 0) return 1

    const filteredRanking = ranking.filter((c) => todayRunning.has(c) && candidateClinics.has(c))
    const M = filteredRanking.length

    const rankIndex = filteredRanking.indexOf(shift.clinic)
    if (rankIndex >= 0) {
      const R = rankIndex + 1
      return 2 * (K + 1 - R) / (K + 1)
    }
    return (K - M + 1) / (K + 1)
  }

  // Group shifts by date (dates sorted ascending)
  const shiftsByDate = new Map<string, Shift[]>()
  for (const shift of [...shifts].sort((a, b) => a.date.localeCompare(b.date))) {
    let dayShifts = shiftsByDate.get(shift.date)
    if (!dayShifts) { dayShifts = []; shiftsByDate.set(shift.date, dayShifts) }
    dayShifts.push(shift)
  }

  const assignedOnDate: Record<string, Set<string>> = {}
  const assignments: ShiftAssignment[] = []

  for (const [date, dayShifts] of shiftsByDate) {
    assignedOnDate[date] = new Set()
    const weekend = isWeekend(date)

    // Pre-compute initial eligible candidates per shift (before any day assignments).
    // Used to determine shift processing order within this day.
    const initialEligible = new Map<string, string[]>()
    for (const shift of dayShifts) {
      initialEligible.set(
        shift.id,
        [...subByKey.keys()].filter(
          (key) =>
            availableIds.get(key)!.has(shift.id) &&
            totalAssignments[key] < (maxShiftsMap[key] ?? Infinity)
        )
      )
    }

    // Sort shifts within the day:
    //   Primary:   fewest eligible candidates first (scarcer shifts processed first so
    //              a sole-available candidate is assigned to their preferred clinic, not
    //              whichever clinic happens to be alphabetically first)
    //   Secondary: highest total preference weight first (among same-count ties, prefer
    //              the clinic that candidates want most)
    const orderedDayShifts = [...dayShifts].sort((a, b) => {
      const aElig = initialEligible.get(a.id)!
      const bElig = initialEligible.get(b.id)!
      if (aElig.length !== bElig.length) return aElig.length - bElig.length
      const aW = aElig.reduce((s, k) => s + computeWeight(k, a, weekend), 0)
      const bW = bElig.reduce((s, k) => s + computeWeight(k, b, weekend), 0)
      return bW - aW // higher total weight first within tied candidate counts
    })

    for (const shift of orderedDayShifts) {
      // Re-filter eligible candidates to exclude those already assigned today
      const candidates = (initialEligible.get(shift.id) ?? []).filter(
        (key) => !assignedOnDate[date].has(key)
      )

      if (candidates.length === 0) {
        assignments.push({ shiftId: shift.id, residentName: null, userId: null })
        continue
      }

      const assignedKey = weightedRandom(candidates, (key) =>
        computeWeight(key, shift, weekend)
      )

      const sub = subByKey.get(assignedKey)!
      assignments.push({ shiftId: shift.id, residentName: sub.residentName, userId: sub.userId ?? null })
      totalAssignments[assignedKey]++
      assignedOnDate[date].add(assignedKey)
    }
  }

  return assignments
}
