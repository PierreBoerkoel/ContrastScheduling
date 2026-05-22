import { NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { ensureDb, getSchedule, setSchedule, touchScheduleTimestamp, getClinicDefaults } from '@/lib/db'
import { sql } from '@vercel/postgres'
import { clinicDefaultShiftTimes } from '@/lib/types'
import type { ClinicName } from '@/lib/types'

async function requireAdmin() {
  const user = await currentUser()
  return (user?.publicMetadata as { role?: string })?.role === 'admin'
}

export async function POST(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { periodId, date, clinic, startTime, endTime } = await request.json() as {
    periodId: string
    date: string
    clinic: ClinicName
    startTime?: string
    endTime?: string
  }

  if (!periodId || !date || !clinic) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const shiftId = `${date}|${clinic}`
  await ensureDb()

  const { rows: existing } = await sql`SELECT id FROM shifts WHERE id = ${shiftId}`
  if (existing.length > 0) {
    return NextResponse.json({ error: 'A shift for this date and clinic already exists' }, { status: 409 })
  }

  const clinicDefaults = await getClinicDefaults()
  const times = (startTime && endTime)
    ? { startTime, endTime }
    : (clinicDefaultShiftTimes(clinic, date, clinicDefaults) ?? { startTime: undefined, endTime: undefined })

  await sql`
    INSERT INTO shifts (id, date, clinic, period_id, start_time, end_time)
    VALUES (${shiftId}, ${date}, ${clinic}, ${periodId}, ${times.startTime ?? null}, ${times.endTime ?? null})
  `

  const schedule = await getSchedule()
  if (schedule) {
    const nullAssignment = { shiftId, residentName: null, userId: null }
    const inAssignments = schedule.assignments.some((a) => a.shiftId === shiftId)
    const inPublished = schedule.publishedAssignments.some((a) => a.shiftId === shiftId)
    await setSchedule({
      ...schedule,
      assignments: inAssignments ? schedule.assignments : [...schedule.assignments, nullAssignment],
      publishedAssignments: inPublished ? schedule.publishedAssignments : [...schedule.publishedAssignments, nullAssignment],
    })
  }

  return NextResponse.json({ id: shiftId, date, clinic, periodId, ...times }, { status: 201 })
}

export async function PATCH(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { shiftId, startTime, endTime } = await request.json() as {
    shiftId: string
    startTime: string | null
    endTime: string | null
  }

  if (!shiftId) return NextResponse.json({ error: 'Missing shiftId' }, { status: 400 })

  await ensureDb()

  // Fetch original times before overwriting so we can detect expansion vs truncation
  const { rows: shiftRows } = await sql`SELECT start_time, end_time FROM shifts WHERE id = ${shiftId}`
  const origStart = shiftRows[0]?.start_time as string | null
  const origEnd = shiftRows[0]?.end_time as string | null

  await sql`UPDATE shifts SET start_time = ${startTime ?? null}, end_time = ${endTime ?? null} WHERE id = ${shiftId}`

  // Adjust split windows to match the new shift boundaries
  if (startTime || endTime) {
    const { rows: splitRows } = await sql`
      SELECT id, offered_start, offered_end
      FROM shift_splits
      WHERE shift_id = ${shiftId} AND status != 'cancelled'
    `
    const mins = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
    for (const row of splitRows) {
      let newStart: string = row.offered_start
      let newEnd: string = row.offered_end

      if (startTime && origStart) {
        if (mins(startTime) < mins(origStart)) {
          // Shift expanded earlier: extend the split that was anchored at the original start
          if (row.offered_start === origStart) newStart = startTime
        } else {
          // Shift truncated: clamp splits that now start before the new start
          if (mins(row.offered_start) < mins(startTime)) newStart = startTime
        }
      }

      if (endTime && origEnd) {
        if (mins(endTime) > mins(origEnd)) {
          // Shift expanded later: extend the split that was anchored at the original end
          if (row.offered_end === origEnd) newEnd = endTime
        } else {
          // Shift truncated: clamp splits that now end after the new end
          if (mins(row.offered_end) > mins(endTime)) newEnd = endTime
        }
      }

      if (newStart === row.offered_start && newEnd === row.offered_end) continue
      if (mins(newStart) >= mins(newEnd)) {
        await sql`UPDATE shift_splits SET offered_start = ${newStart}, offered_end = ${newEnd}, status = 'cancelled' WHERE id = ${row.id}`
      } else {
        await sql`UPDATE shift_splits SET offered_start = ${newStart}, offered_end = ${newEnd} WHERE id = ${row.id}`
      }
    }
  }

  await touchScheduleTimestamp()
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { shiftId } = await request.json() as { shiftId: string }
  if (!shiftId) return NextResponse.json({ error: 'Missing shiftId' }, { status: 400 })

  await ensureDb()
  await sql`DELETE FROM shifts WHERE id = ${shiftId}`

  const schedule = await getSchedule()
  if (schedule) {
    await setSchedule({
      ...schedule,
      assignments: schedule.assignments.filter((a) => a.shiftId !== shiftId),
      publishedAssignments: schedule.publishedAssignments.filter((a) => a.shiftId !== shiftId),
    })
  }

  return NextResponse.json({ ok: true })
}
