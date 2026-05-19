import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getShifts, setShifts, findPeriodByName, addSchedulingPeriod, updateSchedulingPeriod, getSchedule, setSchedule, getSchedulingPeriods } from '@/lib/db'
import type { ClinicName, Shift } from '@/lib/types'
import { defaultShiftTimes } from '@/lib/types'

async function requireAdmin() {
  const user = await currentUser()
  return (user?.publicMetadata as { role?: string })?.role === 'admin'
}

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(await getShifts())
}

export async function POST(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { blockName, startDate, endDate, activeClinics, shiftTimes } = (await request.json()) as {
    blockName: string
    startDate: string
    endDate: string
    activeClinics: Record<string, ClinicName[]>
    shiftTimes?: Record<string, Record<string, { startTime: string; endTime: string }>>
  }

  // Check for overlapping blocks (excluding this block itself)
  const allPeriods = await getSchedulingPeriods()
  const conflict = allPeriods.find(
    (p) => p.name !== blockName && p.startDate <= endDate && startDate <= p.endDate
  )
  if (conflict) {
    return NextResponse.json(
      { error: `These dates overlap with ${conflict.name} (${conflict.startDate} – ${conflict.endDate})` },
      { status: 409 }
    )
  }

  // Upsert the period record for this block
  let period = await findPeriodByName(blockName)
  if (period) {
    // Clear stale schedule entries for this period before replacing its shifts.
    // Without this, old publishedAssignments linger and block availability submission
    // for the reconfigured block (period ID stays the same, shift IDs may be identical).
    const oldShifts = await getShifts()
    const oldPeriodShiftIds = new Set(oldShifts.filter((s) => s.periodId === period!.id).map((s) => s.id))
    if (oldPeriodShiftIds.size > 0) {
      const schedule = await getSchedule()
      if (schedule) {
        await setSchedule({
          ...schedule,
          assignments: schedule.assignments.filter((a) => !oldPeriodShiftIds.has(a.shiftId)),
          publishedAssignments: schedule.publishedAssignments.filter((a) => !oldPeriodShiftIds.has(a.shiftId)),
        })
      }
    }
    await updateSchedulingPeriod(period.id, { startDate, endDate })
    period = { ...period, startDate, endDate }
  } else {
    period = await addSchedulingPeriod({ name: blockName, startDate, endDate })
  }

  const shifts: Shift[] = []
  const current = new Date(startDate + 'T00:00:00Z')
  const end = new Date(endDate + 'T00:00:00Z')

  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0]
    for (const clinic of activeClinics[dateStr] ?? []) {
      const times = shiftTimes?.[dateStr]?.[clinic] ?? defaultShiftTimes(clinic, dateStr)
      shifts.push({ id: `${dateStr}|${clinic}`, date: dateStr, clinic, periodId: period.id, ...times })
    }
    current.setUTCDate(current.getUTCDate() + 1)
  }

  await setShifts(shifts, period.id)
  return NextResponse.json(shifts)
}

export async function DELETE(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  const url = new URL(request.url)
  const periodId = url.searchParams.get('periodId') ?? undefined
  await setShifts([], periodId)
  return NextResponse.json({ ok: true })
}
