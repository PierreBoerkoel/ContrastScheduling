import { NextResponse } from 'next/server'
import { getUserIdByCalendarToken, getCalendarShiftsForUser } from '@/lib/db'

function icalDate(date: string, time: string): string {
  return date.replace(/-/g, '') + 'T' + time.replace(':', '') + '00'
}

function icalUtcNow(): string {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z'
}

function icalLastModified(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z'
}

function escapeIcal(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const userId = await getUserIdByCalendarToken(token)
  if (!userId) {
    return new NextResponse('Not found', { status: 404 })
  }

  const segments = await getCalendarShiftsForUser(userId)
  const now = icalUtcNow()

  const events = segments.map((seg) => {
    const uid = `${seg.shiftId}@contrast-scheduling`
    const dtStart = icalDate(seg.date, seg.startTime)
    const dtEnd = icalDate(seg.date, seg.endTime)
    const lastMod = icalLastModified(seg.updatedAt)
    const summary = escapeIcal(seg.clinicName)
    return [
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${now}`,
      `DTSTART;TZID=America/Vancouver:${dtStart}`,
      `DTEND;TZID=America/Vancouver:${dtEnd}`,
      `SUMMARY:${summary}`,
      `LAST-MODIFIED:${lastMod}`,
      'STATUS:CONFIRMED',
      'END:VEVENT',
    ].join('\r\n')
  })

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ContrastScheduling//ContrastScheduling//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:My Shifts',
    'X-WR-CALDESC:Your scheduled shifts',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n')

  return new NextResponse(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="shifts.ics"',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  })
}
