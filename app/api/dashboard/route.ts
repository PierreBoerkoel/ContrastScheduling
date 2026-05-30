import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getShifts, getAllPublishedAssignments, getSchedulingPeriods, getSubmissions, getSwapRequests, getShiftSplits } from '@/lib/db'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [allShifts, published, periods, submissions, swaps, splits] = await Promise.all([
    getShifts(), getAllPublishedAssignments(), getSchedulingPeriods(),
    getSubmissions(), getSwapRequests(), getShiftSplits(),
  ])

  const today = new Date().toISOString().split('T')[0]
  const shiftById = Object.fromEntries(allShifts.map((s) => [s.id, s]))

  const upcomingShifts = published
    .filter((a) => a.userId === userId)
    .map((a) => shiftById[a.shiftId])
    .filter((s): s is NonNullable<typeof s> => !!s && s.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 3)

  const openPeriods = periods
    .filter((p) => !p.publishedAt && p.endDate >= today)
    .map((p) => ({
      id: p.id,
      name: p.name,
      startDate: p.startDate,
      endDate: p.endDate,
      hasSubmitted: submissions.some((s) => s.periodId === p.id && s.userId === userId),
    }))

  const pendingSwaps = swaps.filter((s) => s.status === 'pending' && s.requestorUserId !== userId).length
  const pendingSplits = splits.filter((s) => s.status === 'pending' && s.offerorUserId !== userId).length

  return NextResponse.json({
    upcomingShifts,
    openPeriods,
    pendingCounts: { swaps: pendingSwaps, splits: pendingSplits },
  })
}
