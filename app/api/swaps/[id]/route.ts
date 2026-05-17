import { NextResponse } from 'next/server'
import { getSwapRequests, updateSwapRequest, getSchedule, setSchedule } from '@/lib/db'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { action, acceptorName, acceptorShiftId } = (await request.json()) as {
    action: 'accept' | 'cancel'
    acceptorName?: string
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
    return NextResponse.json(await updateSwapRequest(id, { status: 'cancelled' }))
  }

  if (action === 'accept') {
    if (!acceptorName?.trim() || !acceptorShiftId) {
      return NextResponse.json({ error: 'Acceptor name and shift are required' }, { status: 400 })
    }

    const schedule = await getSchedule()
    if (!schedule) {
      return NextResponse.json({ error: 'No schedule found' }, { status: 400 })
    }

    const acceptorAssignment = schedule.assignments.find((a) => a.shiftId === acceptorShiftId)
    if (acceptorAssignment?.residentName?.toLowerCase() !== acceptorName.trim().toLowerCase()) {
      return NextResponse.json({ error: 'You are not assigned to that shift' }, { status: 400 })
    }

    const requestorAssignment = schedule.assignments.find(
      (a) => a.shiftId === swapReq.requestorShiftId
    )
    if (requestorAssignment?.residentName?.toLowerCase() !== swapReq.requestorName.toLowerCase()) {
      return NextResponse.json(
        { error: 'The requestor is no longer assigned to that shift' },
        { status: 409 }
      )
    }

    const newAssignments = schedule.assignments.map((a) => {
      if (a.shiftId === swapReq.requestorShiftId) return { ...a, residentName: acceptorName.trim() }
      if (a.shiftId === acceptorShiftId) return { ...a, residentName: swapReq.requestorName }
      return a
    })

    await setSchedule({ ...schedule, assignments: newAssignments })

    return NextResponse.json(
      await updateSwapRequest(id, {
        status: 'accepted',
        acceptorName: acceptorName.trim(),
        acceptorShiftId,
        acceptedAt: new Date().toISOString(),
      })
    )
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
