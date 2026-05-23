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

  // Budget-neutral preference weight for a candidate on a specific shift.
  // weight(R, K) = 2(K+1-R)/(K+1) for ranked clinics, (K-M+1)/(K+1) for unranked, 1 for no prefs.
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

  const allAssignments = new Map<string, ShiftAssignment>() // shiftId -> assignment

  for (const [date, dayShifts] of shiftsByDate) {
    const weekend = isWeekend(date)

    // Candidates eligible for at least one shift on this day
    const dayEligible = [...subByKey.keys()].filter(
      (key) =>
        dayShifts.some((s) => availableIds.get(key)!.has(s.id)) &&
        totalAssignments[key] < (maxShiftsMap[key] ?? Infinity)
    )

    // Build each candidate's ranked proposal list for this day
    // (shifts they're available for, sorted by preference weight descending)
    const proposalLists = new Map<string, Shift[]>()
    for (const key of dayEligible) {
      const eligible = dayShifts.filter((s) => availableIds.get(key)!.has(s.id))
      proposalLists.set(
        key,
        eligible.sort((a, b) => computeWeight(key, b, weekend) - computeWeight(key, a, weekend))
      )
    }

    // Deferred acceptance (proposal-based matching):
    // Each round, every unmatched candidate with remaining proposals proposes to their next
    // preferred shift. proposalIdx advances when the proposal is made (not on rejection) so
    // a bumped candidate correctly moves to their next preference and never re-proposes to
    // a shift they've already been rejected from. Termination is guaranteed because each
    // candidate's proposalIdx is monotonically non-decreasing and bounded by their list length.
    const proposalIdx = new Map<string, number>()
    for (const key of dayEligible) proposalIdx.set(key, 0)

    const tentativeMatch = new Map<string, string>() // shiftId -> currently matched key
    const isMatched = new Set<string>()              // keys with a tentative match

    let anyProposal = true
    while (anyProposal) {
      anyProposal = false

      // Collect proposals from all unmatched candidates
      const pendingByShift = new Map<string, string[]>() // shiftId -> new proposers
      for (const key of dayEligible) {
        if (isMatched.has(key)) continue
        const idx = proposalIdx.get(key)!
        const list = proposalLists.get(key)!
        if (idx >= list.length) continue

        const shiftId = list[idx].id
        proposalIdx.set(key, idx + 1) // advance before resolution so bumped candidates don't re-propose here
        if (!pendingByShift.has(shiftId)) pendingByShift.set(shiftId, [])
        pendingByShift.get(shiftId)!.push(key)
        anyProposal = true
      }

      // Resolve each shift that received new proposals
      for (const [shiftId, newProposers] of pendingByShift) {
        const shift = dayShifts.find((s) => s.id === shiftId)!
        const currentMatch = tentativeMatch.get(shiftId)

        // All competitors: new proposers + current match (if any)
        const competitors = currentMatch ? [...newProposers, currentMatch] : newProposers

        const winner =
          competitors.length === 1
            ? competitors[0]
            : weightedRandom(competitors, (k) => computeWeight(k, shift, weekend))

        // Unseat the previous match if they lost
        if (currentMatch && currentMatch !== winner) {
          isMatched.delete(currentMatch)
          // currentMatch's proposalIdx already advanced past this shift when they originally
          // proposed, so they will correctly propose to their next preference next round
        }

        tentativeMatch.set(shiftId, winner)
        isMatched.add(winner)
      }
    }

    // Finalise assignments for this day
    for (const shift of dayShifts) {
      const key = tentativeMatch.get(shift.id) ?? null
      if (key) {
        const sub = subByKey.get(key)!
        allAssignments.set(shift.id, { shiftId: shift.id, residentName: sub.residentName, userId: sub.userId ?? null })
        totalAssignments[key]++
      } else {
        allAssignments.set(shift.id, { shiftId: shift.id, residentName: null, userId: null })
      }
    }
  }

  // Return in original shift order
  return shifts.map((s) => allAssignments.get(s.id) ?? { shiftId: s.id, residentName: null, userId: null })
}
