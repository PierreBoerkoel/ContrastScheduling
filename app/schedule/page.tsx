'use client'

import { useEffect, useState, useCallback } from 'react'
import { useUser } from '@clerk/nextjs'
import type { Shift, Schedule, SwapRequest } from '@/lib/types'
import { CLINICS } from '@/lib/types'

function formatDate(dateStr: string) {
  return new Intl.DateTimeFormat('en-CA', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(dateStr))
}

function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso)
  )
}

export default function SchedulePage() {
  const { user } = useUser()
  const myName = user?.fullName ?? [user?.firstName, user?.lastName].filter(Boolean).join(' ') ?? ''

  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [shifts, setShifts] = useState<Shift[]>([])
  const [swapRequests, setSwapRequests] = useState<SwapRequest[]>([])
  const [loading, setLoading] = useState(true)

  // Claim unassigned shift
  const [claimingShiftId, setClaimingShiftId] = useState<string | null>(null)

  // Swap — request flow
  const [requestingShiftId, setRequestingShiftId] = useState<string | null>(null)
  const [submittingRequest, setSubmittingRequest] = useState(false)
  const [requestError, setRequestError] = useState('')

  // Swap — accept flow
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [acceptingShiftId, setAcceptingShiftId] = useState<string | null>(null)
  const [submittingAccept, setSubmittingAccept] = useState(false)
  const [acceptError, setAcceptError] = useState('')

  const fetchAll = useCallback(async () => {
    const [sched, shiftList, swaps] = await Promise.all([
      fetch('/api/schedule').then((r) => r.json()),
      fetch('/api/shifts').then((r) => r.json()),
      fetch('/api/swaps').then((r) => r.json()),
    ])
    setSchedule(sched)
    setShifts(shiftList)
    setSwapRequests(swaps)
    setLoading(false)
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  // Helpers
  const assignmentMap: Record<string, string | null> = {}
  if (schedule) {
    for (const a of schedule.assignments) assignmentMap[a.shiftId] = a.residentName
  }

  const shiftById = Object.fromEntries(shifts.map((s) => [s.id, s]))

  // Dates the current user is already assigned to
  const myAssignedDates = new Set(
    schedule?.assignments
      .filter((a) => a.residentName?.toLowerCase() === myName.toLowerCase())
      .map((a) => a.shiftId.split('|')[0]) ?? []
  )

  function myShifts() {
    if (!schedule || !myName) return []
    return schedule.assignments.filter(
      (a) => a.residentName?.toLowerCase() === myName.toLowerCase()
    )
  }

  function shiftLabel(shiftId: string) {
    const s = shiftById[shiftId]
    if (!s) return shiftId
    return `${formatDate(s.date)} — ${s.clinic}`
  }

  async function claimShift(shiftId: string) {
    setClaimingShiftId(shiftId)
    try {
      await fetch('/api/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shiftId }),
      })
      await fetchAll()
    } finally {
      setClaimingShiftId(null)
    }
  }

  async function requestSwap() {
    if (!requestingShiftId) return
    setSubmittingRequest(true)
    setRequestError('')
    try {
      const res = await fetch('/api/swaps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestorShiftId: requestingShiftId }),
      })
      if (!res.ok) {
        const data = await res.json()
        setRequestError(data.error ?? 'Request failed')
      } else {
        setRequestingShiftId(null)
        await fetchAll()
      }
    } finally {
      setSubmittingRequest(false)
    }
  }

  async function acceptSwap() {
    if (!acceptingId || !acceptingShiftId) return
    setSubmittingAccept(true)
    setAcceptError('')
    try {
      const res = await fetch(`/api/swaps/${acceptingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'accept', acceptorShiftId: acceptingShiftId }),
      })
      if (!res.ok) {
        const data = await res.json()
        setAcceptError(data.error ?? 'Accept failed')
      } else {
        setAcceptingId(null)
        setAcceptingShiftId(null)
        await fetchAll()
      }
    } finally {
      setSubmittingAccept(false)
    }
  }

  async function cancelSwap(swapId: string) {
    await fetch(`/api/swaps/${swapId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    })
    await fetchAll()
  }

  // Grouped schedule data
  const byDate = shifts.reduce<Record<string, Shift[]>>((acc, s) => {
    ;(acc[s.date] ??= []).push(s)
    return acc
  }, {})
  const sortedDates = Object.keys(byDate).sort()

  const counts: Record<string, number> = {}
  if (schedule) {
    for (const a of schedule.assignments) {
      if (a.residentName) counts[a.residentName] = (counts[a.residentName] ?? 0) + 1
    }
  }

  const pendingSwaps = swapRequests.filter((r) => r.status === 'pending')

  if (loading) {
    return <div className="max-w-4xl mx-auto px-4 py-16 text-slate-400 text-sm">Loading…</div>
  }

  if (!schedule?.isPublished) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <div className="text-5xl mb-4">📋</div>
        <h2 className="text-xl font-bold text-slate-700 mb-2">No schedule published yet</h2>
        <p className="text-slate-400 text-sm">
          The admin will publish the schedule once all availability has been collected. Check back
          soon.
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-10 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-800 mb-1">Published Schedule</h1>
        <p className="text-xs text-slate-400">
          Published {formatDateTime(schedule.publishedAt!)}
        </p>
      </div>

      {/* Shift totals */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <h2 className="text-sm font-semibold text-slate-600 mb-3">Shift totals per resident</h2>
        <div className="flex flex-wrap gap-3">
          {Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([resident, count]) => (
              <span
                key={resident}
                className="inline-flex items-center gap-1.5 bg-blue-50 text-blue-800 text-sm px-3 py-1 rounded-full"
              >
                <span className="font-medium">{resident}</span>
                <span className="text-blue-400 text-xs">{count} shift{count !== 1 ? 's' : ''}</span>
              </span>
            ))}
        </div>
      </div>

      {/* Schedule grid */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-x-auto overflow-y-auto max-h-[70vh]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-slate-100 bg-slate-50">
              <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Date</th>
              {CLINICS.map((clinic) => (
                <th key={clinic} className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">
                  {clinic}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedDates.map((date) => (
              <tr key={date} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3 font-medium text-slate-700 whitespace-nowrap">
                  {formatDate(date)}
                </td>
                {CLINICS.map((clinic) => {
                  const shift = byDate[date]?.find((s) => s.clinic === clinic)
                  if (!shift) return <td key={clinic} className="px-4 py-3 text-slate-200">—</td>
                  const resident = assignmentMap[shift.id]
                  const hasPendingSwap = pendingSwaps.some((r) => r.requestorShiftId === shift.id)
                  const isClaiming = claimingShiftId === shift.id
                  const shiftDate = shift.id.split('|')[0]
                  const alreadyOnDay = myAssignedDates.has(shiftDate)
                  return (
                    <td key={clinic} className="px-4 py-3">
                      {resident ? (
                        <>
                          <span className="font-medium text-slate-800">{resident}</span>
                          {hasPendingSwap && (
                            <span className="ml-2 text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">
                              swap pending
                            </span>
                          )}
                        </>
                      ) : (
                        <button
                          onClick={() => claimShift(shift.id)}
                          disabled={isClaiming || alreadyOnDay}
                          title={alreadyOnDay ? 'You are already scheduled on this day' : undefined}
                          className="text-xs font-medium border rounded px-2 py-0.5 transition-colors disabled:cursor-not-allowed
                            enabled:text-blue-600 enabled:border-blue-200 enabled:hover:text-blue-700 enabled:hover:border-blue-400
                            disabled:text-slate-400 disabled:border-slate-200"
                        >
                          {isClaiming ? 'Taking…' : 'Take shift'}
                        </button>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── REQUEST A SWAP ── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 bg-slate-50">
          <h2 className="text-base font-semibold text-slate-700">Request a Shift Swap</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Select one of your assigned shifts to offer for swap.
          </p>
        </div>
        <div className="p-5">
          {myShifts().length === 0 ? (
            <p className="text-sm text-slate-400">You have no assigned shifts.</p>
          ) : (
            <div className="space-y-2">
              {myShifts().map((a) => {
                const alreadyPending = pendingSwaps.some((r) => r.requestorShiftId === a.shiftId)
                return (
                  <div
                    key={a.shiftId}
                    className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-2.5"
                  >
                    <span className="text-sm text-slate-700">{shiftLabel(a.shiftId)}</span>
                    {alreadyPending ? (
                      <span className="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded-full">
                        Swap requested
                      </span>
                    ) : (
                      <button
                        onClick={() => { setRequestingShiftId(a.shiftId); setRequestError('') }}
                        className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                      >
                        Request swap
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {requestingShiftId && (
            <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-sm text-amber-800 mb-3">
                Post a swap request for <strong>{shiftLabel(requestingShiftId)}</strong>?
                Anyone can accept by offering one of their shifts in return.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={requestSwap}
                  disabled={submittingRequest}
                  className="bg-amber-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-600 disabled:opacity-40 transition-colors"
                >
                  {submittingRequest ? 'Submitting…' : 'Confirm request'}
                </button>
                <button
                  onClick={() => { setRequestingShiftId(null); setRequestError('') }}
                  className="text-sm text-slate-500 px-3 py-2 rounded-lg hover:bg-slate-100"
                >
                  Cancel
                </button>
              </div>
              {requestError && <p className="mt-2 text-sm text-red-500">{requestError}</p>}
            </div>
          )}
        </div>
      </div>

      {/* ── PENDING SWAP REQUESTS ── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-700">
            Pending Swap Requests
          </h2>
          <span className="text-xs text-slate-400">
            {pendingSwaps.length} pending
          </span>
        </div>

        {pendingSwaps.length === 0 ? (
          <p className="p-5 text-sm text-slate-400">No pending swap requests.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {pendingSwaps.map((req) => (
              <div key={req.id} className="p-5">
                <p className="text-sm text-slate-700 mb-1">
                  <strong>{req.requestorName}</strong> wants to swap{' '}
                  <span className="font-medium text-slate-800">{shiftLabel(req.requestorShiftId)}</span>
                </p>
                <p className="text-xs text-slate-400 mb-3">
                  Requested {formatDateTime(req.requestedAt)}
                </p>

                {acceptingId === req.id ? (
                  <div className="bg-green-50 border border-green-200 rounded-lg p-4 space-y-3">
                    <p className="text-sm text-green-800">
                      Select one of your shifts to offer in return:
                    </p>
                    {myShifts().filter((a) => a.shiftId !== req.requestorShiftId).length === 0 ? (
                      <p className="text-sm text-slate-400">You have no other shifts to offer.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {myShifts()
                          .filter((a) => a.shiftId !== req.requestorShiftId)
                          .map((a) => (
                            <label
                              key={a.shiftId}
                              className="flex items-center gap-3 cursor-pointer rounded-lg border border-slate-200 px-3 py-2 hover:bg-green-50"
                            >
                              <input
                                type="radio"
                                name={`accept-${req.id}`}
                                value={a.shiftId}
                                checked={acceptingShiftId === a.shiftId}
                                onChange={() => setAcceptingShiftId(a.shiftId)}
                                className="accent-green-600"
                              />
                              <span className="text-sm text-slate-700">{shiftLabel(a.shiftId)}</span>
                            </label>
                          ))}
                      </div>
                    )}
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={acceptSwap}
                        disabled={!acceptingShiftId || submittingAccept}
                        className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-40 transition-colors"
                      >
                        {submittingAccept ? 'Accepting…' : 'Confirm swap'}
                      </button>
                      <button
                        onClick={() => {
                          setAcceptingId(null)
                          setAcceptingShiftId(null)
                          setAcceptError('')
                        }}
                        className="text-sm text-slate-500 px-3 py-2 rounded-lg hover:bg-slate-100"
                      >
                        Cancel
                      </button>
                    </div>
                    {acceptError && <p className="text-sm text-red-500">{acceptError}</p>}
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setAcceptingId(req.id)
                        setAcceptingShiftId(null)
                        setAcceptError('')
                      }}
                      className="bg-green-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors"
                    >
                      Accept swap
                    </button>
                    <button
                      onClick={() => cancelSwap(req.id)}
                      className="text-sm text-slate-400 hover:text-red-500 px-2 py-1.5 transition-colors"
                    >
                      Cancel request
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent / completed swaps */}
      {swapRequests.some((r) => r.status !== 'pending') && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 bg-slate-50">
            <h2 className="text-sm font-semibold text-slate-600">Completed & Cancelled Swaps</h2>
          </div>
          <div className="divide-y divide-slate-100">
            {swapRequests
              .filter((r) => r.status !== 'pending')
              .sort((a, b) => (b.acceptedAt ?? b.requestedAt).localeCompare(a.acceptedAt ?? a.requestedAt))
              .map((req) => (
                <div key={req.id} className="px-5 py-3 flex items-center gap-3 text-sm text-slate-600">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      req.status === 'accepted'
                        ? 'bg-green-100 text-green-700'
                        : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {req.status}
                  </span>
                  <span>
                    {req.requestorName} &harr;{' '}
                    {req.status === 'accepted' ? req.acceptorName : '–'}
                    {' · '}
                    {shiftLabel(req.requestorShiftId)}
                    {req.acceptorShiftId && req.status === 'accepted' && (
                      <> ↔ {shiftLabel(req.acceptorShiftId)}</>
                    )}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
