import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import {
  getShiftSplits, updateShiftSplit, getShifts, getAllPublishedAssignments,
  getPeriod, updatePeriodPublishedAssignments, getSwapRequests,
} from '@/lib/db'
import { shiftStarted, overlaps } from '@/lib/time'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { action, swap } = (await request.json()) as { action: 'accept' | 'cancel'; swap?: boolean }

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

    const [allShifts, published, allSwaps] = await Promise.all([
      getShifts(), getAllPublishedAssignments(), getSwapRequests(),
    ])
    const shiftById = Object.fromEntries(allShifts.map((s) => [s.id, s]))

    const offeredShift = shiftById[split.shiftId]
    const splitDate = offeredShift?.date ?? ''
    if (offeredShift && shiftStarted(offeredShift.date, offeredShift.startTime)) {
      return NextResponse.json({ error: 'This shift has already started' }, { status: 409 })
    }

    // 1. Check direct published assignments on the same day (skip the shift being split)
    let conflictAssignment: typeof published[number] | null = null
    for (const a of published) {
      if (a.userId !== userId) continue
      if (a.shiftId === split.shiftId) continue
      if (shiftById[a.shiftId]?.date !== splitDate) continue
      const s = shiftById[a.shiftId]
      if (!s?.startTime || !s?.endTime) continue
      if (overlaps(split.offeredStart, split.offeredEnd, s.startTime, s.endTime)) {
        conflictAssignment = a
        break
      }
    }

    if (conflictAssignment) {
      if (!swap) {
        const s = shiftById[conflictAssignment.shiftId]
        return NextResponse.json(
          { error: `This portion overlaps with your ${s?.clinic} shift (${s?.startTime}–${s?.endTime})` },
          { status: 409 }
        )
      }

      // swap: true — validate the vacate is safe before clearing
      const conflictShiftId = conflictAssignment.shiftId
      if (splits.some((sp) => sp.status === 'accepted' && sp.shiftId === conflictShiftId && sp.offerorUserId === userId)) {
        return NextResponse.json(
          { error: 'You cannot vacate a shift while someone else is covering a portion of it.' },
          { status: 409 }
        )
      }
      if (splits.some((sp) => sp.status === 'pending' && sp.offerorUserId === userId && sp.shiftId === conflictShiftId)) {
        return NextResponse.json(
          { error: 'You have a pending portion offer on your current shift. Cancel it before accepting.' },
          { status: 409 }
        )
      }
      if (allSwaps.some((r) => r.status === 'pending' && r.requestorUserId === userId && r.requestorShiftId === conflictShiftId)) {
        return NextResponse.json(
          { error: 'You have a pending shift offer on your current shift. Cancel it before accepting.' },
          { status: 409 }
        )
      }

      const conflictShift = shiftById[conflictShiftId]
      if (conflictShift?.periodId) {
        const period = await getPeriod(conflictShift.periodId)
        if (period) {
          const newPub = period.publishedAssignments.map((a) =>
            a.shiftId === conflictShiftId ? { shiftId: conflictShiftId, residentName: null, userId: null } : a
          )
          await updatePeriodPublishedAssignments(conflictShift.periodId, newPub)
        }
      }
    }

    // 2. Check already-accepted split portions on the same day (hard block — can't vacate a split acceptance)
    for (const s of splits) {
      if (s.id === split.id) continue
      if (s.status !== 'accepted') continue
      if (s.acceptorUserId !== userId) continue
      if (shiftById[s.shiftId]?.date !== splitDate) continue
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
