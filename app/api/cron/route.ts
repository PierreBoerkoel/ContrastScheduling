import { NextRequest, NextResponse } from 'next/server'
import { getAllPublishedAssignments, getShifts, upsertShiftHistory } from '@/lib/db'

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const today = new Date().toISOString().split('T')[0]
  const [published, allShifts] = await Promise.all([getAllPublishedAssignments(), getShifts()])

  const shiftMap = Object.fromEntries(allShifts.map((s) => [s.id, s]))
  const toArchive = published
    .filter((a) => a.residentName && shiftMap[a.shiftId]?.date < today)
    .map((a) => {
      const shift = shiftMap[a.shiftId]
      return { shiftId: a.shiftId, userId: a.userId ?? null, residentName: a.residentName!, date: shift.date, clinic: shift.clinic, startTime: shift.startTime, endTime: shift.endTime }
    })

  await upsertShiftHistory(toArchive)
  return NextResponse.json({ processed: toArchive.length })
}
