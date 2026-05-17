import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getShifts, getSubmissions, getSchedule, setSchedule } from '@/lib/db'
import { generateSchedule } from '@/lib/scheduler'
import type { Schedule, ShiftAssignment } from '@/lib/types'

async function requireAdmin() {
  const user = await currentUser()
  return (user?.publicMetadata as { role?: string })?.role === 'admin'
}

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(await getSchedule())
}

export async function POST(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

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

export async function PUT(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { shiftId } = (await request.json()) as { shiftId: string }

  const schedule = await getSchedule()
  if (!schedule?.isPublished) {
    return NextResponse.json({ error: 'No published schedule' }, { status: 400 })
  }

  const idx = schedule.assignments.findIndex((a: ShiftAssignment) => a.shiftId === shiftId)
  if (idx < 0) {
    return NextResponse.json({ error: 'Shift not in schedule' }, { status: 404 })
  }
  if (schedule.assignments[idx].residentName !== null) {
    return NextResponse.json({ error: 'Shift is already assigned' }, { status: 409 })
  }

  const user = await currentUser()
  const name = user?.fullName ?? [user?.firstName, user?.lastName].filter(Boolean).join(' ') ?? ''
  if (!name) return NextResponse.json({ error: 'Could not determine your name' }, { status: 400 })

  schedule.assignments[idx] = { shiftId, residentName: name }
  await setSchedule(schedule)
  return NextResponse.json(schedule)
}

export async function PATCH(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

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
