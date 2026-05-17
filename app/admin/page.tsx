'use client'

import { useEffect, useState, useCallback } from 'react'
import type { Shift, AvailabilitySubmission, Schedule, ClinicName, SwapRequest } from '@/lib/types'
import { CLINICS } from '@/lib/types'

type Tab = 'shifts' | 'availability' | 'schedule' | 'swaps'

function formatDate(dateStr: string) {
  return new Intl.DateTimeFormat('en-CA', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(dateStr))
}

function isWeekend(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00Z').getUTCDay()
  return d === 0 || d === 6
}

function datesInRange(start: string, end: string): string[] {
  const dates: string[] = []
  const current = new Date(start + 'T00:00:00Z')
  const endDate = new Date(end + 'T00:00:00Z')
  while (current <= endDate) {
    dates.push(current.toISOString().split('T')[0])
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return dates
}

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('shifts')

  // Shift setup state
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [activeClinics, setActiveClinics] = useState<Record<string, Set<ClinicName>>>({})
  const [savingShifts, setSavingShifts] = useState(false)
  const [shiftsSaved, setShiftsSaved] = useState(false)

  // Data
  const [shifts, setShifts] = useState<Shift[]>([])
  const [submissions, setSubmissions] = useState<AvailabilitySubmission[]>([])
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [swapRequests, setSwapRequests] = useState<SwapRequest[]>([])

  // Schedule interaction
  const [editingShiftId, setEditingShiftId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [publishing, setPublishing] = useState(false)

  const fetchData = useCallback(async () => {
    const [s, sub, sched, swaps] = await Promise.all([
      fetch('/api/shifts').then((r) => r.json()),
      fetch('/api/availability').then((r) => r.json()),
      fetch('/api/schedule').then((r) => r.json()),
      fetch('/api/swaps').then((r) => r.json()),
    ])
    setShifts(s)
    setSubmissions(sub)
    setSchedule(sched)
    setSwapRequests(swaps)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // Initialize the clinic grid whenever the date range changes
  useEffect(() => {
    if (!startDate || !endDate || startDate > endDate) return
    const dates = datesInRange(startDate, endDate)
    setActiveClinics((prev) => {
      const next: Record<string, Set<ClinicName>> = {}
      for (const d of dates) {
        if (prev[d]) {
          next[d] = prev[d]
        } else {
          // Default: all clinics active on weekdays
          next[d] = isWeekend(d) ? new Set() : new Set(CLINICS)
        }
      }
      return next
    })
  }, [startDate, endDate])

  function toggleClinic(date: string, clinic: ClinicName) {
    setActiveClinics((prev) => {
      const next = { ...prev, [date]: new Set(prev[date]) }
      next[date].has(clinic) ? next[date].delete(clinic) : next[date].add(clinic)
      return next
    })
  }

  async function saveShifts() {
    setSavingShifts(true)
    setShiftsSaved(false)
    const payload: Record<string, ClinicName[]> = {}
    for (const [date, clinicSet] of Object.entries(activeClinics)) {
      payload[date] = Array.from(clinicSet)
    }
    await fetch('/api/shifts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, activeClinics: payload }),
    })
    await fetchData()
    setSavingShifts(false)
    setShiftsSaved(true)
  }

  async function generateSchedule() {
    setGenerating(true)
    await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'generate' }),
    })
    await fetchData()
    setGenerating(false)
  }

  async function publishSchedule() {
    setPublishing(true)
    await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'publish' }),
    })
    await fetchData()
    setPublishing(false)
  }

  async function updateAssignment(shiftId: string, residentName: string | null) {
    await fetch('/api/schedule', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shiftId, residentName }),
    })
    setEditingShiftId(null)
    await fetchData()
  }

  // Derived data
  const byDate = shifts.reduce<Record<string, Shift[]>>((acc, shift) => {
    ;(acc[shift.date] ??= []).push(shift)
    return acc
  }, {})
  const sortedDates = Object.keys(byDate).sort()

  const assignmentMap: Record<string, string | null> = {}
  if (schedule) {
    for (const a of schedule.assignments) {
      assignmentMap[a.shiftId] = a.residentName
    }
  }

  // Available residents for a shift (who marked available)
  function availableFor(shiftId: string): string[] {
    return submissions
      .filter((s) => s.availableShiftIds.includes(shiftId))
      .map((s) => s.residentName)
  }

  const counts: Record<string, number> = {}
  if (schedule) {
    for (const a of schedule.assignments) {
      if (a.residentName) counts[a.residentName] = (counts[a.residentName] ?? 0) + 1
    }
  }

  const dateRange = startDate && endDate && startDate <= endDate ? datesInRange(startDate, endDate) : []

  const tabClass = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
      tab === t ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'
    }`

  return (
    <div className="max-w-6xl mx-auto px-4 py-10">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Admin Dashboard</h1>
        <div className="flex gap-2">
          <button onClick={() => setTab('shifts')} className={tabClass('shifts')}>Shifts</button>
          <button onClick={() => setTab('availability')} className={tabClass('availability')}>
            Availability
            {submissions.length > 0 && (
              <span className="ml-1.5 bg-blue-100 text-blue-700 text-xs px-1.5 py-0.5 rounded-full">
                {submissions.length}
              </span>
            )}
          </button>
          <button onClick={() => setTab('schedule')} className={tabClass('schedule')}>Schedule</button>
          <button onClick={() => setTab('swaps')} className={tabClass('swaps')}>
            Swaps
            {swapRequests.filter((r) => r.status === 'pending').length > 0 && (
              <span className="ml-1.5 bg-amber-100 text-amber-700 text-xs px-1.5 py-0.5 rounded-full">
                {swapRequests.filter((r) => r.status === 'pending').length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ── SHIFTS TAB ── */}
      {tab === 'shifts' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-base font-semibold text-slate-700 mb-4">Set Scheduling Period</h2>
            <div className="flex gap-4 mb-6 flex-wrap">
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                Start date
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                End date
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </label>
            </div>

            {dateRange.length > 0 && (
              <>
                <p className="text-xs text-slate-400 mb-3">
                  Check the clinics that have shifts on each day. Weekends are unchecked by default.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50">
                        <th className="text-left px-3 py-2 font-medium text-slate-600">Date</th>
                        {CLINICS.map((c) => (
                          <th key={c} className="text-center px-3 py-2 font-medium text-slate-600 whitespace-nowrap">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dateRange.map((date) => (
                        <tr key={date} className={`border-b border-slate-100 last:border-0 ${isWeekend(date) ? 'bg-slate-50' : ''}`}>
                          <td className="px-3 py-2 text-slate-700 whitespace-nowrap">
                            {formatDate(date)}
                            {isWeekend(date) && <span className="ml-2 text-xs text-slate-300">weekend</span>}
                          </td>
                          {CLINICS.map((clinic) => (
                            <td key={clinic} className="text-center px-3 py-2">
                              <input
                                type="checkbox"
                                checked={activeClinics[date]?.has(clinic) ?? false}
                                onChange={() => toggleClinic(date, clinic)}
                                className="w-4 h-4 accent-blue-600 cursor-pointer"
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <button
                    onClick={saveShifts}
                    disabled={savingShifts}
                    className="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
                  >
                    {savingShifts ? 'Saving…' : 'Save Shifts'}
                  </button>
                  {shiftsSaved && <span className="text-sm text-green-600">Shifts saved! Share the availability link with residents.</span>}
                </div>
              </>
            )}
          </div>

          {shifts.length > 0 && (
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-700">
              <strong>{shifts.length} shifts</strong> currently set up across{' '}
              {new Set(shifts.map((s) => s.date)).size} days. Share{' '}
              <span className="font-mono bg-blue-100 px-1 rounded">/availability</span> with
              residents to collect their availability.
            </div>
          )}
        </div>
      )}

      {/* ── AVAILABILITY TAB ── */}
      {tab === 'availability' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          {submissions.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-sm">
              No availability submissions yet.
            </div>
          ) : (
            <>
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-700">
                  {submissions.length} submission{submissions.length !== 1 ? 's' : ''}
                </h2>
                <span className="text-xs text-slate-400">{shifts.length} total shifts</span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50">
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Resident</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Shifts available</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {submissions.map((sub) => (
                    <tr key={sub.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-3 font-medium text-slate-800">{sub.residentName}</td>
                      <td className="px-4 py-3 text-slate-600">
                        {sub.availableShiftIds.length} / {shifts.length}
                        <div className="w-32 h-1.5 bg-slate-100 rounded-full mt-1 overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full"
                            style={{ width: shifts.length > 0 ? `${(sub.availableShiftIds.length / shifts.length) * 100}%` : '0%' }}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-400 text-xs">
                        {new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short' }).format(
                          new Date(sub.submittedAt)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {/* ── SCHEDULE TAB ── */}
      {tab === 'schedule' && (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-3 items-center">
            <button
              onClick={generateSchedule}
              disabled={generating || shifts.length === 0 || submissions.length === 0}
              className="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              {generating ? 'Generating…' : schedule ? 'Regenerate Schedule' : 'Generate Schedule'}
            </button>
            {schedule && !schedule.isPublished && (
              <button
                onClick={publishSchedule}
                disabled={publishing}
                className="bg-green-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-40 transition-colors"
              >
                {publishing ? 'Publishing…' : 'Publish Schedule'}
              </button>
            )}
            {schedule?.isPublished && (
              <span className="text-sm text-green-600 font-medium">
                Published —{' '}
                <button onClick={publishSchedule} disabled={publishing} className="underline text-green-500">
                  Re-publish
                </button>
              </span>
            )}
          </div>

          {shifts.length === 0 && (
            <p className="text-sm text-slate-400">Set up shifts first in the Shifts tab.</p>
          )}
          {shifts.length > 0 && submissions.length === 0 && (
            <p className="text-sm text-slate-400">No availability submitted yet.</p>
          )}

          {schedule && (
            <>
              {/* Assignment summary */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                <h2 className="text-sm font-semibold text-slate-600 mb-3">Shift totals</h2>
                <div className="flex flex-wrap gap-3">
                  {Object.entries(counts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([resident, count]) => (
                      <span
                        key={resident}
                        className="inline-flex items-center gap-1.5 bg-slate-100 text-slate-700 text-sm px-3 py-1 rounded-full"
                      >
                        <span className="font-medium">{resident}</span>
                        <span className="text-slate-400 text-xs">{count}</span>
                      </span>
                    ))}
                  {schedule.assignments.filter((a) => !a.residentName).length > 0 && (
                    <span className="text-xs text-red-400 self-center">
                      {schedule.assignments.filter((a) => !a.residentName).length} unassigned shift
                      {schedule.assignments.filter((a) => !a.residentName).length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </div>

              {/* Schedule grid */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 text-xs text-slate-400">
                  Click a cell to manually reassign. Changes will require re-publishing.
                </div>
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Date</th>
                      {CLINICS.map((clinic) => (
                        <th key={clinic} className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">
                          {clinic}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedDates.map((date) => {
                      const shiftsOnDay = byDate[date]
                      return (
                        <tr key={date} className="border-b border-slate-100 last:border-0">
                          <td className="px-4 py-3 font-medium text-slate-700 whitespace-nowrap">
                            {formatDate(date)}
                          </td>
                          {CLINICS.map((clinic) => {
                            const shift = shiftsOnDay.find((s) => s.clinic === clinic)
                            if (!shift) {
                              return <td key={clinic} className="px-4 py-3 text-slate-200">—</td>
                            }
                            const resident = assignmentMap[shift.id]
                            const isEditing = editingShiftId === shift.id
                            const available = availableFor(shift.id)

                            if (isEditing) {
                              return (
                                <td key={clinic} className="px-4 py-3">
                                  <select
                                    autoFocus
                                    defaultValue={resident ?? ''}
                                    onChange={(e) =>
                                      updateAssignment(shift.id, e.target.value || null)
                                    }
                                    onBlur={() => setEditingShiftId(null)}
                                    className="border border-blue-400 rounded px-2 py-1 text-sm focus:outline-none"
                                  >
                                    <option value="">Unassigned</option>
                                    {submissions.map((sub) => (
                                      <option key={sub.residentName} value={sub.residentName}>
                                        {sub.residentName}
                                        {!available.includes(sub.residentName) ? ' (unavailable)' : ''}
                                      </option>
                                    ))}
                                  </select>
                                </td>
                              )
                            }

                            return (
                              <td
                                key={clinic}
                                className="px-4 py-3 cursor-pointer hover:bg-slate-50 group"
                                onClick={() => setEditingShiftId(shift.id)}
                              >
                                {resident ? (
                                  <span className="font-medium text-slate-800 group-hover:text-blue-600 transition-colors">
                                    {resident}
                                  </span>
                                ) : (
                                  <span className="text-red-400 text-xs italic">Unassigned</span>
                                )}
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── SWAPS TAB ── */}
      {tab === 'swaps' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          {swapRequests.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-sm">No swap requests yet.</div>
          ) : (
            <>
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-700">All Swap Requests</h2>
                <div className="flex gap-3 text-xs text-slate-400">
                  <span>{swapRequests.filter((r) => r.status === 'pending').length} pending</span>
                  <span>{swapRequests.filter((r) => r.status === 'accepted').length} accepted</span>
                  <span>{swapRequests.filter((r) => r.status === 'cancelled').length} cancelled</span>
                </div>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50">
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Requestor</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Shift offered</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Accepted by</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Shift received</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {swapRequests
                    .slice()
                    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
                    .map((req) => {
                      const offeredShift = shifts.find((s) => s.id === req.requestorShiftId)
                      const receivedShift = req.acceptorShiftId
                        ? shifts.find((s) => s.id === req.acceptorShiftId)
                        : null
                      return (
                        <tr key={req.id} className="border-b border-slate-100 last:border-0">
                          <td className="px-4 py-3">
                            <span
                              className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                                req.status === 'pending'
                                  ? 'bg-amber-100 text-amber-700'
                                  : req.status === 'accepted'
                                  ? 'bg-green-100 text-green-700'
                                  : 'bg-slate-100 text-slate-500'
                              }`}
                            >
                              {req.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 font-medium text-slate-800">{req.requestorName}</td>
                          <td className="px-4 py-3 text-slate-600">
                            {offeredShift ? (
                              <>
                                <div>{formatDate(offeredShift.date)}</div>
                                <div className="text-xs text-slate-400">{offeredShift.clinic}</div>
                              </>
                            ) : (
                              <span className="text-slate-300 text-xs">{req.requestorShiftId}</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-slate-600">{req.acceptorName ?? '—'}</td>
                          <td className="px-4 py-3 text-slate-600">
                            {receivedShift ? (
                              <>
                                <div>{formatDate(receivedShift.date)}</div>
                                <div className="text-xs text-slate-400">{receivedShift.clinic}</div>
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {req.status === 'pending' && (
                              <button
                                onClick={async () => {
                                  await fetch(`/api/swaps/${req.id}`, {
                                    method: 'PATCH',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ action: 'cancel' }),
                                  })
                                  await fetchData()
                                }}
                                className="text-xs text-red-400 hover:text-red-600 transition-colors"
                              >
                                Cancel
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  )
}
