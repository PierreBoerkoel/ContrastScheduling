import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getSwapRequests, updateSwapRequest, getSchedule, setSchedule } from '@/lib/db'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { action, acceptorShiftId } = (await request.json()) as {
    action: 'accept' | 'cancel'
    acceptorShiftId?: string
  }

  const swapReqs = await getSwapRequests()
  const swapReq = swapReqs.find((r) => r.id === id)
  if (!swapReq) {
    return NextResponse.json({ error: 'Swap request not found' }, { status: 404 })
  }
  if (swapReq.status !== 'pending') {
    return NextResponse.json({ error: 'Swap request is no longer pending' }, { status: 409 })
  }

  if (action === 'cancel') {
    // Only the requestor or an admin can cancel
    const requestorUserId = (swapReq as { requestorUserId?: string }).requestorUserId
    const cancelUser = await currentUser()
    const isAdmin = (cancelUser?.publicMetadata as { role?: string })?.role === 'admin'
    if (!isAdmin && requestorUserId && requestorUserId !== userId) {
      return NextResponse.json({ error: 'You can only cancel your own requests' }, { status: 403 })
    }
    return NextResponse.json(await updateSwapRequest(id, { status: 'cancelled' }))
  }

  if (action === 'accept') {
    if (!acceptorShiftId) {
      return NextResponse.json({ error: 'Acceptor shift is required' }, { status: 400 })
    }

    const user = await currentUser()
    const acceptorName =
      user?.fullName ??
      [user?.firstName, user?.lastName].filter(Boolean).join(' ') ??
      'Unknown'

    const schedule = await getSchedule()
    if (!schedule?.publishedAssignments?.length) {
      return NextResponse.json({ error: 'No schedule found' }, { status: 400 })
    }

    const published = schedule.publishedAssignments

    const acceptorAssignment = published.find((a) => a.shiftId === acceptorShiftId)
    if (acceptorAssignment?.residentName?.toLowerCase() !== acceptorName.toLowerCase()) {
      return NextResponse.json({ error: 'You are not assigned to that shift' }, { status: 400 })
    }

    const requestorAssignment = published.find((a) => a.shiftId === swapReq.requestorShiftId)
    if (requestorAssignment?.residentName?.toLowerCase() !== swapReq.requestorName.toLowerCase()) {
      return NextResponse.json(
        { error: 'The requestor is no longer assigned to that shift' },
        { status: 409 }
      )
    }

    // Same-day conflict checks: after the swap each person must still have at most one shift per day
    const requestorDate = swapReq.requestorShiftId.split('|')[0]
    const acceptorDate = acceptorShiftId.split('|')[0]

    // Acceptor would gain requestorDate — check they don't already have another shift that day
    const acceptorDayConflict = published.some(
      (a) =>
        a.residentName?.toLowerCase() === acceptorName.toLowerCase() &&
        a.shiftId.startsWith(requestorDate + '|') &&
        a.shiftId !== acceptorShiftId // the shift they're giving up doesn't count
    )
    if (acceptorDayConflict) {
      return NextResponse.json(
        { error: 'You are already scheduled on the same day as the shift you would receive' },
        { status: 409 }
      )
    }

    // Requestor would gain acceptorDate — check they don't already have another shift that day
    const requestorDayConflict = published.some(
      (a) =>
        a.residentName?.toLowerCase() === swapReq.requestorName.toLowerCase() &&
        a.shiftId.startsWith(acceptorDate + '|') &&
        a.shiftId !== swapReq.requestorShiftId // the shift they're giving up doesn't count
    )
    if (requestorDayConflict) {
      return NextResponse.json(
        { error: 'The requestor is already scheduled on the same day as the shift they would receive' },
        { status: 409 }
      )
    }

    const swap = (a: typeof published[number]) => {
      if (a.shiftId === swapReq.requestorShiftId) return { ...a, residentName: acceptorName }
      if (a.shiftId === acceptorShiftId) return { ...a, residentName: swapReq.requestorName }
      return a
    }

    await setSchedule({
      ...schedule,
      assignments: schedule.assignments.map(swap),
      publishedAssignments: published.map(swap),
    })

    return NextResponse.json(
      await updateSwapRequest(id, {
        status: 'accepted',
        acceptorName,
        acceptorShiftId,
        acceptedAt: new Date().toISOString(),
      })
    )
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
