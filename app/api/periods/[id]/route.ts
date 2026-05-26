import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { deleteSchedulingPeriod, setShifts, getShifts, getPeriod, upsertShiftHistory, getShiftSplits, deleteShiftSplit } from '@/lib/db'

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

  const [period, allShifts, allSplits] = await Promise.all([getPeriod(id), getShifts(), getShiftSplits()])
  const periodShiftIds = new Set(allShifts.filter((s) => s.periodId === id).map((s) => s.id))

  if (period && periodShiftIds.size > 0) {
    const today = new Date().toISOString().split('T')[0]
    const shiftMap = Object.fromEntries(allShifts.map((s) => [s.id, s]))

    const toArchive = period.publishedAssignments
      .filter((a) => periodShiftIds.has(a.shiftId) && a.residentName && (shiftMap[a.shiftId]?.date ?? '') < today)
      .map((a) => {
        const s = shiftMap[a.shiftId]
        return { shiftId: a.shiftId, userId: a.userId ?? null, residentName: a.residentName!, date: s?.date ?? '', clinic: s?.clinic ?? '', startTime: s?.startTime, endTime: s?.endTime }
      })
      .filter((r) => r.date && r.clinic)

    const splitRecords = allSplits
      .filter((sp) => sp.status === 'accepted' && sp.acceptorName && periodShiftIds.has(sp.shiftId))
      .flatMap((sp) => {
        const s = shiftMap[sp.shiftId]
        if (!s || s.date >= today) return []
        return [{ shiftId: `${sp.shiftId}::split::${sp.id}`, residentName: sp.acceptorName!, date: s.date, clinic: s.clinic, startTime: sp.offeredStart, endTime: sp.offeredEnd }]
      })

    const allRecords = [...toArchive, ...splitRecords]
    if (allRecords.length > 0) await upsertShiftHistory(allRecords)
  }

  const periodSplits = allSplits.filter((sp) => periodShiftIds.has(sp.shiftId))
  await Promise.all(periodSplits.map((sp) => deleteShiftSplit(sp.id)))
  await setShifts([], id)
  await deleteSchedulingPeriod(id)
  return NextResponse.json({ ok: true })
}
