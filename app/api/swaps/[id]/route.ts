import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getSwapRequests, updateSwapRequest, getShifts, getPeriod, updatePeriodPublishedAssignments, updatePeriodDraft } from '@/lib/db'

function shiftStarted(shiftDate: string, startTime?: string | null): boolean {
  const now = new Date()
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const parts = fmt.formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  const nowDate = `${get('year')}-${get('month')}-${get('day')}`
  if (nowDate > shiftDate) return true
  if (nowDate < shiftDate) return false
  if (!startTime) return false
  return `${get('hour')}:${get('minute')}` >= startTime
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { action, swap } = (await request.json()) as { action: 'accept' | 'cancel'; swap?: boolean }

  const swapReqs = await getSwapRequests()
  const swapReq = swapReqs.find((r) => r.id === id)
  if (!swapReq) return NextResponse.json({ error: 'Offer not found' }, { status: 404 })
  if (swapReq.status !== 'pending') {
    return NextResponse.json({ error: 'This offer is no longer pending' }, { status: 409 })
  }

  if (action === 'cancel') {
    const cancelUser = await currentUser()
    const isAdmin = (cancelUser?.publicMetadata as { role?: string })?.role === 'admin'
    if (!isAdmin && swapReq.requestorUserId && swapReq.requestorUserId !== userId) {
      return NextResponse.json({ error: 'You can only withdraw your own offers' }, { status: 403 })
    }
    return NextResponse.json(await updateSwapRequest(id, { status: 'cancelled' }))
  }

  if (action === 'accept') {
    const user = await currentUser()
    const acceptorName = user?.fullName ?? [user?.firstName, user?.lastName].filter(Boolean).join(' ') ?? 'Unknown'

    // Look up the period for the requestor's shift
    const allShifts = await getShifts()
    const requestorShift = allShifts.find((s) => s.id === swapReq.requestorShiftId)
    if (!requestorShift?.periodId) return NextResponse.json({ error: 'Shift not found' }, { status: 404 })

    if (shiftStarted(requestorShift.date, requestorShift.startTime)) {
      return NextResponse.json({ error: 'This shift has already started' }, { status: 409 })
    }

    const period = await getPeriod(requestorShift.periodId)
    if (!period) return NextResponse.json({ error: 'Period not found' }, { status: 404 })

    const published = period.publishedAssignments
    const requestorAssignment = published.find((a) => a.shiftId === swapReq.requestorShiftId)
    if (requestorAssignment?.userId !== swapReq.requestorUserId || !swapReq.requestorUserId) {
      return NextResponse.json({ error: 'The offering resident is no longer assigned to that shift' }, { status: 409 })
    }

    const offerDate = swapReq.requestorShiftId.split('|')[0]
    const acceptorDayConflict = published.some(
      (a) => a.userId === userId && a.shiftId.startsWith(offerDate + '|')
    )
    if (acceptorDayConflict && !swap) {
      return NextResponse.json({ error: 'You are already scheduled on the same day as this shift' }, { status: 409 })
    }

    const transfer = (a: typeof published[number]) => {
      if (a.shiftId === swapReq.requestorShiftId) return { ...a, residentName: acceptorName, userId }
      if (swap && a.userId === userId && a.shiftId.startsWith(offerDate + '|')) {
        return { ...a, residentName: null, userId: null }
      }
      return a
    }

    const newPublished = published.map(transfer)
    await updatePeriodPublishedAssignments(requestorShift.periodId, newPublished)

    // Keep draft in sync
    const newDraft = period.assignments.map(transfer)
    await updatePeriodDraft(requestorShift.periodId, newDraft, period.generatedAt ?? null)

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
