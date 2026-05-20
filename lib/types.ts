export const CLINICS = [
  'BC Cancer Agency CT',
  'BC Cancer Agency MRI/PET',
  'INITIO Medical Imaging',
  'UBC Hospital',
  "BC Women's Hospital",
] as const

export const CLINIC_ABBR: Record<string, string> = {
  'BC Cancer Agency CT': 'BCCA CT',
  'BC Cancer Agency MRI/PET': 'BCCA MRI/PET',
  'INITIO Medical Imaging': 'INITIO',
  'UBC Hospital': 'UBC',
  "BC Women's Hospital": 'BCWH',
}

export type ClinicName = (typeof CLINICS)[number]

export interface Shift {
  id: string
  date: string // YYYY-MM-DD
  clinic: ClinicName
  periodId?: string
  startTime?: string // HH:MM 24h
  endTime?: string   // HH:MM 24h
}

export function formatTimeRange(startTime?: string, endTime?: string): string {
  if (!startTime || !endTime) return ''
  const fmt = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    const ampm = h < 12 ? 'AM' : 'PM'
    const hour = h % 12 || 12
    return m === 0 ? `${hour} ${ampm}` : `${hour}:${m.toString().padStart(2, '0')} ${ampm}`
  }
  return `${fmt(startTime)} – ${fmt(endTime)}`
}

export function defaultShiftTimes(
  clinic: ClinicName,
  date: string
): { startTime: string; endTime: string } | undefined {
  const day = new Date(date + 'T00:00:00Z').getUTCDay() // 0=Sun, 6=Sat
  const isWeekday = day >= 1 && day <= 5
  const isWeekend = day === 0 || day === 6
  const isSat = day === 6
  switch (clinic) {
    case 'BC Cancer Agency CT':
      if (isWeekday) return { startTime: '17:00', endTime: '19:00' }
      if (isWeekend) return { startTime: '08:00', endTime: '16:00' }
      return undefined
    case 'BC Cancer Agency MRI/PET':
      if (isWeekday) return { startTime: '17:00', endTime: '22:00' }
      if (isWeekend) return { startTime: '08:00', endTime: '21:00' }
      return undefined
    case 'INITIO Medical Imaging':
      if (isWeekday) return { startTime: '17:30', endTime: '21:30' }
      if (isWeekend) return { startTime: '08:00', endTime: '16:00' }
      return undefined
    case 'UBC Hospital':
      if (isWeekday) return { startTime: '17:30', endTime: '22:30' }
      return undefined
    case "BC Women's Hospital":
      if (isWeekday) return { startTime: '17:30', endTime: '21:30' }
      return undefined
    default:
      return undefined
  }
}

export interface ClinicDefault {
  clinic: string
  activeDays: number[]       // 0=Sun, 1=Mon, ..., 6=Sat
  weekdayStart: string | null
  weekdayEnd: string | null
  weekendStart: string | null
  weekendEnd: string | null
}

export function clinicDefaultShiftTimes(
  clinic: string,
  dateStr: string,
  defaults: ClinicDefault[],
): { startTime: string; endTime: string } | undefined {
  const d = defaults.find((x) => x.clinic === clinic)
  if (!d) return undefined
  const day = new Date(dateStr + 'T00:00:00Z').getUTCDay()
  const isWeekend = day === 0 || day === 6
  if (isWeekend) {
    if (d.weekendStart && d.weekendEnd) return { startTime: d.weekendStart, endTime: d.weekendEnd }
    return undefined
  }
  if (d.weekdayStart && d.weekdayEnd) return { startTime: d.weekdayStart, endTime: d.weekdayEnd }
  return undefined
}

export function clinicDefaultActiveClinics(dateStr: string, defaults: ClinicDefault[]): Set<ClinicName> {
  const day = new Date(dateStr + 'T00:00:00Z').getUTCDay()
  const active = new Set<ClinicName>()
  for (const d of defaults) {
    if (d.activeDays.includes(day)) active.add(d.clinic as ClinicName)
  }
  return active
}

export interface AvailabilitySubmission {
  id: string
  residentName: string
  submittedAt: string
  availableShiftIds: string[]
  periodId?: string
  maxShifts?: number
}

export interface ShiftAssignment {
  shiftId: string
  residentName: string | null
  date?: string       // present on history records fetched from shift_history table
  clinic?: string     // present on history records fetched from shift_history table
  startTime?: string  // present on history records fetched from shift_history table
  endTime?: string    // present on history records fetched from shift_history table
}

