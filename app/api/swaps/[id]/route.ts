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
  const { action, swap } = (await request.json()) as {
    action: 'accept' | 'cancel'
    swap?: boolean
  }

  const swapReqs = await getSwapRequests()
  const swapReq = swapReqs.find((r) => r.id === id)
  if (!swapReq) {
    return NextResponse.json({ error: 'Offer not found' }, { status: 404 })
  }
  if (swapReq.status !== 'pending') {
    return NextResponse.json({ error: 'This offer is no longer pending' }, { status: 409 })
  }

  if (action === 'cancel') {
    const requestorUserId = (swapReq as { requestorUserId?: string }).requestorUserId
    const cancelUser = await currentUser()
    const isAdmin = (cancelUser?.publicMetadata as { role?: string })?.role === 'admin'
    if (!isAdmin && requestorUserId && requestorUserId !== userId) {
      return NextResponse.json({ error: 'You can only withdraw your own offers' }, { status: 403 })
    }
    return NextResponse.json(await updateSwapRequest(id, { status: 'cancelled' }))
  }

  if (action === 'accept') {
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

    const requestorAssignment = published.find((a) => a.shiftId === swapReq.requestorShiftId)
    const requestorStillAssigned = requestorAssignment?.userId === swapReq.requestorUserId && !!swapReq.requestorUserId
    if (!requestorStillAssigned) {
      return NextResponse.json(
        { error: 'The offering resident is no longer assigned to that shift' },
        { status: 409 }
      )
    }

    // Check the taker doesn't already have a shift on the same day
    const offerDate = swapReq.requestorShiftId.split('|')[0]
    const acceptorDayConflict = published.some(
      (a) => a.userId === userId && a.shiftId.startsWith(offerDate + '|')
    )
    if (acceptorDayConflict && !swap) {
      return NextResponse.json(
        { error: 'You are already scheduled on the same day as this shift' },
        { status: 409 }
      )
    }

    // Transfer shift: requestor loses it, acceptor gains it.
    // If swap=true, also vacate the acceptor's existing shift on that day.
    const transfer = (a: typeof published[number]) => {
      if (a.shiftId === swapReq.requestorShiftId) return { ...a, residentName: acceptorName, userId }
      if (swap && a.userId === userId && a.shiftId.startsWith(offerDate + '|')) {
        return { ...a, residentName: null, userId: null }
      }
      return a
    }

    await setSchedule({
      ...schedule,
      assignments: schedule.assignments.map(transfer),
      publishedAssignments: published.map(transfer),
    })

    return NextResponse.json(
      await updateSwapRequest(id, {
        status: 'accepted',
        acceptorName,
        acceptorUserId: userId,
        acceptedAt: new Date().toISOString(),
      })
    )
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
