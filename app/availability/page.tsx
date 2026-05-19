'use client'

import { useEffect, useState } from 'react'
import { useUser } from '@clerk/nextjs'
import type { Shift, ClinicName, Schedule, AvailabilitySubmission, SchedulingPeriod } from '@/lib/types'
import { CLINICS, CLINIC_ABBR, formatTimeRange } from '@/lib/types'

function formatDate(dateStr: string) {
  return new Intl.DateTimeFormat('en-CA', {
    weekday: 'short',
    month: 'short',
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
  const [maxShifts, setMaxShifts] = useState<number | ''>('')
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
      if (Array.isArray(shiftList)) setShifts(shiftList)
      if (sched && 'isPublished' in sched) setSchedule(sched)
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

  // Default to first upcoming block that is not published; fall back to first block
  const firstUnlockedId = upcomingPeriods.find((p) => {
    const blockShifts = shifts.filter((s) => s.periodId === p.id)
    return !blockShifts.some((s) => publishedIds.has(s.id))
  })?.id ?? upcomingPeriods[0]?.id ?? null

  const effectivePeriodId = selectedPeriodId ?? firstUnlockedId
  const selectedPeriod = upcomingPeriods.find((p) => p.id === effectivePeriodId) ?? null

  const visibleShifts = selectedPeriod
    ? shifts.filter((s) => s.periodId === selectedPeriod.id)
    : []

  const selectedBlockPublished = !loading && visibleShifts.length > 0 &&
    visibleShifts.some((s) => publishedIds.has(s.id))

  // When the selected block changes, load that block's existing submission
  useEffect(() => {
    if (!effectivePeriodId || !myName) return
    const existing = submissions.find(
      (s) => s.periodId === effectivePeriodId && s.residentName?.toLowerCase() === myName
    )
    setSelected(new Set(existing?.availableShiftIds ?? []))
    setMaxShifts(existing?.maxShifts ?? '')
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
        body: JSON.stringify({ availableShiftIds: Array.from(selected), periodId: effectivePeriodId, maxShifts: maxShifts || undefined }),
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
      ) : (
        <>
          {/* Block selector — all configured blocks */}
          <div className="flex items-center gap-2 flex-wrap mb-6">
            {upcomingPeriods.map((p) => {
              const bShifts = shifts.filter((s) => s.periodId === p.id)
              const bPublished = bShifts.length > 0 && bShifts.some((s) => publishedIds.has(s.id))
              return (
                <button
                  key={p.id}
                  onClick={() => setSelectedPeriodId(p.id)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors border text-left ${
                    effectivePeriodId === p.id
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {p.name}
                    {bPublished && (
                      <span className={`text-xs font-normal px-1.5 py-0.5 rounded ${effectivePeriodId === p.id ? 'bg-blue-500 text-blue-100' : 'bg-slate-100 text-slate-500'}`}>
                        Scheduled
                      </span>
                    )}
                  </div>
                  <div className={`text-xs font-normal ${effectivePeriodId === p.id ? 'text-blue-100' : 'text-slate-400'}`}>
                    {formatShortDate(p.startDate)} – {formatShortDate(p.endDate)}
                  </div>
                </button>
              )
            })}
          </div>

          {selectedBlockPublished && (
            <div className="mb-4 flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5 text-sm text-slate-600">
              <span>🗓</span>
              This block has been scheduled. Your past availability submission is shown below.
            </div>
          )}

          {/* Per-block content */}
          {submitted && (
            <div className="mb-4 flex items-center justify-between gap-3 bg-green-50 border border-green-200 rounded-lg px-4 py-2.5 text-sm text-green-800">
              <span>Availability for <strong>{selectedPeriod?.name}</strong> saved successfully.</span>
              <button onClick={() => setSubmitted(false)} className="text-green-600 hover:text-green-800 text-xs underline shrink-0">Dismiss</button>
            </div>
          )}

          {visibleShifts.length === 0 ? (
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
                      {!selectedBlockPublished && (
                        <th className="text-center px-3 py-3 font-medium text-slate-500 bg-slate-50 whitespace-nowrap"></th>
                      )}
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
                          {!selectedBlockPublished && (
                            <td className="text-center px-3 py-3">
                              <button
                                onClick={() => toggleAllOnDay(date)}
                                className="text-xs font-medium text-blue-600 hover:text-blue-800 whitespace-nowrap"
                              >
                                {allSelected ? 'Deselect' : 'Select all'}
                              </button>
                            </td>
                          )}
                          {CLINICS.map((clinic: ClinicName) => {
                            const shift = shiftsOnDay.find((s) => s.clinic === clinic)
                            if (!shift) {
                              return <td key={clinic} className="text-center px-3 py-3 text-slate-200">—</td>
                            }
                            return (
                              <td key={clinic} className="text-center px-3 py-3">
                                <div className="flex flex-col items-center gap-0.5">
                                  <input
                                    type="checkbox"
                                    checked={selected.has(shift.id)}
                                    onChange={() => toggleShift(shift.id)}
                                    disabled={selectedBlockPublished}
                                    className="w-4 h-4 accent-blue-600 cursor-pointer disabled:cursor-default disabled:opacity-50"
                                  />
                                  {formatTimeRange(shift.startTime, shift.endTime) && (
                                    <span className="text-[10px] leading-tight text-slate-400 whitespace-nowrap">
                                      {formatTimeRange(shift.startTime, shift.endTime)}
                                    </span>
                                  )}
                                </div>
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {!selectedBlockPublished && (
                <div className="mt-5 flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
                  <label className="text-sm text-slate-600 whitespace-nowrap">
                    Maximum number of shifts I can work this block:
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={visibleShifts.length || undefined}
                    value={maxShifts}
                    onChange={(e) => setMaxShifts(e.target.value === '' ? '' : Math.max(1, parseInt(e.target.value, 10)))}
                    placeholder="No limit"
                    className="w-24 border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {maxShifts !== '' && (
                    <button
                      onClick={() => setMaxShifts('')}
                      className="text-xs text-slate-400 hover:text-slate-600"
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}

              <div className="mt-4 flex items-center gap-4 flex-wrap">
                <button
                  onClick={handleSubmit}
                  disabled={submitting || !effectivePeriodId || selectedBlockPublished}
                  className="bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {submitting ? 'Submitting…' : submissions.some((s) => s.periodId === effectivePeriodId && s.residentName?.toLowerCase() === myName) ? 'Update Availability' : 'Submit Availability'}
                </button>
                {(() => {
                  const existing = submissions.find(
                    (s) => s.periodId === effectivePeriodId && s.residentName?.toLowerCase() === myName
                  )
                  return existing ? (
                    <span className="text-xs text-slate-400">
                      Last submitted {new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(existing.submittedAt))}
                    </span>
                  ) : null
                })()}
                {error && <span className="text-sm text-red-500">{error}</span>}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