export interface Schedule {
  generatedAt: string | null
  publishedAt: string | null
  updatedAt: string | null
  isPublished: boolean
  assignments: ShiftAssignment[]        // current draft (admin preview)
  publishedAssignments: ShiftAssignment[] // accumulated published schedule (user-facing)
}

export interface ShiftSplit {
  id: string
  shiftId: string
  offerorName: string
  offeredStart: string   // HH:MM 24h
  offeredEnd: string     // HH:MM 24h
  status: 'pending' | 'accepted' | 'cancelled'
  acceptorName: string | null
  offeredAt: string      // ISO timestamp
  acceptedAt: string | null
}

export interface ShiftCoverageSegment {
  residentName: string
  start: string   // HH:MM
  end: string     // HH:MM
}

// Recursively resolves who covers which time window for a shift.
// Handles N-way chains: acceptors who sub-offer their window are expanded in-place.
export function computeCoverageSegments(
  shift: { startTime?: string; endTime?: string },
  assignedResident: string | null,
  allSplits: ShiftSplit[]
): ShiftCoverageSegment[] {
  if (!assignedResident) return []
  if (!shift.startTime || !shift.endTime) {
    return [{ residentName: assignedResident, start: '', end: '' }]
  }
  const accepted = allSplits.filter((s) => s.status === 'accepted')

  function segments(owner: string, ownedStart: string, ownedEnd: string): ShiftCoverageSegment[] {
    const given = accepted
      .filter(
        (s) =>
          s.offerorName.toLowerCase() === owner.toLowerCase() &&
          s.offeredStart >= ownedStart &&
          s.offeredEnd <= ownedEnd
      )
      .sort((a, b) => a.offeredStart.localeCompare(b.offeredStart))

    if (given.length === 0) return [{ residentName: owner, start: ownedStart, end: ownedEnd }]

    const result: ShiftCoverageSegment[] = []
    let pos = ownedStart
    for (const g of given) {
      if (pos < g.offeredStart) result.push({ residentName: owner, start: pos, end: g.offeredStart })
      result.push(...segments(g.acceptorName!, g.offeredStart, g.offeredEnd))
      pos = g.offeredEnd
    }
    if (pos < ownedEnd) result.push({ residentName: owner, start: pos, end: ownedEnd })
    return result
  }

  const raw = segments(assignedResident, shift.startTime, shift.endTime)

  const merged: ShiftCoverageSegment[] = []
  for (const seg of raw) {
    const prev = merged[merged.length - 1]
    if (prev && prev.residentName.toLowerCase() === seg.residentName.toLowerCase() && prev.end === seg.start) {
      prev.end = seg.end
    } else {
      merged.push({ ...seg })
    }
  }
  return merged
}

export function buildDisplayNames(fullNames: string[]): Record<string, string> {
  const unique = [...new Set(fullNames.filter(Boolean))]

  const parse = (name: string) => {
    const parts = name.trim().split(/\s+/)
    const first = parts[0] ?? name
    const last = parts.length > 1 ? parts[parts.length - 1] : ''
    const lastInitial = last ? `${last[0]}.` : ''
    const firstAndInitial = lastInitial ? `${first} ${lastInitial}` : first
    return { first, last, lastInitial, firstAndInitial }
  }

  const parsed = Object.fromEntries(unique.map((n) => [n, parse(n)]))

  const firstCount = new Map<string, number>()
  for (const { first } of Object.values(parsed)) {
    firstCount.set(first, (firstCount.get(first) ?? 0) + 1)
  }

  const firstInitialCount = new Map<string, number>()
  for (const { firstAndInitial } of Object.values(parsed)) {
    firstInitialCount.set(firstAndInitial, (firstInitialCount.get(firstAndInitial) ?? 0) + 1)
  }

  const result: Record<string, string> = {}
  for (const name of unique) {
    const { first, firstAndInitial } = parsed[name]
    if ((firstCount.get(first) ?? 0) <= 1) {
      result[name] = first
    } else if ((firstInitialCount.get(firstAndInitial) ?? 0) <= 1) {
      result[name] = firstAndInitial
    } else {
      result[name] = name
    }
  }

  return result
}

export interface SwapRequest {
  id: string
  requestedAt: string
  status: 'pending' | 'accepted' | 'cancelled'
  requestorName: string
  requestorShiftId: string
  acceptorName: string | null
  acceptorShiftId: string | null
  acceptedAt: string | null
}

export interface SchedulingPeriod {
  id: string
  name: string
  startDate: string  // YYYY-MM-DD
  endDate: string    // YYYY-MM-DD
  createdAt: string
  publishedAt?: string
}
