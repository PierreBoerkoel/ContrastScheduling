import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getShiftSplits, updateShiftSplit, getShifts, getAllPublishedAssignments } from '@/lib/db'

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return timeToMinutes(aStart) < timeToMinutes(bEnd) && timeToMinutes(bStart) < timeToMinutes(aEnd)
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { action } = (await request.json()) as { action: 'accept' | 'cancel' }

  const splits = await getShiftSplits()
  const split = splits.find((s) => s.id === id)
  if (!split) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (split.status !== 'pending') {
    return NextResponse.json({ error: 'This offer is no longer pending' }, { status: 409 })
  }

  if (action === 'cancel') {
    const user = await currentUser()
    const isAdmin = (user?.publicMetadata as { role?: string })?.role === 'admin'
    const isOfferor = split.offerorUserId === userId
    if (!isAdmin && !isOfferor) {
      return NextResponse.json({ error: 'Only the offeror can withdraw' }, { status: 403 })
    }
    return NextResponse.json(await updateShiftSplit(id, { status: 'cancelled' }))
  }

  if (action === 'accept') {
    const user = await currentUser()
    const acceptorName =
      user?.fullName ??
      [user?.firstName, user?.lastName].filter(Boolean).join(' ') ??
      'Unknown'

    if (split.offerorUserId === userId) {
      return NextResponse.json({ error: 'You cannot accept your own offer' }, { status: 400 })
    }

    // Overlap check: acceptor must not have another shift on the same day that overlaps the offered window
    const splitDate = split.shiftId.split('|')[0]
    const [allShifts, published] = await Promise.all([getShifts(), getAllPublishedAssignments()])
    const shiftById = Object.fromEntries(allShifts.map((s) => [s.id, s]))

    // 1. Check direct published assignments on the same day (skip the shift being split)
    for (const a of published) {
      if (a.userId !== userId) continue
      if (a.shiftId === split.shiftId) continue
      if (a.shiftId.split('|')[0] !== splitDate) continue
      const s = shiftById[a.shiftId]
      if (!s?.startTime || !s?.endTime) continue
      if (overlaps(split.offeredStart, split.offeredEnd, s.startTime, s.endTime)) {
        return NextResponse.json(
          { error: `This portion overlaps with your ${s.clinic} shift (${s.startTime}–${s.endTime})` },
          { status: 409 }
        )
      }
    }

    // 2. Check already-accepted split portions on the same day
    for (const s of splits) {
      if (s.id === split.id) continue
      if (s.status !== 'accepted') continue
      if (s.acceptorUserId !== userId) continue
      if (s.shiftId.split('|')[0] !== splitDate) continue
      if (overlaps(split.offeredStart, split.offeredEnd, s.offeredStart, s.offeredEnd)) {
        return NextResponse.json(
          { error: `This portion overlaps with a split you already accepted (${s.offeredStart}–${s.offeredEnd})` },
          { status: 409 }
        )
      }
    }

    return NextResponse.json(
      await updateShiftSplit(id, {
        status: 'accepted',
        acceptorName,
        acceptorUserId: userId,
        acceptedAt: new Date().toISOString(),
      })
    )
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}
