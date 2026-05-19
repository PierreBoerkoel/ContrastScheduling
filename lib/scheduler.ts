import type { Shift, AvailabilitySubmission, ShiftAssignment } from './types'

export function generateSchedule(
  shifts: Shift[],
  submissions: AvailabilitySubmission[]
): ShiftAssignment[] {
  const sortedShifts = [...shifts].sort((a, b) =>
    a.date === b.date ? a.clinic.localeCompare(b.clinic) : a.date.localeCompare(b.date)
  )

  // Track total assignments per resident for equalization
  const totalAssignments: Record<string, number> = {}
  const maxShiftsMap: Record<string, number> = {}
  for (const sub of submissions) {
    totalAssignments[sub.residentName] = 0
    if (sub.maxShifts && sub.maxShifts > 0) maxShiftsMap[sub.residentName] = sub.maxShifts
  }

  // Track who was already assigned on each date (one clinic per resident per day)
  const assignedOnDate: Record<string, Set<string>> = {}

  const assignments: ShiftAssignment[] = []

  for (const shift of sortedShifts) {
    if (!assignedOnDate[shift.date]) {
      assignedOnDate[shift.date] = new Set()
    }

    const candidates = submissions
      .filter(
        (sub) =>
          sub.availableShiftIds.includes(shift.id) &&
          !assignedOnDate[shift.date].has(sub.residentName) &&
          totalAssignments[sub.residentName] < (maxShiftsMap[sub.residentName] ?? Infinity)
      )
      .map((sub) => sub.residentName)

    if (candidates.length === 0) {
      assignments.push({ shiftId: shift.id, residentName: null })
      continue
    }

    // Greedy: pick candidate with fewest assignments; break ties randomly
    candidates.sort((a, b) => {
      const diff = totalAssignments[a] - totalAssignments[b]
      return diff !== 0 ? diff : Math.random() - 0.5
    })

    const assigned = candidates[0]
    assignments.push({ shiftId: shift.id, residentName: assigned })
    totalAssignments[assigned]++
    assignedOnDate[shift.date].add(assigned)
  }

  return assignments
}
