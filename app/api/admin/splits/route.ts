import { NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { getShifts, getAllPublishedAssignments, getShiftSplits, addAcceptedShiftSplit, deleteShiftSplit } from '@/lib/db'

async function requireAdmin() {
  const user = await currentUser()
  return (user?.publicMetadata as { role?: string })?.role === 'admin'
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function isHalfHour(t: string): boolean {
  return /^\d{2}:\d{2}$/.test(t) && parseInt(t.split(':')[1]) % 30 === 0
}

export async function POST(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { shiftId, offeredStart, offeredEnd, acceptorUserId, acceptorName } =
    (await request.json()) as {
      shiftId: string
      offeredStart: string
      offeredEnd: string
      acceptorUserId: string
      acceptorName: string
    }

  if (!shiftId || !offeredStart || !offeredEnd || !acceptorUserId || !acceptorName) {
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
    getShifts(), getAllPublishedAssignments(), getShiftSplits(),
  ])

  const shift = shifts.find((s) => s.id === shiftId)
  if (!shift?.startTime || !shift?.endTime) {
    return NextResponse.json({ error: 'Shift not found or has no time range' }, { status: 404 })
  }

  const assignment = published.find((a) => a.shiftId === shiftId)
  if (!assignment?.userId || !assignment?.residentName) {
    return NextResponse.json({ error: 'Shift is not assigned' }, { status: 400 })
  }

  if (
    timeToMinutes(offeredStart) < timeToMinutes(shift.startTime) ||
    timeToMinutes(offeredEnd) > timeToMinutes(shift.endTime)
  ) {
    return NextResponse.json(
      { error: `Time range must be within shift hours (${shift.startTime}–${shift.endTime})` },
      { status: 400 }
    )
  }

  const accepted = existingSplits.filter((s) => s.shiftId === shiftId && s.status === 'accepted')
  for (const a of accepted) {
    const overlapStart = Math.max(timeToMinutes(offeredStart), timeToMinutes(a.offeredStart))
    const overlapEnd = Math.min(timeToMinutes(offeredEnd), timeToMinutes(a.offeredEnd))
    if (overlapStart < overlapEnd) {
      return NextResponse.json(
        { error: `Overlaps an existing split (${a.offeredStart}–${a.offeredEnd})` },
        { status: 409 }
      )
    }
  }

  const split = await addAcceptedShiftSplit({
    id: crypto.randomUUID(),
    shiftId,
    periodId: shift.periodId,
    offerorName: assignment.residentName,
    offerorUserId: assignment.userId,
    acceptorName,
    acceptorUserId,
    offeredStart,
    offeredEnd,
  })

  return NextResponse.json(split, { status: 201 })
}

export async function DELETE(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  const { splitId } = (await request.json()) as { splitId: string }
  if (!splitId) return NextResponse.json({ error: 'Missing splitId' }, { status: 400 })
  await deleteShiftSplit(splitId)
  return NextResponse.json({ ok: true })
}
