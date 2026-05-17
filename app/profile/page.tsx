'use client'

import { useEffect, useState } from 'react'
import { useUser } from '@clerk/nextjs'
import type { Shift, Schedule } from '@/lib/types'

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

function daysInMonth(year: number, month: number): Date[] {
  const days: Date[] = []
  const d = new Date(Date.UTC(year, month, 1))
  while (d.getUTCMonth() === month) {
    days.push(new Date(d))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return days
}

export default function ProfilePage() {
  const { user, isLoaded } = useUser()
  const myName = user?.fullName ?? [user?.firstName, user?.lastName].filter(Boolean).join(' ') ?? ''

  const [shifts, setShifts] = useState<Shift[]>([])
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [loading, setLoading] = useState(true)

  const now = new Date()
  const [calYear, setCalYear] = useState(now.getFullYear())
  const [calMonth, setCalMonth] = useState(now.getMonth())

  useEffect(() => {
    Promise.all([
      fetch('/api/shifts').then((r) => r.json()),
      fetch('/api/schedule').then((r) => r.json()),
    ]).then(([shiftList, sched]) => {
      setShifts(Array.isArray(shiftList) ? shiftList : [])
      setSchedule(sched?.isPublished ? sched : null)
      setLoading(false)
    })
  }, [])

  if (!isLoaded || loading) return null

  const today = new Date().toISOString().split('T')[0]

  const shiftById = Object.fromEntries(shifts.map((s) => [s.id, s]))
  const myShifts: Shift[] = (schedule?.assignments ?? [])
    .filter((a) => a.residentName?.toLowerCase() === myName.toLowerCase())
    .map((a) => shiftById[a.shiftId])
    .filter(Boolean) as Shift[]

  const upcoming = myShifts.filter((s) => s.date >= today).sort((a, b) => a.date.localeCompare(b.date))
  const completed = myShifts.filter((s) => s.date < today).sort((a, b) => b.date.localeCompare(a.date))

  // Calendar data
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

  // Abbreviate clinic name to fit in calendar cell
  function clinicAbbr(clinic: string) {
    const words = clinic.split(' ')
    if (words.length >= 2) return words.map((w) => w[0]).join('')
    return clinic.slice(0, 3)
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-10 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 mb-1">My Profile</h1>
        <p className="text-slate-500 text-sm">{myName}</p>
      </div>

      {!schedule && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center text-slate-400 text-sm">
          No schedule has been published yet. Check back after the admin publishes the schedule.
        </div>
      )}

      {schedule && (
        <>
          {/* ── Calendar ── */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <button
                onClick={prevMonth}
                className="text-slate-400 hover:text-slate-700 px-2 py-1 rounded-lg hover:bg-slate-100 transition-colors"
              >
                ‹
              </button>
              <h2 className="text-sm font-semibold text-slate-700">{monthLabel}</h2>
              <button
                onClick={nextMonth}
                className="text-slate-400 hover:text-slate-700 px-2 py-1 rounded-lg hover:bg-slate-100 transition-colors"
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
                        ? 'border border-blue-400 text-blue-600 font-semibold'
                        : 'text-slate-600'
                      }`}
                  >
                    <span>{d.getUTCDate()}</span>
                    {clinic && (
                      <span className="text-[9px] leading-tight opacity-80">{clinicAbbr(clinic)}</span>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="mt-3 flex gap-4 text-xs text-slate-500">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-blue-600 inline-block" /> Upcoming
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-slate-500 inline-block" /> Completed
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded border border-blue-400 inline-block" /> Today
              </span>
            </div>
          </div>

          {/* ── Upcoming ── */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">Upcoming Shifts</h2>
              <span className="text-xs text-slate-400">{upcoming.length} shift{upcoming.length !== 1 ? 's' : ''}</span>
            </div>
            {upcoming.length === 0 ? (
              <p className="p-5 text-sm text-slate-400">No upcoming shifts assigned.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {upcoming.map((s) => (
                  <div key={s.id} className="px-5 py-3 flex items-center justify-between">
                    <span className="text-sm text-slate-700">{formatDateLong(s.date)}</span>
                    <span className="text-xs font-medium text-blue-700 bg-blue-50 border border-blue-100 px-2 py-0.5 rounded-full">
                      {s.clinic}
                    </span>
                  </div>
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
