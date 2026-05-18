'use client'

import { useEffect, useState } from 'react'
import { useUser } from '@clerk/nextjs'
import type { Shift, Schedule } from '@/lib/types'
import { CLINIC_ABBR } from '@/lib/types'

const DAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function formatDateLong(dateStr: string) {
  return new Intl.DateTimeFormat('en-CA', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(dateStr))
}

function formatDateShort(dateStr: string) {
  return new Intl.DateTimeFormat('en-CA', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(dateStr))
}

function daysInMonth(year: number, month: number): Date[] {
  const days: Date[] = []
  const d = new Date(Date.UTC(year, month, 1))
  while (d.getUTCMonth() === month) {
    days.push(new Date(d))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return days
}

function clinicAbbr(clinic: string) {
  return CLINIC_ABBR[clinic] ?? clinic
}

function nextDayStr(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().split('T')[0].replace(/-/g, '')
}

function googleCalendarUrl(shift: Shift) {
  const start = shift.date.replace(/-/g, '')
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Contrast Call – ${shift.clinic}`,
    dates: `${start}/${nextDayStr(shift.date)}`,
    details: 'Contrast coverage call shift',
  })
  return `https://calendar.google.com/calendar/render?${params}`
}

function generateICS(shifts: Shift[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Contrast Scheduling//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ]
  for (const s of shifts) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${s.id}@contrast-scheduling`,
      `DTSTART;VALUE=DATE:${s.date.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${nextDayStr(s.date)}`,
      `SUMMARY:Contrast Call – ${s.clinic}`,
      `DESCRIPTION:Contrast coverage call shift at ${s.clinic}`,
      'END:VEVENT'
    )
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}

function downloadICS(shifts: Shift[]) {
  const blob = new Blob([generateICS(shifts)], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'contrast-shifts.ics'
  a.click()
  URL.revokeObjectURL(url)
}

export default function ProfilePage() {
  const { user, isLoaded } = useUser()
  const myName = user?.fullName ?? [user?.firstName, user?.lastName].filter(Boolean).join(' ') ?? ''

  const [shifts, setShifts] = useState<Shift[]>([])
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [loading, setLoading] = useState(true)
  const [showGoogleLinks, setShowGoogleLinks] = useState(false)

  const now = new Date()
  const [calYear, setCalYear] = useState(now.getFullYear())
  const [calMonth, setCalMonth] = useState(now.getMonth())

  useEffect(() => {
    Promise.all([
      fetch('/api/shifts').then((r) => r.json()),
      fetch('/api/schedule').then((r) => r.json()),
    ]).then(([shiftList, sched]) => {
      setShifts(Array.isArray(shiftList) ? shiftList : [])
      setSchedule(sched?.publishedAssignments?.length ? sched : null)
      setLoading(false)
    })
  }, [])

  if (!isLoaded || loading) return null

  const today = new Date().toISOString().split('T')[0]

  const shiftById = Object.fromEntries(shifts.map((s) => [s.id, s]))
  const myShifts: Shift[] = (schedule?.publishedAssignments ?? [])
    .filter((a) => a.residentName?.toLowerCase() === myName.toLowerCase())
    .map((a) => {
      if (shiftById[a.shiftId]) return shiftById[a.shiftId]
      const [date, clinic] = a.shiftId.split('|')
      return { id: a.shiftId, date, clinic } as Shift
    })

  const upcoming = myShifts.filter((s) => s.date >= today).sort((a, b) => a.date.localeCompare(b.date))
  const completed = myShifts.filter((s) => s.date < today).sort((a, b) => b.date.localeCompare(a.date))

  const myDateToClinic: Record<string, string> = {}
  for (const s of myShifts) myDateToClinic[s.date] = s.clinic

  function prevMonth() {
    if (calMonth === 0) { setCalYear((y) => y - 1); setCalMonth(11) }
    else setCalMonth((m) => m - 1)
  }
  function nextMonth() {
    if (calMonth === 11) { setCalYear((y) => y + 1); setCalMonth(0) }
    else setCalMonth((m) => m + 1)
  }

  const monthDays = daysInMonth(calYear, calMonth)
  const firstWeekday = new Date(Date.UTC(calYear, calMonth, 1)).getUTCDay()
  const monthLabel = new Intl.DateTimeFormat('en-CA', { month: 'long', year: 'numeric' })
    .format(new Date(calYear, calMonth, 1))

  return (
    <div className="max-w-3xl mx-auto px-4 py-10 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 mb-1">My Profile</h1>
        <p className="text-slate-500 text-sm">{myName}</p>
      </div>

      {!schedule ? (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center text-slate-400 text-sm">
          No schedule has been published yet. Check back after the admin publishes the schedule.
        </div>
      ) : (
        <>
          {/* ── Calendar ── */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <button
                onClick={prevMonth}
                className="text-slate-400 hover:text-slate-700 px-2 py-1 rounded-lg hover:bg-slate-100 transition-colors text-lg"
              >
                ‹
              </button>
              <h2 className="text-sm font-semibold text-slate-700">{monthLabel}</h2>
              <button
                onClick={nextMonth}
                className="text-slate-400 hover:text-slate-700 px-2 py-1 rounded-lg hover:bg-slate-100 transition-colors text-lg"
              >
                ›
              </button>
            </div>

            <div className="grid grid-cols-7 mb-1">
              {DAY_HEADERS.map((d) => (
                <div key={d} className="text-center text-xs font-medium text-slate-400 py-1">{d}</div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: firstWeekday }).map((_, i) => <div key={i} />)}
              {monthDays.map((d) => {
                const dateStr = d.toISOString().split('T')[0]
                const clinic = myDateToClinic[dateStr]
                const isToday = dateStr === today
                const isPast = dateStr < today
                return (
                  <div
                    key={dateStr}
                    title={clinic}
                    className={`aspect-square flex flex-col items-center justify-center rounded-lg text-xs select-none
                      ${clinic
                        ? isPast
                          ? 'bg-slate-500 text-white'
                          : 'bg-blue-600 text-white'
                        : isToday
                        ? 'border-2 border-blue-400 text-blue-600 font-semibold'
                        : 'text-slate-600'
                      }`}
                  >
                    <span className="font-medium">{d.getUTCDate()}</span>
                    {clinic && (
                      <span className="text-[9px] leading-tight opacity-80">{clinicAbbr(clinic)}</span>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex gap-4 text-xs text-slate-500">
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded bg-blue-600 inline-block" /> Upcoming
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded bg-slate-500 inline-block" /> Completed
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded border-2 border-blue-400 inline-block" /> Today
                </span>
              </div>

              {upcoming.length > 0 && (
                <div className="flex gap-2">
                  <button
                    onClick={() => downloadICS(upcoming)}
                    className="flex items-center gap-1.5 text-xs text-slate-600 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download .ics
                  </button>
                  <button
                    onClick={() => setShowGoogleLinks((v) => !v)}
                    className="flex items-center gap-1.5 text-xs text-slate-600 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" />
                    </svg>
                    Google Calendar
                  </button>
                </div>
              )}
            </div>

            {showGoogleLinks && upcoming.length > 0 && (
              <div className="mt-3 border-t border-slate-100 pt-3 space-y-1.5">
                <p className="text-xs text-slate-400 mb-2">Click a shift to add it to Google Calendar:</p>
                {upcoming.map((s) => (
                  <a
                    key={s.id}
                    href={googleCalendarUrl(s)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2 hover:bg-blue-50 hover:border-blue-200 transition-colors group"
                  >
                    <span className="text-sm text-slate-700">{formatDateShort(s.date)}</span>
                    <span className="text-xs text-blue-600 group-hover:text-blue-700">{s.clinic} →</span>
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* ── Completed log ── */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">Completed Shifts</h2>
              <span className="text-xs text-slate-400">{completed.length} total</span>
            </div>
            {completed.length === 0 ? (
              <p className="p-5 text-sm text-slate-400">No completed shifts yet.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {completed.map((s) => (
                  <div key={s.id} className="px-5 py-3 flex items-center justify-between">
                    <span className="text-sm text-slate-500">{formatDateLong(s.date)}</span>
                    <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                      {s.clinic}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
