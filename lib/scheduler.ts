import type { Shift, AvailabilitySubmission, ShiftAssignment } from './types'

export function generateSchedule(
  shifts: Shift[],
  submissions: AvailabilitySubmission[]
): ShiftAssignment[] {
  const sortedShifts = [...shifts].sort((a, b) =>
    a.date === b.date ? a.clinic.localeCompare(b.clinic) : a.date.localeCompare(b.date)
  )

  // Key each submission by userId when available, else residentName.
  // This ensures a user who changed their name between submission and scheduling
  // is still treated as a single person.
  const subByKey = new Map<string, AvailabilitySubmission>()
  for (const sub of submissions) {
    subByKey.set(sub.userId ?? sub.residentName, sub)
  }

  const totalAssignments: Record<string, number> = {}
  const maxShiftsMap: Record<string, number> = {}
  for (const [key, sub] of subByKey) {
    totalAssignments[key] = 0
    if (sub.maxShifts && sub.maxShifts > 0) maxShiftsMap[key] = sub.maxShifts
  }

  // Track who was already assigned on each date (one clinic per resident per day)
  const assignedOnDate: Record<string, Set<string>> = {}

  const assignments: ShiftAssignment[] = []

  for (const shift of sortedShifts) {
    if (!assignedOnDate[shift.date]) assignedOnDate[shift.date] = new Set()

    const candidates = [...subByKey.keys()].filter(
      (key) => {
        const sub = subByKey.get(key)!
        return (
          sub.availableShiftIds.includes(shift.id) &&
          !assignedOnDate[shift.date].has(key) &&
          totalAssignments[key] < (maxShiftsMap[key] ?? Infinity)
        )
      }
    )

    if (candidates.length === 0) {
      assignments.push({ shiftId: shift.id, residentName: null, userId: null })
      continue
    }

    // Greedy: pick candidate with fewest assignments; break ties randomly
    candidates.sort((a, b) => {
      const diff = totalAssignments[a] - totalAssignments[b]
      return diff !== 0 ? diff : Math.random() - 0.5
    })

    const assignedKey = candidates[0]
    const sub = subByKey.get(assignedKey)!
    assignments.push({
      shiftId: shift.id,
      residentName: sub.residentName,
      userId: sub.userId ?? null,
    })
    totalAssignments[assignedKey]++
    assignedOnDate[shift.date].add(assignedKey)
  }

  return assignments
}
