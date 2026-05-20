import { NextRequest, NextResponse } from 'next/server'
import { getSchedule, getShifts, upsertShiftHistory } from '@/lib/db'

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const today = new Date().toISOString().split('T')[0]
  const [schedule, allShifts] = await Promise.all([getSchedule(), getShifts()])
  if (!schedule) return NextResponse.json({ processed: 0 })

  const shiftMap = Object.fromEntries(allShifts.map((s) => [s.id, s]))
  const toArchive = schedule.publishedAssignments
    .filter((a) => a.residentName && shiftMap[a.shiftId]?.date < today)
    .map((a) => {
      const shift = shiftMap[a.shiftId]
      return { shiftId: a.shiftId, residentName: a.residentName!, date: shift.date, clinic: shift.clinic }
    })

  await upsertShiftHistory(toArchive)
  return NextResponse.json({ processed: toArchive.length })
}
