// In-memory store — replace with a database (e.g. Supabase) for production.
// Data is lost on server restart in dev mode.

import type { Shift, AvailabilitySubmission, Schedule, SwapRequest } from './types'

interface Store {
  shifts: Shift[]
  submissions: AvailabilitySubmission[]
  schedule: Schedule | null
  swapRequests: SwapRequest[]
}

const store: Store = {
  shifts: [],
  submissions: [],
  schedule: null,
  swapRequests: [],
}

export function getShifts(): Shift[] {
  return store.shifts
}

export function setShifts(shifts: Shift[]): void {
  store.shifts = shifts
}

export function getSubmissions(): AvailabilitySubmission[] {
  return store.submissions
}

export function upsertSubmission(submission: AvailabilitySubmission): void {
  const idx = store.submissions.findIndex(
    (s) => s.residentName.toLowerCase() === submission.residentName.toLowerCase()
  )
  if (idx >= 0) {
    store.submissions[idx] = submission
  } else {
    store.submissions.push(submission)
  }
}

export function getSchedule(): Schedule | null {
  return store.schedule
}

export function setSchedule(schedule: Schedule): void {
  store.schedule = schedule
}

export function getSwapRequests(): SwapRequest[] {
  return store.swapRequests
}

export function addSwapRequest(req: SwapRequest): void {
  store.swapRequests.push(req)
}

export function updateSwapRequest(id: string, patch: Partial<SwapRequest>): SwapRequest | null {
  const idx = store.swapRequests.findIndex((r) => r.id === id)
  if (idx < 0) return null
  store.swapRequests[idx] = { ...store.swapRequests[idx], ...patch }
  return store.swapRequests[idx]
}
