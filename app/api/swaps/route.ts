import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getSwapRequests, addSwapRequest, getAllPublishedAssignments, getShifts, updateSwapRequest } from '@/lib/db'
import { shiftStarted } from '@/lib/time'
import { sendSwapOfferNotification } from '@/lib/email'
import type { SwapRequest } from '@/lib/types'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [swaps, allShifts] = await Promise.all([getSwapRequests(), getShifts()])
  const shiftById = Object.fromEntries(allShifts.map((s) => [s.id, s]))

  const expired = swaps.filter((r) => {
    if (r.status !== 'pending') return false
    const shift = shiftById[r.requestorShiftId]
    return !!shift && shiftStarted(shift.date, shift.startTime)
  })

  if (expired.length > 0) {
    await Promise.all(expired.map((r) => updateSwapRequest(r.id, { status: 'cancelled' })))
    return NextResponse.json(swaps.map((r) =>
      expired.find((e) => e.id === r.id) ? { ...r, status: 'cancelled' } : r
    ))
  }

  return NextResponse.json(swaps)
}

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await currentUser()
  const requestorName =
    user?.fullName ??
    [user?.firstName, user?.lastName].filter(Boolean).join(' ') ??
    'Unknown'

  const { requestorShiftId } = (await request.json()) as { requestorShiftId: string }

  const [published, allShifts] = await Promise.all([getAllPublishedAssignments(), getShifts()])
  if (!published.length) {
    return NextResponse.json({ error: 'No published schedule' }, { status: 400 })
  }

  const assignment = published.find((a) => a.shiftId === requestorShiftId)
  if (assignment?.userId !== userId) {
    return NextResponse.json({ error: 'You are not assigned to that shift' }, { status: 400 })
  }

  const existing = (await getSwapRequests()).find(
    (r) => r.requestorShiftId === requestorShiftId && r.status === 'pending'
  )
  if (existing) {
    return NextResponse.json(
      { error: 'A pending swap request already exists for that shift' },
      { status: 409 }
    )
  }

  const shift = allShifts.find((s) => s.id === requestorShiftId)
  const req: SwapRequest = {
    id: crypto.randomUUID(),
    requestedAt: new Date().toISOString(),
    status: 'pending',
    requestorName,
    requestorShiftId,
    acceptorName: null,
    acceptorShiftId: null,
    acceptedAt: null,
  }

  await addSwapRequest({ ...req, requestorUserId: userId, periodId: shift?.periodId })
  if (shift) {
    sendSwapOfferNotification({ requestorUserId: userId, requestorName, date: shift.date, clinic: shift.clinic }).catch(() => {})
  }
  return NextResponse.json(req, { status: 201 })
}
