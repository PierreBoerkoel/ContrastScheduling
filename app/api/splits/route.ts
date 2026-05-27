import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getShiftSplits, addShiftSplit, updateShiftSplit, getShifts, getAllPublishedAssignments, getSwapRequests, addSwapRequest } from '@/lib/db'
import { shiftStarted } from '@/lib/time'
import type { SwapRequest } from '@/lib/types'

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function isHalfHour(t: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(t)) return false
  return parseInt(t.split(':')[1]) % 30 === 0
}

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [splits, allShifts] = await Promise.all([getShiftSplits(), getShifts()])
  const shiftById = Object.fromEntries(allShifts.map((s) => [s.id, s]))

  const expired = splits.filter((s) => {
    if (s.status !== 'pending') return false
    const shift = shiftById[s.shiftId]
    return !!shift && shiftStarted(shift.date, shift.startTime)
  })

  if (expired.length > 0) {
    await Promise.all(expired.map((s) => updateShiftSplit(s.id, { status: 'cancelled' })))
    return NextResponse.json(splits.map((s) =>
      expired.find((e) => e.id === s.id) ? { ...s, status: 'cancelled' } : s
    ))
  }

  return NextResponse.json(splits)
}

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await currentUser()
  const offerorName =
    user?.fullName ??
    [user?.firstName, user?.lastName].filter(Boolean).join(' ') ??
    'Unknown'

  const { shiftId, offeredStart, offeredEnd } = (await request.json()) as {
    shiftId: string
    offeredStart: string
    offeredEnd: string
  }

  if (!shiftId || !offeredStart || !offeredEnd) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  if (!isHalfHour(offeredStart) || !isHalfHour(offeredEnd)) {
    return NextResponse.json(
      { error: 'Times must be on 30-minute boundaries (e.g. 08:00, 08:30)' },
      { status: 400 }
    )
  }

  if (timeToMinutes(offeredStart) >= timeToMinutes(offeredEnd)) {
    return NextResponse.json({ error: 'Start time must be before end time' }, { status: 400 })
  }

  const [shifts, published, existingSplits] = await Promise.all([
    getShifts(),
    getAllPublishedAssignments(),
    getShiftSplits(),
  ])

  const shift = shifts.find((s) => s.id === shiftId)
  if (!shift?.startTime || !shift?.endTime) {
    return NextResponse.json({ error: 'Shift not found or has no time range' }, { status: 404 })
  }

  const assignment = published.find((a) => a.shiftId === shiftId)
  const isOriginalAssignee = assignment?.userId === userId

  const accepted = existingSplits.filter(
    (s) => s.shiftId === shiftId && s.status === 'accepted'
  )
  const myAcceptedSplit = accepted.find((s) => s.acceptorUserId === userId)

  if (!isOriginalAssignee && !myAcceptedSplit) {
    return NextResponse.json(
      { error: 'You are not assigned to this shift' },
      { status: 403 }
    )
  }

  const ownedStart = myAcceptedSplit ? myAcceptedSplit.offeredStart : shift.startTime
  const ownedEnd = myAcceptedSplit ? myAcceptedSplit.offeredEnd : shift.endTime

  if (
    timeToMinutes(offeredStart) < timeToMinutes(ownedStart) ||
    timeToMinutes(offeredEnd) > timeToMinutes(ownedEnd)
  ) {
    return NextResponse.json(
      { error: `Offered window must be within your assigned time range (${ownedStart}–${ownedEnd})` },
      { status: 400 }
    )
  }

  // Validate no overlap with portions already given away
  const givenAway = accepted.filter((s) => s.offerorUserId === userId)
  for (const g of givenAway) {
    const overlapStart = Math.max(timeToMinutes(offeredStart), timeToMinutes(g.offeredStart))
    const overlapEnd = Math.min(timeToMinutes(offeredEnd), timeToMinutes(g.offeredEnd))
    if (overlapStart < overlapEnd) {
      return NextResponse.json(
        { error: 'Offered window overlaps with a portion you have already given away' },
        { status: 400 }
      )
    }
  }

  // Full-shift offer: treat as a swap request so publishedAssignments stays accurate
  if (offeredStart === shift.startTime && offeredEnd === shift.endTime) {
    const swapRequests = await getSwapRequests()
    const existingSwap = swapRequests.find(
      (r) => r.requestorShiftId === shiftId && r.status === 'pending'
    )
    if (existingSwap) {
      return NextResponse.json(
        { error: 'A pending offer already exists for this shift' },
        { status: 409 }
      )
    }
    const swapReq: SwapRequest = {
      id: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      status: 'pending',
      requestorName: offerorName,
      requestorShiftId: shiftId,
      acceptorName: null,
      acceptorShiftId: null,
      acceptedAt: null,
    }
    await addSwapRequest({ ...swapReq, requestorUserId: userId, periodId: shift.periodId })
    return NextResponse.json(swapReq, { status: 201 })
  }

  // One pending portion offer per person per shift
  const alreadyPending = existingSplits.find(
    (s) => s.shiftId === shiftId && s.offerorUserId === userId && s.status === 'pending'
  )
  if (alreadyPending) {
    return NextResponse.json(
      { error: 'You already have a pending portion offer for this shift' },
      { status: 409 }
    )
  }

  const newSplit = await addShiftSplit({
    id: crypto.randomUUID(),
    shiftId,
    offerorName,
    offerorUserId: userId,
    offeredStart,
    offeredEnd,
    status: 'pending',
    periodId: shift.periodId,
  })

  return NextResponse.json(newSplit, { status: 201 })
}
