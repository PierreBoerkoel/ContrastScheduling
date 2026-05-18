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
}

export interface AvailabilitySubmission {
  id: string
  residentName: string
  submittedAt: string
  availableShiftIds: string[]
  periodId?: string
}

export interface ShiftAssignment {
  shiftId: string
  residentName: string | null
}

export interface Schedule {
  generatedAt: string | null
  publishedAt: string | null
  isPublished: boolean
  assignments: ShiftAssignment[]        // current draft (admin preview)
  publishedAssignments: ShiftAssignment[] // accumulated published schedule (user-facing)
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
}
