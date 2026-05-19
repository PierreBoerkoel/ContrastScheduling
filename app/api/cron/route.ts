import { NextRequest, NextResponse } from 'next/server'
import { getSchedule, upsertShiftHistory } from '@/lib/db'

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const today = new Date().toISOString().split('T')[0]
  const schedule = await getSchedule()
  if (!schedule) return NextResponse.json({ processed: 0 })

  const pastAssignments = schedule.publishedAssignments.filter(
    (a) => a.residentName && a.shiftId.split('|')[0] < today
  )

  await upsertShiftHistory(pastAssignments)
  return NextResponse.json({ processed: pastAssignments.length })
}
