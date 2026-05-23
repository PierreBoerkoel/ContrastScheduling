import type { Shift, AvailabilitySubmission, ShiftAssignment } from './types'
import type { ResidentPreferences } from './db'

function isWeekend(date: string): boolean {
  return [0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay())
}

function fairRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

// Given a set of remaining unfilled shifts, return the one the resident prefers most.
// Ranked clinics are checked in preference order; unranked → random pick.
function topAvailable(
  remaining: Shift[],
  ranking: string[]
): Shift {
  for (const clinic of ranking) {
    const match = remaining.find((s) => s.clinic === clinic)
    if (match) return match
  }
  return fairRandom(remaining)
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

    // Shifts still needing assignment this day
    const remaining = new Map<string, Shift>(dayShifts.map((s) => [s.id, s]))

    // Pool: residents available for at least one remaining shift, not over their max
    const pool = new Set(
      [...subByKey.keys()].filter(
        (key) =>
          dayShifts.some((s) => availableIds.get(key)!.has(s.id)) &&
          totalAssignments[key] < (maxShiftsMap[key] ?? Infinity)
      )
    )

    while (remaining.size > 0 && pool.size > 0) {
      // Random draw from the pool
      const drawn = fairRandom([...pool])
      pool.delete(drawn)

      // Shifts in `remaining` that this resident submitted availability for
      const ids = availableIds.get(drawn)!
      const available = [...remaining.values()].filter((s) => ids.has(s.id))

      if (available.length === 0) {
        // All their available shifts are already filled — skip
        continue
      }

      // Resolve preference ranking for this day type, filtered to remaining clinics
      const sub = subByKey.get(drawn)!
      const prefs = sub.userId ? prefsByUserId[sub.userId] : undefined
      const rawRanking = prefs ? (weekend ? prefs.weekendRanking : prefs.weekdayRanking) : []
      // Only keep clinics that still have an unfilled shift available to this resident
      const availableClinics = new Set<string>(available.map((s) => s.clinic))
      const ranking = (rawRanking ?? []).filter((c) => availableClinics.has(c))

      const assigned = topAvailable(available, ranking)

      allAssignments.set(assigned.id, {
        shiftId: assigned.id,
        residentName: sub.residentName,
        userId: sub.userId ?? null,
      })
      remaining.delete(assigned.id)
      totalAssignments[drawn]++

      // Drop pool members who no longer have any available remaining shifts
      for (const key of pool) {
        const keyIds = availableIds.get(key)!
        if (![...remaining.keys()].some((id) => keyIds.has(id))) {
          pool.delete(key)
        }
      }
    }

    // Record unfilled shifts
    for (const [id] of remaining) {
      allAssignments.set(id, { shiftId: id, residentName: null, userId: null })
    }
  }

  return shifts.map(
    (s) => allAssignments.get(s.id) ?? { shiftId: s.id, residentName: null, userId: null }
  )
}
