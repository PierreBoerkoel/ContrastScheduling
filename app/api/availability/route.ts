import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getSubmissions, upsertSubmission, getSchedule, getShifts } from '@/lib/db'
import type { AvailabilitySubmission } from '@/lib/types'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(await getSubmissions())
}

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await currentUser()
  const residentName =
    user?.fullName ??
    [user?.firstName, user?.lastName].filter(Boolean).join(' ') ??
    user?.emailAddresses[0]?.emailAddress ??
    'Unknown'

  const { availableShiftIds, periodId, maxShifts } = (await request.json()) as { availableShiftIds: string[]; periodId?: string; maxShifts?: number }

  // Block submission if this period's schedule is already published.
  // Check against the period's current shifts in the DB (not the submitted IDs) so that
  // deleting and recreating a block with the same date/clinic shift IDs doesn't cause
  // false positives from stale publishedAssignments entries.
  if (periodId) {
    const [allShifts, schedule] = await Promise.all([getShifts(), getSchedule()])
    const periodShiftIds = new Set(allShifts.filter((s) => s.periodId === periodId).map((s) => s.id))
    if (schedule && schedule.publishedAssignments.some((a) => periodShiftIds.has(a.shiftId))) {
      return NextResponse.json(
        { error: 'The schedule has been published. Availability can no longer be updated.' },
        { status: 409 }
      )
    }
  }

  const submission: AvailabilitySubmission = {
    id: crypto.randomUUID(),
    residentName,
    submittedAt: new Date().toISOString(),
    availableShiftIds,
    periodId,
    maxShifts: maxShifts && maxShifts > 0 ? maxShifts : undefined,
  }

  await upsertSubmission({ ...submission, userId })
  return NextResponse.json({ ...submission, userId })
}
