import { NextResponse } from 'next/server'
import { getShifts, getSubmissions, getSchedule, setSchedule } from '@/lib/db'
import { generateSchedule } from '@/lib/scheduler'
import type { Schedule, ShiftAssignment } from '@/lib/types'

export async function GET() {
  return NextResponse.json(await getSchedule())
}

export async function POST(request: Request) {
  const { action } = (await request.json()) as { action: 'generate' | 'publish' }

  if (action === 'generate') {
    const [shifts, submissions] = await Promise.all([getShifts(), getSubmissions()])
    const assignments = generateSchedule(shifts, submissions)
    const schedule: Schedule = {
      generatedAt: new Date().toISOString(),
      publishedAt: null,
      isPublished: false,
      assignments,
    }
    await setSchedule(schedule)
    return NextResponse.json(schedule)
  }

  if (action === 'publish') {
    const schedule = await getSchedule()
    if (!schedule) {
      return NextResponse.json({ error: 'No schedule to publish' }, { status: 400 })
    }
    const published: Schedule = {
      ...schedule,
      publishedAt: new Date().toISOString(),
      isPublished: true,
    }
    await setSchedule(published)
    return NextResponse.json(published)
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

export async function PATCH(request: Request) {
  const { shiftId, residentName } = (await request.json()) as {
    shiftId: string
    residentName: string | null
  }

  const schedule = await getSchedule()
  if (!schedule) {
    return NextResponse.json({ error: 'No schedule exists' }, { status: 404 })
  }

  const idx = schedule.assignments.findIndex((a: ShiftAssignment) => a.shiftId === shiftId)
  if (idx < 0) {
    return NextResponse.json({ error: 'Shift not in schedule' }, { status: 404 })
  }

  schedule.assignments[idx] = { shiftId, residentName }
  schedule.isPublished = false
  schedule.publishedAt = null
  await setSchedule(schedule)
  return NextResponse.json(schedule)
}
