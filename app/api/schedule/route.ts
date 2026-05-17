import { NextResponse } from 'next/server'
import { getShifts, getSubmissions, getSchedule, setSchedule } from '@/lib/store'
import { generateSchedule } from '@/lib/scheduler'
import type { Schedule, ShiftAssignment } from '@/lib/types'

export async function GET() {
  return NextResponse.json(getSchedule())
}

export async function POST(request: Request) {
  const { action } = (await request.json()) as { action: 'generate' | 'publish' }

  if (action === 'generate') {
    const assignments = generateSchedule(getShifts(), getSubmissions())
    const schedule: Schedule = {
      generatedAt: new Date().toISOString(),
      publishedAt: null,
      isPublished: false,
      assignments,
    }
    setSchedule(schedule)
    return NextResponse.json(schedule)
  }

  if (action === 'publish') {
    const schedule = getSchedule()
    if (!schedule) {
      return NextResponse.json({ error: 'No schedule to publish' }, { status: 400 })
    }
    const published: Schedule = {
      ...schedule,
      publishedAt: new Date().toISOString(),
      isPublished: true,
    }
    setSchedule(published)
    return NextResponse.json(published)
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

// Update a single assignment (admin manual adjustment)
export async function PATCH(request: Request) {
  const { shiftId, residentName } = (await request.json()) as {
    shiftId: string
    residentName: string | null
  }

  const schedule = getSchedule()
  if (!schedule) {
    return NextResponse.json({ error: 'No schedule exists' }, { status: 404 })
  }

  const idx = schedule.assignments.findIndex((a: ShiftAssignment) => a.shiftId === shiftId)
  if (idx < 0) {
    return NextResponse.json({ error: 'Shift not in schedule' }, { status: 404 })
  }

  schedule.assignments[idx] = { shiftId, residentName }
  // Manual edits revert published state so admin must re-publish
  schedule.isPublished = false
  schedule.publishedAt = null
  setSchedule(schedule)
  return NextResponse.json(schedule)
}
