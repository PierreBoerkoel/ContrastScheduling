import { NextResponse } from 'next/server'
import { getSwapRequests, addSwapRequest, getSchedule } from '@/lib/db'
import type { SwapRequest } from '@/lib/types'

export async function GET() {
  return NextResponse.json(await getSwapRequests())
}

export async function POST(request: Request) {
  const { requestorName, requestorShiftId } = (await request.json()) as {
    requestorName: string
    requestorShiftId: string
  }

  if (!requestorName?.trim()) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  }

  const schedule = await getSchedule()
  if (!schedule?.isPublished) {
    return NextResponse.json({ error: 'No published schedule' }, { status: 400 })
  }

  const assignment = schedule.assignments.find((a) => a.shiftId === requestorShiftId)
  if (assignment?.residentName?.toLowerCase() !== requestorName.trim().toLowerCase()) {
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
    requestorName: requestorName.trim(),
    requestorShiftId,
    acceptorName: null,
    acceptorShiftId: null,
    acceptedAt: null,
  }

  await addSwapRequest(req)
  return NextResponse.json(req, { status: 201 })
}
