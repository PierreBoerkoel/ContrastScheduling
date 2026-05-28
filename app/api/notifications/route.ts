import { NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { getPeriod } from '@/lib/db'
import { sendAvailabilityNotification, sendScheduleNotification } from '@/lib/email'

export async function POST(request: Request) {
  const user = await currentUser()
  if ((user?.publicMetadata as { role?: string })?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { type, periodId } = await request.json() as { type: string; periodId: string }
  if (!type || !periodId) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })

  const period = await getPeriod(periodId)
  if (!period) return NextResponse.json({ error: 'Period not found' }, { status: 404 })

  try {
    if (type === 'availability') {
      await sendAvailabilityNotification(period)
    } else if (type === 'schedule') {
      await sendScheduleNotification(period)
    } else {
      return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: `Failed to send emails: ${message}` }, { status: 502 })
  }

  return NextResponse.json({ ok: true })
}
