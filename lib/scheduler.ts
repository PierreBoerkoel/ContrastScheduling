import type { Shift, AvailabilitySubmission, ShiftAssignment } from './types'
import type { ResidentPreferences } from './db'

function isWeekend(date: string): boolean {
  return [0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay())
}

function fairRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]
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

  // Clinics running on each date
  const runningClinics = new Map<string, Set<string>>()
  for (const shift of shifts) {
    let s = runningClinics.get(shift.date)
    if (!s) { s = new Set(); runningClinics.set(shift.date, s) }
    s.add(shift.clinic)
  }

  // Build a candidate's ordered proposal list for one day.
  // Ranked clinics (filtered to running + available today) come first in preference order.
  // Unranked available shifts are appended in stable order after.
  function buildProposalList(key: string, dayShifts: Shift[], weekend: boolean): Shift[] {
    const sub = subByKey.get(key)!
    const ids = availableIds.get(key)!
    const eligible = dayShifts.filter((s) => ids.has(s.id))
    if (eligible.length === 0) return []

    const prefs = sub.userId ? prefsByUserId[sub.userId] : undefined
    const rawRanking = prefs ? (weekend ? prefs.weekendRanking : prefs.weekdayRanking) : []
    const todayRunning = runningClinics.get(dayShifts[0].date) ?? new Set<string>()

    // Keep only clinics that are running today and the candidate is available for
    const filteredRanking = (rawRanking ?? []).filter(
      (clinic) => todayRunning.has(clinic) && eligible.some((s) => s.clinic === clinic)
    )

    const ranked: Shift[] = []
    for (const clinic of filteredRanking) {
      const shift = eligible.find((s) => s.clinic === clinic)
      if (shift) ranked.push(shift)
    }

    const rankedClinics = new Set(filteredRanking)
    const unranked = eligible.filter((s) => !rankedClinics.has(s.clinic))

    return [...ranked, ...unranked]
  }

  // Group shifts by date (dates sorted ascending)
  const shiftsByDate = new Map<string, Shift[]>()
  for (const shift of [...shifts].sort((a, b) => a.date.localeCompare(b.date))) {
    let dayShifts = shiftsByDate.get(shift.date)
    if (!dayShifts) { dayShifts = []; shiftsByDate.set(shift.date, dayShifts) }
    dayShifts.push(shift)
  }

  const allAssignments = new Map<string, ShiftAssignment>()

  for (const [date, dayShifts] of shiftsByDate) {
    const weekend = isWeekend(date)

    // Candidates eligible for at least one shift this day and not over their max
    const dayEligible = [...subByKey.keys()].filter(
      (key) =>
        dayShifts.some((s) => availableIds.get(key)!.has(s.id)) &&
        totalAssignments[key] < (maxShiftsMap[key] ?? Infinity)
    )

    const proposalLists = new Map<string, Shift[]>()
    for (const key of dayEligible) {
      proposalLists.set(key, buildProposalList(key, dayShifts, weekend))
    }

    // Deferred acceptance with fair random conflict resolution.
    //
    // Each round every unmatched candidate proposes to their next preferred shift.
    // proposalIdx advances when the proposal is made — a bumped candidate's index
    // is already past the shift they lost, so they never re-propose to it.
    // Conflicts are resolved by fair random draw (no weighting); ranking only
    // determines proposal ORDER, not proposal strength.
    const proposalIdx = new Map<string, number>()
    for (const key of dayEligible) proposalIdx.set(key, 0)

    const tentativeMatch = new Map<string, string>() // shiftId → key
    const isMatched = new Set<string>()

    let anyProposal = true
    while (anyProposal) {
      anyProposal = false

      const pendingByShift = new Map<string, string[]>()
      for (const key of dayEligible) {
        if (isMatched.has(key)) continue
        const idx = proposalIdx.get(key)!
        const list = proposalLists.get(key)!
        if (idx >= list.length) continue

        const shiftId = list[idx].id
        proposalIdx.set(key, idx + 1)
        if (!pendingByShift.has(shiftId)) pendingByShift.set(shiftId, [])
        pendingByShift.get(shiftId)!.push(key)
        anyProposal = true
      }

      for (const [shiftId, newProposers] of pendingByShift) {
        const currentMatch = tentativeMatch.get(shiftId)
        const competitors = currentMatch ? [...newProposers, currentMatch] : newProposers
        const winner = competitors.length === 1 ? competitors[0] : fairRandom(competitors)

        if (currentMatch && currentMatch !== winner) {
          isMatched.delete(currentMatch)
        }

        tentativeMatch.set(shiftId, winner)
        isMatched.add(winner)
      }
    }

    for (const shift of dayShifts) {
      const key = tentativeMatch.get(shift.id) ?? null
      if (key) {
        const sub = subByKey.get(key)!
        allAssignments.set(shift.id, {
          shiftId: shift.id,
          residentName: sub.residentName,
          userId: sub.userId ?? null,
        })
        totalAssignments[key]++
      } else {
        allAssignments.set(shift.id, { shiftId: shift.id, residentName: null, userId: null })
      }
    }
  }

  return shifts.map(
    (s) => allAssignments.get(s.id) ?? { shiftId: s.id, residentName: null, userId: null }
  )
}
