import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getSubmissions, upsertSubmission, getShifts, getSchedulingPeriods } from '@/lib/db'
import type { AvailabilitySubmission } from '@/lib/types'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = await currentUser()
  const isAdmin = (user?.publicMetadata as { role?: string })?.role === 'admin'
  const submissions = await getSubmissions()
  return NextResponse.json(isAdmin ? submissions : submissions.filter((s) => s.userId === userId))
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

  // Block submission if this period is already published
  if (periodId) {
    const periods = await getSchedulingPeriods()
    const period = periods.find((p) => p.id === periodId)
    if (period?.publishedAt) {
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
