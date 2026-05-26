import { NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { ensureDb, getPeriod, updatePeriodDraft, updatePeriodPublishedAssignments, touchPeriodUpdatedAt, getClinicDefaults } from '@/lib/db'
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

  const period = await getPeriod(periodId)
  if (period) {
    const nullAssignment = { shiftId, residentName: null, userId: null }
    const inDraft = period.assignments.some((a) => a.shiftId === shiftId)
    const inPublished = period.publishedAssignments.some((a) => a.shiftId === shiftId)
    if (!inDraft) await updatePeriodDraft(periodId, [...period.assignments, nullAssignment], period.generatedAt ?? null)
    if (!inPublished) await updatePeriodPublishedAssignments(periodId, [...period.publishedAssignments, nullAssignment])
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

  const { rows: shiftRows } = await sql`SELECT start_time, end_time FROM shifts WHERE id = ${shiftId}`
  const origStart = shiftRows[0]?.start_time as string | null
  const origEnd = shiftRows[0]?.end_time as string | null

  await sql`UPDATE shifts SET start_time = ${startTime ?? null}, end_time = ${endTime ?? null} WHERE id = ${shiftId}`

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
          if (row.offered_start === origStart) newStart = startTime
        } else {
          if (mins(row.offered_start) < mins(startTime)) newStart = startTime
        }
      }

      if (endTime && origEnd) {
        if (mins(endTime) > mins(origEnd)) {
          if (row.offered_end === origEnd) newEnd = endTime
        } else {
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

  // Find the period and touch its updated_at so the admin UI knows a manual edit was made
  const { rows: shiftPeriod } = await sql`SELECT period_id FROM shifts WHERE id = ${shiftId}`
  if (shiftPeriod[0]?.period_id) await touchPeriodUpdatedAt(shiftPeriod[0].period_id)

  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { shiftId } = await request.json() as { shiftId: string }
  if (!shiftId) return NextResponse.json({ error: 'Missing shiftId' }, { status: 400 })

  await ensureDb()

  const { rows: shiftRows } = await sql`SELECT period_id FROM shifts WHERE id = ${shiftId}`
  const periodId = shiftRows[0]?.period_id as string | null

  await sql`DELETE FROM shift_splits WHERE shift_id = ${shiftId}`
  await sql`DELETE FROM shifts WHERE id = ${shiftId}`

  if (periodId) {
    const period = await getPeriod(periodId)
    if (period) {
      await updatePeriodDraft(periodId, period.assignments.filter((a) => a.shiftId !== shiftId), period.generatedAt ?? null)
      await updatePeriodPublishedAssignments(periodId, period.publishedAssignments.filter((a) => a.shiftId !== shiftId))
    }
  }

  return NextResponse.json({ ok: true })
}
