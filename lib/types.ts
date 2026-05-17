export const CLINICS = [
  'BC Cancer Agency',
  'INITIO Medical Imaging',
  'UBC Hospital',
  "BC Women's Hospital",
] as const

export type ClinicName = (typeof CLINICS)[number]

export interface Shift {
  id: string
  date: string // YYYY-MM-DD
  clinic: ClinicName
}

export interface AvailabilitySubmission {
  id: string
  residentName: string
  submittedAt: string
  availableShiftIds: string[]
}

export interface ShiftAssignment {
  shiftId: string
  residentName: string | null
}

export interface Schedule {
  generatedAt: string
  publishedAt: string | null
  isPublished: boolean
  assignments: ShiftAssignment[]
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
