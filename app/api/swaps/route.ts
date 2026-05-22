import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getSwapRequests, addSwapRequest, getSchedule } from '@/lib/db'
import type { SwapRequest } from '@/lib/types'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(await getSwapRequests())
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

  const schedule = await getSchedule()
  if (!(schedule?.publishedAssignments?.length)) {
    return NextResponse.json({ error: 'No published schedule' }, { status: 400 })
  }

  const assignment = schedule.publishedAssignments.find((a) => a.shiftId === requestorShiftId)
  const isAssigned = assignment?.userId === userId
  if (!isAssigned) {
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

  await addSwapRequest({ ...req, requestorUserId: userId })
  return NextResponse.json(req, { status: 201 })
}
