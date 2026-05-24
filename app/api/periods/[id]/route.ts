import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { deleteSchedulingPeriod, setShifts, getShifts, getSchedule, setSchedule, upsertShiftHistory, getShiftSplits, deleteShiftSplit } from '@/lib/db'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await currentUser()
  if ((user?.publicMetadata as { role?: string })?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { id } = await params

  // Collect this period's shift IDs before deleting, so we can scrub the schedule
  const [allShifts, allSplits] = await Promise.all([getShifts(), getShiftSplits()])
  const periodShiftIds = new Set(allShifts.filter((s) => s.periodId === id).map((s) => s.id))

  if (periodShiftIds.size > 0) {
    const schedule = await getSchedule()
    if (schedule) {
      // Archive only past completed assignments before wiping them from the schedule
      const today = new Date().toISOString().split('T')[0]
      const shiftMap = Object.fromEntries(allShifts.map((s) => [s.id, s]))
      const toArchive = schedule.publishedAssignments
        .filter((a) => periodShiftIds.has(a.shiftId) && a.residentName && (shiftMap[a.shiftId]?.date ?? '') < today)
        .map((a) => {
          const shift = shiftMap[a.shiftId]
          return { shiftId: a.shiftId, userId: a.userId ?? null, residentName: a.residentName!, date: shift?.date ?? '', clinic: shift?.clinic ?? '', startTime: shift?.startTime, endTime: shift?.endTime }
        })
        .filter((r) => r.date && r.clinic)

      // Also archive accepted split acceptors with their coverage window
      const splitRecords = allSplits
        .filter((sp) => sp.status === 'accepted' && sp.acceptorName && periodShiftIds.has(sp.shiftId))
        .flatMap((sp) => {
          const shift = shiftMap[sp.shiftId]
          if (!shift || shift.date >= today) return []
          return [{
            shiftId: `${sp.shiftId}::split::${sp.id}`,
            residentName: sp.acceptorName!,
            date: shift.date,
            clinic: shift.clinic,
            startTime: sp.offeredStart,
            endTime: sp.offeredEnd,
          }]
        })

      const allRecords = [...toArchive, ...splitRecords]
      if (allRecords.length > 0) await upsertShiftHistory(allRecords)

      await setSchedule({
        ...schedule,
        assignments: schedule.assignments.filter((a) => !periodShiftIds.has(a.shiftId)),
        publishedAssignments: schedule.publishedAssignments.filter((a) => !periodShiftIds.has(a.shiftId)),
      })
    }
  }

  const periodSplits = allSplits.filter((sp) => periodShiftIds.has(sp.shiftId))
  await Promise.all(periodSplits.map((sp) => deleteShiftSplit(sp.id)))

  await setShifts([], id)
  await deleteSchedulingPeriod(id)
  return NextResponse.json({ ok: true })
}
