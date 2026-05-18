'use client'

import { useEffect, useState } from 'react'
import { useUser } from '@clerk/nextjs'
import type { Shift, ClinicName, Schedule, AvailabilitySubmission, SchedulingPeriod } from '@/lib/types'
import { CLINICS } from '@/lib/types'

const CLINIC_ABBR: Record<string, string> = {
  'BC Cancer Agency': 'BCCA',
  'INITIO Medical Imaging': 'INITIO',
  'UBC Hospital': 'UBC',
  "BC Women's Hospital": 'BCWH',
}

function formatDate(dateStr: string) {
  return new Intl.DateTimeFormat('en-CA', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(dateStr))
}

function formatShortDate(dateStr: string) {
  return new Intl.DateTimeFormat('en-CA', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(dateStr))
}

export default function AvailabilityPage() {
  const { user, isLoaded } = useUser()
  const myName = (user?.fullName ?? '').toLowerCase()

  const [shifts, setShifts] = useState<Shift[]>([])
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [periods, setPeriods] = useState<SchedulingPeriod[]>([])
  const [submissions, setSubmissions] = useState<AvailabilitySubmission[]>([])
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([
      fetch('/api/shifts').then((r) => r.json()),
      fetch('/api/availability').then((r) => r.json()),
      fetch('/api/schedule').then((r) => r.json()),
      fetch('/api/periods').then((r) => r.json()),
    ]).then(([shiftList, submissionList, sched, periodList]: [Shift[], AvailabilitySubmission[], Schedule, SchedulingPeriod[]]) => {
      setShifts(shiftList)
      setSchedule(sched)
      if (Array.isArray(submissionList)) setSubmissions(submissionList)
      if (Array.isArray(periodList)) setPeriods(periodList)
      setLoading(false)
    })
  }, [user])

  const today = new Date().toISOString().split('T')[0]

  // Only show blocks that haven't ended yet
  const upcomingPeriods = periods
    .filter((p) => p.endDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))

  const publishedIds = new Set((schedule?.publishedAssignments ?? []).map((a) => a.shiftId))

  // Default to first upcoming block that is not published
  const firstUnlockedId = upcomingPeriods.find((p) => {
    const blockShifts = shifts.filter((s) => s.periodId === p.id)
    return !blockShifts.some((s) => publishedIds.has(s.id))
  })?.id ?? null

  const effectivePeriodId = selectedPeriodId ?? firstUnlockedId
  const selectedPeriod = upcomingPeriods.find((p) => p.id === effectivePeriodId) ?? null

  const visibleShifts = selectedPeriod
    ? shifts.filter((s) => s.periodId === selectedPeriod.id)
    : []

  // When the selected block changes, load that block's existing submission
  useEffect(() => {
    if (!effectivePeriodId || !myName) return
    const existing = submissions.find(
      (s) => s.periodId === effectivePeriodId && s.residentName?.toLowerCase() === myName
    )
    setSelected(new Set(existing?.availableShiftIds ?? []))
    setSubmitted(false)
    setError('')
  }, [effectivePeriodId, submissions, myName])

  function toggleShift(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const byDate = visibleShifts.reduce<Record<string, Shift[]>>((acc, shift) => {
    ;(acc[shift.date] ??= []).push(shift)
    return acc
  }, {})
  const sortedDates = Object.keys(byDate).sort()

  function toggleAllOnDay(date: string) {
    const shiftsOnDay = byDate[date] ?? []
    const allSelected = shiftsOnDay.every((s) => selected.has(s.id))
    setSelected((prev) => {
      const next = new Set(prev)
      if (allSelected) {
        shiftsOnDay.forEach((s) => next.delete(s.id))
      } else {
        shiftsOnDay.forEach((s) => next.add(s.id))
      }
      return next
    })
  }

  async function handleSubmit() {
    if (!effectivePeriodId) return
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ availableShiftIds: Array.from(selected), periodId: effectivePeriodId }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Submission failed')
      }
      const updated: AvailabilitySubmission = await res.json()
      setSubmissions((prev) => {
        const without = prev.filter((s) => !(s.periodId === effectivePeriodId && s.residentName?.toLowerCase() === myName))
        return [...without, updated]
      })
      setSubmitted(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (!isLoaded) return null

  const allLocked = !loading && upcomingPeriods.length > 0 &&
    upcomingPeriods.every((p) => {
      const bShifts = shifts.filter((s) => s.periodId === p.id)
      return bShifts.length > 0 && bShifts.some((s) => publishedIds.has(s.id))
    })

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <h1 className="text-2xl font-bold text-slate-800 mb-1">Submit Availability</h1>
      <p className="text-slate-500 mb-6 text-sm">
        Select a block, then mark the shifts you are available to cover.
      </p>

      <div className="flex items-center gap-2 mb-6 bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-sm text-blue-800">
        Submitting as <strong>{user?.fullName ?? user?.firstName ?? user?.emailAddresses[0]?.emailAddress}</strong>
      </div>

      {loading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : upcomingPeriods.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center text-slate-400 text-sm">
          No upcoming scheduling blocks have been set up yet. Check back once the admin has configured them.
        </div>
      ) : allLocked ? (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center">
          <div className="text-3xl mb-2">🔒</div>
          <h2 className="text-base font-semibold text-amber-800 mb-1">All upcoming blocks are scheduled</h2>
          <p className="text-sm text-amber-700">
            No availability submission is needed right now. Check back once the next block is configured.
          </p>
        </div>
      ) : (
        <>
          {/* Block selector — only unlocked blocks */}
          <div className="flex items-center gap-2 flex-wrap mb-6">
            <span className="text-sm text-slate-500 mr-1">Block:</span>
            {upcomingPeriods
              .filter((p) => {
                const bShifts = shifts.filter((s) => s.periodId === p.id)
                return !bShifts.some((s) => publishedIds.has(s.id))
              })
              .map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedPeriodId(p.id)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors border text-left ${
                    effectivePeriodId === p.id
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div>{p.name}</div>
                  <div className={`text-xs font-normal ${effectivePeriodId === p.id ? 'text-blue-100' : 'text-slate-400'}`}>
                    {formatShortDate(p.startDate)} – {formatShortDate(p.endDate)}
                  </div>
                </button>
              ))}
          </div>

          {/* Per-block content */}
          {submitted ? (
            <div className="bg-green-50 border border-green-200 rounded-xl p-6 text-center">
              <div className="text-3xl mb-2">✅</div>
              <h2 className="text-base font-semibold text-green-800 mb-1">Availability submitted!</h2>
              <p className="text-sm text-green-700 mb-3">
                Your availability for <strong>{selectedPeriod?.name}</strong> has been saved.
              </p>
              <button onClick={() => setSubmitted(false)} className="text-sm text-green-700 underline">
                Update my availability
              </button>
            </div>
          ) : visibleShifts.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center text-slate-400 text-sm">
              No shifts configured for {selectedPeriod?.name ?? 'this block'} yet.
            </div>
          ) : (
            <>
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-x-auto overflow-y-auto max-h-[70vh]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10">
                    <tr className="border-b border-slate-100">
                      <th className="text-left px-4 py-3 font-medium text-slate-600 bg-slate-50 whitespace-nowrap">Date</th>
                      <th className="text-center px-3 py-3 font-medium text-slate-500 bg-slate-50 whitespace-nowrap"></th>
                      {CLINICS.map((clinic) => (
                        <th key={clinic} className="text-center px-3 py-3 font-medium text-slate-600 whitespace-nowrap bg-slate-50">
                          {CLINIC_ABBR[clinic] ?? clinic}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedDates.map((date) => {
                      const shiftsOnDay = byDate[date]
                      const allSelected = shiftsOnDay.every((s) => selected.has(s.id))
                      return (
                        <tr key={date} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                          <td className="px-4 py-3 text-slate-700 whitespace-nowrap">
                            {formatDate(date)}
                          </td>
                          <td className="text-center px-3 py-3">
                            <button
                              onClick={() => toggleAllOnDay(date)}
                              className="text-xs font-medium text-blue-600 hover:text-blue-800 whitespace-nowrap"
                            >
                              {allSelected ? 'Deselect' : 'Select all'}
                            </button>
                          </td>
                          {CLINICS.map((clinic: ClinicName) => {
                            const shift = shiftsOnDay.find((s) => s.clinic === clinic)
                            if (!shift) {
                              return <td key={clinic} className="text-center px-3 py-3 text-slate-200">—</td>
                            }
                            return (
                              <td key={clinic} className="text-center px-3 py-3">
                                <input
                                  type="checkbox"
                                  checked={selected.has(shift.id)}
                                  onChange={() => toggleShift(shift.id)}
                                  className="w-4 h-4 accent-blue-600 cursor-pointer"
                                />
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-6 flex items-center gap-4">
                <button
                  onClick={handleSubmit}
                  disabled={submitting || !effectivePeriodId}
                  className="bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
                >
                  {submitting ? 'Submitting…' : 'Submit Availability'}
                </button>
                <span className="text-sm text-slate-400">
                  {selected.size} shift{selected.size !== 1 ? 's' : ''} selected
                </span>
                {error && <span className="text-sm text-red-500">{error}</span>}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
