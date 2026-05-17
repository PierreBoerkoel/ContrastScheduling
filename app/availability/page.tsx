'use client'

import { useEffect, useState } from 'react'
import { useUser } from '@clerk/nextjs'
import type { Shift, ClinicName, Schedule } from '@/lib/types'
import { CLINICS } from '@/lib/types'

function formatDate(dateStr: string) {
  return new Intl.DateTimeFormat('en-CA', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(dateStr))
}

export default function AvailabilityPage() {
  const { user, isLoaded } = useUser()
  const [shifts, setShifts] = useState<Shift[]>([])
  const [schedule, setSchedule] = useState<Schedule | null>(null)
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
    ]).then(([shiftList, submissions, sched]: [Shift[], { residentName: string; availableShiftIds: string[] }[], Schedule]) => {
      setShifts(shiftList)
      setSchedule(sched)
      const existing = submissions.find(
        (s) => s.residentName?.toLowerCase() === (user?.fullName ?? '').toLowerCase()
      )
      if (existing) setSelected(new Set(existing.availableShiftIds))
      setLoading(false)
    })
  }, [user])

  function toggleShift(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function handleSubmit() {
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ availableShiftIds: Array.from(selected) }),
      })
      if (!res.ok) throw new Error('Submission failed')
      setSubmitted(true)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // Group shifts by date
  const byDate = shifts.reduce<Record<string, Shift[]>>((acc, shift) => {
    ;(acc[shift.date] ??= []).push(shift)
    return acc
  }, {})
  const sortedDates = Object.keys(byDate).sort()

  if (!isLoaded) return null

  const publishedIds = new Set((schedule?.assignments ?? []).map((a) => a.shiftId))
  const isLocked = !loading && !!schedule?.isPublished && shifts.some((s) => publishedIds.has(s.id))

  if (isLocked) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <div className="text-5xl mb-4">🔒</div>
        <h2 className="text-xl font-bold text-slate-700 mb-2">Availability locked</h2>
        <p className="text-slate-400 text-sm">
          The schedule has been published. Availability submissions are closed for this period.
          Contact the admin if you need to make changes.
        </p>
      </div>
    )
  }

  if (submitted) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <div className="text-5xl mb-4">✅</div>
        <h2 className="text-2xl font-bold text-slate-800 mb-2">Availability submitted!</h2>
        <p className="text-slate-500 mb-6">
          Thank you, <strong>{user?.fullName ?? user?.firstName}</strong>. Your availability has been
          saved. You can resubmit at any time to update your selections.
        </p>
        <button
          onClick={() => setSubmitted(false)}
          className="text-blue-600 underline text-sm"
        >
          Update my availability
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <h1 className="text-2xl font-bold text-slate-800 mb-1">Submit Availability</h1>
      <p className="text-slate-500 mb-6 text-sm">
        Mark the shifts you are available to cover. You can only be assigned to one clinic per day.
        Submitting again will update your previous response.
      </p>

      <div className="flex items-center gap-2 mb-6 bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-sm text-blue-800">
        Submitting as <strong>{user?.fullName ?? user?.firstName ?? user?.emailAddresses[0]?.emailAddress}</strong>
      </div>

      {loading ? (
        <p className="text-slate-400 text-sm">Loading shifts…</p>
      ) : sortedDates.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center text-slate-400 text-sm">
          No shifts have been set up yet. Check back once the admin has created the scheduling period.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50">
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Date</th>
                  {CLINICS.map((clinic) => (
                    <th key={clinic} className="text-center px-3 py-3 font-medium text-slate-600 whitespace-nowrap">
                      {clinic}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedDates.map((date) => {
                  const shiftsOnDay = byDate[date]
                  return (
                    <tr key={date} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3 text-slate-700 whitespace-nowrap">
                        {formatDate(date)}
                      </td>
                      {CLINICS.map((clinic: ClinicName) => {
                        const shift = shiftsOnDay.find((s) => s.clinic === clinic)
                        if (!shift) {
                          return (
                            <td key={clinic} className="text-center px-3 py-3 text-slate-200">
                              —
                            </td>
                          )
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
        </div>
      )}

      <div className="mt-6 flex items-center gap-4">
        <button
          onClick={handleSubmit}
          disabled={submitting || sortedDates.length === 0}
          className="bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          {submitting ? 'Submitting…' : 'Submit Availability'}
        </button>
        <span className="text-sm text-slate-400">
          {selected.size} shift{selected.size !== 1 ? 's' : ''} selected
        </span>
        {error && <span className="text-sm text-red-500">{error}</span>}
      </div>
    </div>
  )
}
