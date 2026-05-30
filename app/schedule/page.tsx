'use client'

import { useEffect, useState, useCallback } from 'react'
import { useUser } from '@clerk/nextjs'
import type { Shift, SwapRequest, ClinicName, SchedulingPeriod, ShiftSplit, Clinic } from '@/lib/types'
import { formatTimeRange, computeCoverageSegments, buildDisplayNames } from '@/lib/types'

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

function formatTime(t: string): string {
  const [h, m] = t.split(':').map(Number)
  const ampm = h < 12 ? 'AM' : 'PM'
  const hour = h % 12 || 12
  return m === 0 ? `${hour} ${ampm}` : `${hour}:${m.toString().padStart(2, '0')} ${ampm}`
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function splitFraction(offeredStart: string, offeredEnd: string, shiftStart?: string, shiftEnd?: string): number {
  if (!shiftStart || !shiftEnd) return 0.5
  const shiftDur = timeToMinutes(shiftEnd) - timeToMinutes(shiftStart)
  if (shiftDur <= 0) return 0.5
  const splitDur = timeToMinutes(offeredEnd) - timeToMinutes(offeredStart)
  return Math.max(0, Math.min(1, splitDur / shiftDur))
}

function formatShiftCount(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? `${r}` : r.toFixed(1)
}

function minutesToTime(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
}

function thirtyMinSlots(start: string, end: string): string[] {
  const s = timeToMinutes(start)
  const e = timeToMinutes(end)
  const slots: string[] = []
  for (let t = s; t <= e; t += 30) slots.push(minutesToTime(t))
  return slots
}

function isShiftStarted(shift: { date: string; startTime?: string }): boolean {
  if (shift.startTime) {
    return new Date() >= new Date(`${shift.date}T${shift.startTime}:00`)
  }
  return new Date().toISOString().split('T')[0] > shift.date
}

function daysUntil(dateStr: string): number {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.round((new Date(dateStr + 'T00:00:00').getTime() - now.getTime()) / 86400000)
}

function getWeekKey(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  const day = d.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().split('T')[0]
}

function formatWeekRange(weekKey: string): string {
  const start = new Date(weekKey + 'T00:00:00Z')
  const end = new Date(weekKey + 'T00:00:00Z')
  end.setUTCDate(end.getUTCDate() + 6)
  const fmt = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return `${fmt.format(start)} – ${fmt.format(end)}`
}

export default function SchedulePage() {
  const { user } = useUser()
  const myName = user?.fullName ?? [user?.firstName, user?.lastName].filter(Boolean).join(' ') ?? ''
  const myUserId = user?.id ?? ''

  const [shifts, setShifts] = useState<Shift[]>([])
  const [swapRequests, setSwapRequests] = useState<SwapRequest[]>([])
  const [periods, setPeriods] = useState<SchedulingPeriod[]>([])
  const [splits, setSplits] = useState<ShiftSplit[]>([])
  const [userNames, setUserNames] = useState<Record<string, string>>({})
  const [clinics, setClinics] = useState<Clinic[]>([])
  const clinicNames = clinics.map((c) => c.name)
  const clinicAbbr = Object.fromEntries(clinics.map((c) => [c.name, c.abbreviation]))
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Claim unassigned shift (also handles same-day swap)
  const [pendingClaimShiftId, setPendingClaimShiftId] = useState<string | null>(null)
  const [claimingShiftId, setClaimingShiftId] = useState<string | null>(null)

  // Whole-shift offer flow
  const [requestingShiftId, setRequestingShiftId] = useState<string | null>(null)
  const [submittingRequest, setSubmittingRequest] = useState(false)
  const [requestError, setRequestError] = useState('')

  // Whole-shift offer accept flow
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [submittingAccept, setSubmittingAccept] = useState(false)
  const [acceptError, setAcceptError] = useState('')

  // Split portion offer flow
  const [splittingShiftId, setSplittingShiftId] = useState<string | null>(null)
  const [splitStart, setSplitStart] = useState('')
  const [splitEnd, setSplitEnd] = useState('')
  const [submittingSplit, setSubmittingSplit] = useState(false)
  const [splitError, setSplitError] = useState('')

  // Split portion accept flow
  const [acceptingSplitId, setAcceptingSplitId] = useState<string | null>(null)
  const [submittingSplitAccept, setSubmittingSplitAccept] = useState(false)
  const [splitAcceptError, setSplitAcceptError] = useState('')

  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set())

  const fetchAll = useCallback(async () => {
    const [shiftList, swaps, periodList, splitList, names, clinicList] = await Promise.all([
      fetch('/api/shifts').then((r) => r.json()),
      fetch('/api/swaps').then((r) => r.json()),
      fetch('/api/periods').then((r) => r.json()),
      fetch('/api/splits').then((r) => r.json()),
      fetch('/api/users/names').then((r) => r.json()),
      fetch('/api/admin/clinic-defaults').then((r) => r.json()),
    ])
    if (Array.isArray(shiftList)) setShifts(shiftList)
    if (Array.isArray(swaps)) setSwapRequests(swaps)
    if (Array.isArray(periodList)) setPeriods(periodList)
    if (Array.isArray(splitList)) setSplits(splitList)
    if (names && typeof names === 'object' && !names.error) setUserNames(names)
    if (Array.isArray(clinicList)) setClinics(clinicList)
    setLoading(false)
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const today = new Date().toISOString().split('T')[0]
  const upcomingPeriods = periods.filter((p) => p.endDate >= today && p.publishedAt)
  const effectivePeriodId = selectedPeriodId ?? upcomingPeriods[0]?.id ?? null
  const selectedPeriod = upcomingPeriods.find((p) => p.id === effectivePeriodId) ?? null

  const shiftById = Object.fromEntries(shifts.map((s) => [s.id, s]))

  const filteredPublished = selectedPeriod?.publishedAssignments ?? []

  const assignmentMap: Record<string, string | null> = {}
  for (const a of filteredPublished) assignmentMap[a.shiftId] = a.residentName

  const myAssignedDates = new Set(
    filteredPublished
      .filter((a) => a.userId === myUserId)
      .map((a) => shiftById[a.shiftId]?.date ?? '')
  )

  // Splits indexed by shift ID
  const splitsByShift: Record<string, ShiftSplit[]> = {}
  for (const s of splits) (splitsByShift[s.shiftId] ??= []).push(s)

  // Dates where the user's accepted splits cover the entire shift window
  const mySplitFullShiftDates = new Set<string>()
  if (myUserId) {
    for (const a of filteredPublished) {
      const shift = shiftById[a.shiftId]
      if (!shift?.startTime || !shift?.endTime) continue
      const segments = computeCoverageSegments(shift, a.residentName, splitsByShift[a.shiftId] ?? [], a.userId)
      const mySegs = segments.filter((seg) => seg.userId === myUserId)
      if (mySegs.length === 0) continue
      const ownedStart = mySegs.reduce((min, s) => s.start < min ? s.start : min, mySegs[0].start)
      const ownedEnd = mySegs.reduce((max, s) => s.end > max ? s.end : max, mySegs[0].end)
      if (ownedStart === shift.startTime && ownedEnd === shift.endTime) {
        mySplitFullShiftDates.add(shift.date)
      }
    }
  }

  // Dates where the user is the primary assignee but has given away 100% of their shift through chained splits
  const myFullyGivenAwayDates = new Set<string>()
  if (myUserId) {
    for (const a of filteredPublished) {
      if (a.userId !== myUserId) continue
      const shift = shiftById[a.shiftId]
      if (!shift?.startTime || !shift?.endTime) continue
      const segments = computeCoverageSegments(shift, a.residentName, splitsByShift[a.shiftId] ?? [], a.userId)
      const mySegs = segments.filter((seg) => seg.userId === myUserId)
      if (mySegs.length === 0) myFullyGivenAwayDates.add(shift.date)
    }
  }

  function myShifts() {
    if (!myUserId) return []
    return filteredPublished.filter((a) => a.userId === myUserId)
  }

  // Shifts where the current user is a split acceptor — one entry per shift (deduplicated)
  function mySplitAcceptances() {
    if (!myUserId) return []
    const seen = new Set<string>()
    return splits.filter((s) => {
      if (s.status !== 'accepted') return false
      if (s.acceptorUserId !== myUserId) return false
      if (!filteredPublished.some((a) => a.shiftId === s.shiftId)) return false
      if (seen.has(s.shiftId)) return false
      seen.add(s.shiftId)
      return true
    })
  }

  // Compute the window this user currently owns on a given shift (for the split offer UI).
  // Uses computeCoverageSegments so sub-splits given away are correctly excluded.
  function getMyOwnedWindow(shiftId: string): { start: string; end: string } | null {
    const shift = shiftById[shiftId]
    if (!shift?.startTime || !shift?.endTime) return null
    const assignedResident = assignmentMap[shiftId] ?? null
    const assignment = filteredPublished.find((a) => a.shiftId === shiftId)
    const segments = computeCoverageSegments(shift, assignedResident, splitsByShift[shiftId] ?? [], assignment?.userId)
    const mySegments = segments.filter((s) => s.userId === myUserId)
    if (mySegments.length === 0) return null
    const ownedStart = mySegments.reduce((min, s) => s.start < min ? s.start : min, mySegments[0].start)
    const ownedEnd = mySegments.reduce((max, s) => s.end > max ? s.end : max, mySegments[0].end)
    return { start: ownedStart, end: ownedEnd }
  }

  function shiftLabel(shiftId: string) {
    const s = shiftById[shiftId]
    if (s) return `${formatDate(s.date)} — ${s.clinic}`
    return shiftId
  }

  async function claimShift(shiftId: string, swap?: boolean) {
    setClaimingShiftId(shiftId)
    try {
      await fetch('/api/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shiftId, ...(swap ? { swap: true } : {}) }),
      })
      setPendingClaimShiftId(null)
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

  async function acceptOffer(offerId: string, swap?: boolean) {
    setSubmittingAccept(true)
    setAcceptError('')
    try {
      const res = await fetch(`/api/swaps/${offerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'accept', ...(swap ? { swap: true } : {}) }),
      })
      if (!res.ok) {
        const data = await res.json()
        setAcceptError(data.error ?? 'Accept failed')
      } else {
        setAcceptingId(null)
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

  async function postSplitOffer() {
    if (!splittingShiftId || !splitStart || !splitEnd) return
    setSubmittingSplit(true)
    setSplitError('')
    try {
      const res = await fetch('/api/splits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shiftId: splittingShiftId, offeredStart: splitStart, offeredEnd: splitEnd }),
      })
      if (!res.ok) {
        const data = await res.json()
        setSplitError(data.error ?? 'Failed to post offer')
      } else {
        setSplittingShiftId(null)
        setSplitStart('')
        setSplitEnd('')
        await fetchAll()
      }
    } finally {
      setSubmittingSplit(false)
    }
  }

  async function acceptSplit(splitId: string, swap?: boolean) {
    setSubmittingSplitAccept(true)
    setSplitAcceptError('')
    try {
      const res = await fetch(`/api/splits/${splitId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'accept', ...(swap ? { swap: true } : {}) }),
      })
      if (!res.ok) {
        const data = await res.json()
        setSplitAcceptError(data.error ?? 'Accept failed')
      } else {
        setAcceptingSplitId(null)
        await fetchAll()
      }
    } finally {
      setSubmittingSplitAccept(false)
    }
  }

  async function cancelSplit(splitId: string) {
    await fetch(`/api/splits/${splitId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    })
    await fetchAll()
  }

  const byDate: Record<string, Shift[]> = {}
  for (const a of filteredPublished) {
    const shift = shiftById[a.shiftId]
    if (!shift) continue
    ;(byDate[shift.date] ??= []).push(shift)
  }
  const sortedDates = Object.keys(byDate).sort()

  const weekGroups: { key: string; dates: string[] }[] = []
  {
    const seen: Record<string, string[]> = {}
    for (const date of sortedDates) {
      const k = getWeekKey(date)
      if (!seen[k]) { seen[k] = []; weekGroups.push({ key: k, dates: seen[k] }) }
      seen[k].push(date)
    }
  }

  function toggleWeek(key: string) {
    setExpandedWeeks((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Stable key per person: userId when available, name for legacy records
  const cKey = (userId: string | null | undefined, name: string | null | undefined) => userId ?? name ?? ''

  // Last known name for each userId, sourced from stored data — used as fallback when a user is deleted from Clerk
  const storedNameByUserId: Record<string, string> = {}
  for (const a of filteredPublished) {
    if (a.userId && a.residentName) storedNameByUserId[a.userId] = a.residentName
  }
  for (const sp of splits) {
    if (sp.offerorUserId && sp.offerorName) storedNameByUserId[sp.offerorUserId] = sp.offerorName
    if (sp.acceptorUserId && sp.acceptorName) storedNameByUserId[sp.acceptorUserId] = sp.acceptorName
  }
  for (const req of swapRequests) {
    if (req.requestorUserId && req.requestorName) storedNameByUserId[req.requestorUserId] = req.requestorName
    if (req.acceptorUserId && req.acceptorName) storedNameByUserId[req.acceptorUserId] = req.acceptorName
  }

  const cName = (key: string) => userNames[key] ?? storedNameByUserId[key] ?? key

  const currentNameFor = (userId: string | null | undefined, fallback: string | null | undefined): string =>
    (userId && userNames[userId]) ? userNames[userId] : (fallback ?? '')

  const counts: Record<string, number> = {}
  for (const a of filteredPublished) {
    if (!a.residentName && !a.userId) continue
    const k = cKey(a.userId, a.residentName)
    counts[k] = (counts[k] ?? 0) + 1
  }
  const filteredShiftIds = new Set(filteredPublished.map((a) => a.shiftId))
  for (const sp of splits) {
    if (sp.status !== 'accepted' || !sp.acceptorName) continue
    if (!filteredShiftIds.has(sp.shiftId)) continue
    const shift = shiftById[sp.shiftId]
    const frac = splitFraction(sp.offeredStart, sp.offeredEnd, shift?.startTime, shift?.endTime)
    const offerorKey = cKey(sp.offerorUserId, sp.offerorName)
    const acceptorKey = cKey(sp.acceptorUserId, sp.acceptorName)
    counts[offerorKey] = (counts[offerorKey] ?? 0) - frac
    counts[acceptorKey] = (counts[acceptorKey] ?? 0) + frac
  }

  const periodShiftIds = new Set(shifts.filter((s) => s.periodId === selectedPeriod?.id).map((s) => s.id))

  const allNamesInView = new Set<string>()
  for (const a of filteredPublished) {
    const n = currentNameFor(a.userId, a.residentName)
    if (n) allNamesInView.add(n)
  }
  for (const sp of splits) {
    if (sp.status === 'accepted' && filteredPublished.some((a) => a.shiftId === sp.shiftId)) {
      const offerorN = currentNameFor(sp.offerorUserId, sp.offerorName)
      if (offerorN) allNamesInView.add(offerorN)
      const acceptorN = currentNameFor(sp.acceptorUserId, sp.acceptorName)
      if (acceptorN) allNamesInView.add(acceptorN)
    }
  }
  for (const req of swapRequests) {
    if (!periodShiftIds.has(req.requestorShiftId)) continue
    const n = currentNameFor(req.requestorUserId, req.requestorName)
    if (n) allNamesInView.add(n)
    if (req.acceptorUserId || req.acceptorName) {
      const n2 = currentNameFor(req.acceptorUserId, req.acceptorName)
      if (n2) allNamesInView.add(n2)
    }
  }
  for (const sp of splits) {
    if (!periodShiftIds.has(sp.shiftId)) continue
    const n = currentNameFor(sp.offerorUserId, sp.offerorName)
    if (n) allNamesInView.add(n)
    if (sp.acceptorUserId || sp.acceptorName) {
      const n2 = currentNameFor(sp.acceptorUserId, sp.acceptorName)
      if (n2) allNamesInView.add(n2)
    }
  }
  const displayMap = buildDisplayNames([...allNamesInView])
  const dn = (userId: string | null | undefined, fallback: string | null | undefined) => {
    const full = currentNameFor(userId, fallback)
    return displayMap[full] ?? full
  }

  const pendingSwaps = swapRequests.filter((r) => r.status === 'pending')
  const pendingSplits = splits.filter((s) => s.status === 'pending')

  // Period-scoped versions for the offer display sections (grid badges use unscoped versions)
  const periodPendingSwaps = pendingSwaps.filter((r) => periodShiftIds.has(r.requestorShiftId))
  const periodPendingSplits = pendingSplits.filter((s) => periodShiftIds.has(s.shiftId))
  const periodCompletedSwaps = swapRequests.filter((r) => r.status !== 'pending' && periodShiftIds.has(r.requestorShiftId))
  const periodCompletedSplits = splits.filter((s) => s.status !== 'pending' && periodShiftIds.has(s.shiftId))

  // Renders the assignment content for a shift cell (used in both mobile cards and desktop table)
  const renderShiftContent = (shift: Shift) => {
    const resident = assignmentMap[shift.id]
    const hasPendingSwap = pendingSwaps.some((r) => r.requestorShiftId === shift.id)
    const shiftSplits = splitsByShift[shift.id] ?? []
    const hasPendingSplitOffer = shiftSplits.some((s) => s.status === 'pending')
    const isClaiming = claimingShiftId === shift.id
    const shiftDate = shift.date
    const alreadyOnDay = (myAssignedDates.has(shiftDate) && !myFullyGivenAwayDates.has(shiftDate)) || mySplitFullShiftDates.has(shiftDate)
    const hasGivenAwayPortionOnDay = !!myUserId && splits.some(
      (sp) => sp.status === 'accepted' && sp.offerorUserId === myUserId &&
        shiftById[sp.shiftId]?.date === shiftDate
    )
    const hasOverlappingSplit = !!shift.startTime && !!shift.endTime && !!myUserId &&
      splits.some(
        (sp) => sp.status === 'accepted' && sp.acceptorUserId === myUserId &&
          shiftById[sp.shiftId]?.date === shiftDate &&
          sp.shiftId !== shift.id &&
          timeToMinutes(shift.startTime!) < timeToMinutes(sp.offeredEnd) &&
          timeToMinutes(sp.offeredStart) < timeToMinutes(shift.endTime!)
      )

    if (resident) {
      const assignment = filteredPublished.find((a) => a.shiftId === shift.id)
      const segments = computeCoverageSegments(shift, resident, shiftSplits, assignment?.userId)
      return (
        <div className={segments.length > 1 ? 'space-y-1.5' : ''}>
          {segments.map((seg, i) => {
            const segName = currentNameFor(seg.userId, seg.residentName)
            return (
              <div key={i} className={segments.length > 1 ? 'border-b border-slate-100 last:border-0 pb-1.5 last:pb-0' : ''}>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-medium text-slate-800">{displayMap[segName] ?? segName}</span>
                  {hasPendingSwap && i === 0 && segments.length === 1 && (
                    <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">Shift offered</span>
                  )}
                </div>
                {seg.start && seg.end && (
                  <div className="text-xs text-slate-400 mt-0.5">{formatTimeRange(seg.start, seg.end)}</div>
                )}
              </div>
            )
          })}
          {hasPendingSplitOffer && (
            <div className="text-xs text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded-full inline-block mt-0.5">Split offered</div>
          )}
        </div>
      )
    }

    if (alreadyOnDay) {
      if (daysUntil(shiftDate) <= 7) {
        return <span className="text-xs text-slate-300">—</span>
      }
      if (hasGivenAwayPortionOnDay) {
        return (
          <button disabled className="text-xs font-medium border rounded px-2 py-0.5 cursor-not-allowed text-slate-300 border-slate-200">
            Claim shift
          </button>
        )
      }
      if (pendingClaimShiftId === shift.id) {
        return (
          <div className="flex gap-1.5 items-center">
            <button onClick={() => claimShift(shift.id, true)} disabled={claimingShiftId === shift.id}
              className="text-xs font-medium bg-blue-600 text-white rounded px-2 py-0.5 hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              {claimingShiftId === shift.id ? 'Claiming…' : 'Claim'}
            </button>
            <button onClick={() => setPendingClaimShiftId(null)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
          </div>
        )
      }
      return (
        <button onClick={() => setPendingClaimShiftId(shift.id)}
          className="text-xs font-medium border rounded px-2 py-0.5 transition-colors text-blue-600 border-blue-200 hover:text-blue-700 hover:border-blue-400"
        >
          Claim shift
        </button>
      )
    }

    if (isShiftStarted(shift)) return <span className="text-xs text-slate-300">—</span>

    if (hasOverlappingSplit) {
      return (
        <button disabled className="text-xs font-medium border rounded px-2 py-0.5 cursor-not-allowed text-slate-300 border-slate-200">
          Claim shift
        </button>
      )
    }

    if (pendingClaimShiftId === shift.id) {
      return (
        <div className="flex gap-1.5 items-center">
          <button onClick={() => claimShift(shift.id)} disabled={isClaiming}
            className="text-xs font-medium bg-blue-600 text-white rounded px-2 py-0.5 hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            {isClaiming ? 'Claiming…' : 'Claim'}
          </button>
          <button onClick={() => setPendingClaimShiftId(null)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
        </div>
      )
    }

    return (
      <button onClick={() => setPendingClaimShiftId(shift.id)}
        className="text-xs font-medium border rounded px-2 py-0.5 transition-colors text-blue-600 border-blue-200 hover:text-blue-700 hover:border-blue-400"
      >
        Claim shift
      </button>
    )
  }

  if (loading) {
    return <div className="max-w-4xl mx-auto px-4 py-16 text-slate-400 text-sm">Loading…</div>
  }

  if (upcomingPeriods.length === 0) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center mb-4 mx-auto">
          <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-slate-700 mb-2">No schedule published yet</h2>
        <p className="text-slate-400 text-sm">
          The admin will publish the schedule once all availability has been collected. Check back
          soon.
        </p>
      </div>
    )
  }

  if (upcomingPeriods.length > 0 && filteredPublished.length === 0) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-10 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 mb-3">Published Schedule</h1>
          {upcomingPeriods.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              {upcomingPeriods.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedPeriodId(p.id)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${
                    effectivePeriodId === p.id
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div>{p.name}</div>
                  <div className={`text-xs font-normal ${effectivePeriodId === p.id ? 'text-blue-100' : 'text-slate-400'}`}>
                    {formatDate(p.startDate)} – {formatDate(p.endDate)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="max-w-xl text-center mx-auto py-8">
          <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center mb-4 mx-auto">
            <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-slate-700 mb-2">No schedule for this period yet</h2>
          <p className="text-slate-400 text-sm">The admin hasn&apos;t published a schedule for this period. Check back soon.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-10 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-800 mb-3">Published Schedule</h1>
        {upcomingPeriods.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap mb-2">
            {upcomingPeriods.map((p) => (
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
                  {formatDate(p.startDate)} – {formatDate(p.endDate)}
                </div>
              </button>
            ))}
          </div>
        )}
        <div className="text-xs text-slate-400 space-y-0.5">
          {selectedPeriod?.publishedAt && (
            <p>Published {formatDateTime(selectedPeriod.publishedAt)}</p>
          )}
          {selectedPeriod?.updatedAt && (
            <p>Updated {formatDateTime(selectedPeriod.updatedAt)}</p>
          )}
        </div>
      </div>

      {/* Shift totals */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <h2 className="text-sm font-semibold text-slate-600 mb-3">Shift totals per resident</h2>
        <div className="flex flex-wrap gap-3">
          {Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([key, count]) => (
              <span
                key={key}
                className="inline-flex items-center gap-1.5 bg-blue-50 text-blue-800 text-sm px-3 py-1 rounded-full"
              >
                <span className="font-medium">{displayMap[cName(key)] ?? cName(key)}</span>
                <span className="text-blue-400 text-xs">{formatShiftCount(count)} shift{count === 1 ? '' : 's'}</span>
              </span>
            ))}
        </div>
      </div>

      {/* Schedule grid — mobile: collapsible week sections; desktop: table */}
      <div className="sm:hidden space-y-2">
        {weekGroups.map(({ key, dates }) => {
          const isExpanded = expandedWeeks.has(key)
          const isCurrentWeek = key === getWeekKey(today)
          const myShiftsInWeek = dates.filter(
            (d) => (myAssignedDates.has(d) && !myFullyGivenAwayDates.has(d)) || mySplitFullShiftDates.has(d)
          ).length
          return (
            <div key={key} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <button
                onClick={() => toggleWeek(key)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 active:bg-slate-100 transition-colors text-left"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-semibold text-slate-700">{formatWeekRange(key)}</span>
                  {isCurrentWeek && (
                    <span className="shrink-0 text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">This week</span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  {myShiftsInWeek > 0 && (
                    <span className="text-xs font-medium text-blue-600">
                      {myShiftsInWeek} shift{myShiftsInWeek !== 1 ? 's' : ''}
                    </span>
                  )}
                  <svg
                    className={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>
              {isExpanded && (
                <div className="border-t border-slate-100">
                  {dates.map((date) => (
                    <div key={date}>
                      <div className="px-4 py-2 bg-slate-50 border-b border-slate-100">
                        <span className="text-xs font-medium text-slate-500">{formatDate(date)}</span>
                      </div>
                      <div className="divide-y divide-slate-100">
                        {byDate[date]?.map((shift) => (
                          <div key={shift.id} className="px-4 py-3">
                            <div className="flex items-baseline justify-between gap-2 mb-1.5">
                              <span className="text-sm font-medium text-slate-700">{clinicAbbr[shift.clinic] ?? shift.clinic}</span>
                              {formatTimeRange(shift.startTime, shift.endTime) && (
                                <span className="text-xs text-slate-400 shrink-0">{formatTimeRange(shift.startTime, shift.endTime)}</span>
                              )}
                            </div>
                            {renderShiftContent(shift)}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="hidden sm:block bg-white rounded-xl border border-slate-200 shadow-sm overflow-x-auto overflow-y-auto max-h-[70vh]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-slate-100 bg-slate-50">
              <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Date</th>
              {clinicNames.map((clinic) => (
                <th key={clinic} className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">
                  {clinicAbbr[clinic] ?? clinic}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedDates.map((date) => (
              <tr key={date} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3 font-medium text-slate-700 whitespace-nowrap">{formatDate(date)}</td>
                {clinicNames.map((clinic) => {
                  const shift = byDate[date]?.find((s) => s.clinic === clinic)
                  if (!shift) return <td key={clinic} className="px-4 py-3 text-slate-200">—</td>
                  return <td key={clinic} className="px-4 py-3">{renderShiftContent(shift)}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── OFFER A SHIFT ── */}
      {(myShifts().length > 0 || mySplitAcceptances().length > 0) && <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 bg-slate-50">
          <h2 className="text-base font-semibold text-slate-700">Offer a Shift</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Offer your full shift to others, or split your hours for someone else to cover.
          </p>
        </div>
        <div className="p-5">
          {(() => {
            // Offerable = my direct assignments that haven't started, plus accepted split windows I own
            const directOfferable = myShifts().filter((a) => {
              const s = shiftById[a.shiftId]
              if (!s) return false
              if (isShiftStarted(s)) return false
              return !myFullyGivenAwayDates.has(s.date)
            })
            const splitOfferable = mySplitAcceptances().filter((sp) => {
              const s = shiftById[sp.shiftId]
              if (s && isShiftStarted(s)) return false
              return getMyOwnedWindow(sp.shiftId) !== null
            })

            const totalOfferable = directOfferable.length + splitOfferable.length
            if (totalOfferable === 0) {
              return (
                <p className="text-sm text-slate-400">
                  {myShifts().length + mySplitAcceptances().length === 0
                    ? 'You have no assigned shifts.'
                    : 'All your shifts have started or passed.'}
                </p>
              )
            }

            // Unified list: direct assignments + split acceptances (split acceptor can sub-offer)
            const offerableItems: Array<{ shiftId: string; label: string; isSplitAcceptance: boolean }> = [
              ...directOfferable.map((a) => ({ shiftId: a.shiftId, label: shiftLabel(a.shiftId), isSplitAcceptance: false })),
              ...splitOfferable.map((sp) => ({ shiftId: sp.shiftId, label: shiftLabel(sp.shiftId), isSplitAcceptance: true })),
            ]

            return (
              <div className="space-y-2">
                {offerableItems.map(({ shiftId, label, isSplitAcceptance }) => {
                  const alreadyPending = pendingSwaps.some((r) => r.requestorShiftId === shiftId)
                  const myPendingSplit = splits.find(
                    (s) => s.shiftId === shiftId && s.offerorUserId === myUserId && s.status === 'pending'
                  )
                  const ownedWindow = getMyOwnedWindow(shiftId)
                  const canSplit = !!(ownedWindow && thirtyMinSlots(ownedWindow.start, ownedWindow.end).length > 2)
                  const hasGivenAwayPortion = splits.some(
                    (sp) => sp.shiftId === shiftId && sp.offerorUserId === myUserId && sp.status === 'accepted'
                  )

                  return (
                    <div key={`${shiftId}-${isSplitAcceptance}`}>
                      <div className="flex items-center gap-3 flex-wrap rounded-lg border border-slate-200 px-4 py-2.5">
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-slate-700">{label}</span>
                          {ownedWindow && (ownedWindow.start !== shiftById[shiftId]?.startTime || ownedWindow.end !== shiftById[shiftId]?.endTime) && (
                            <span className="ml-2 text-xs text-slate-400">
                              your hours: {formatTimeRange(ownedWindow.start, ownedWindow.end)}
                            </span>
                          )}
                        </div>
                        {alreadyPending ? (
                          <span className="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded-full shrink-0">Offered</span>
                        ) : myPendingSplit ? (
                          <span className="text-xs text-violet-600 bg-violet-50 px-2 py-1 rounded-full shrink-0">
                            Split offered · {formatTimeRange(myPendingSplit.offeredStart, myPendingSplit.offeredEnd)}
                          </span>
                        ) : (
                          <div className="flex gap-2 shrink-0">
                            {(!isSplitAcceptance || (ownedWindow && ownedWindow.start === shiftById[shiftId]?.startTime && ownedWindow.end === shiftById[shiftId]?.endTime)) && !hasGivenAwayPortion && (
                              <button
                                onClick={() => {
                                  setRequestingShiftId(shiftId)
                                  setRequestError('')
                                  setSplittingShiftId(null)
                                }}
                                className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                              >
                                Offer this shift
                              </button>
                            )}
                            {canSplit && (
                              <button
                                onClick={() => {
                                  if (splittingShiftId === shiftId) {
                                    setSplittingShiftId(null)
                                  } else {
                                    setSplittingShiftId(shiftId)
                                    if (ownedWindow) {
                                      setSplitStart(ownedWindow.start)
                                      setSplitEnd(ownedWindow.end)
                                    }
                                    setSplitError('')
                                    setRequestingShiftId(null)
                                  }
                                }}
                                className="text-sm text-violet-600 hover:text-violet-700 font-medium"
                              >
                                Split hours
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Inline whole-shift offer confirmation */}
                      {requestingShiftId === shiftId && (
                        <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg p-4">
                          <p className="text-sm text-amber-800 mb-3">
                            Offer <strong>{label}</strong> to others? Anyone can claim it.
                          </p>
                          <div className="flex gap-2">
                            <button
                              onClick={requestSwap}
                              disabled={submittingRequest}
                              className="bg-amber-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-600 disabled:opacity-40 transition-colors"
                            >
                              {submittingRequest ? 'Posting…' : 'Confirm offer'}
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

                      {/* Inline split form */}
                      {splittingShiftId === shiftId && ownedWindow && (() => {
                        const allSlots = thirtyMinSlots(ownedWindow.start, ownedWindow.end)
                        const startSlots = allSlots.slice(0, -1)
                        const endSlots = allSlots.slice(1)
                        return (
                          <div className="mt-2 bg-violet-50 border border-violet-200 rounded-lg p-4">
                            <p className="text-sm text-violet-800 mb-3">
                              Split hours for <strong>{label}</strong>
                              <span className="text-xs text-violet-500 ml-2">
                                Your hours: {formatTimeRange(ownedWindow.start, ownedWindow.end)}
                              </span>
                            </p>
                            <div className="flex flex-wrap items-center gap-2 mb-3">
                              <span className="text-sm text-violet-700">From</span>
                              <select
                                value={splitStart}
                                onChange={(e) => {
                                  setSplitStart(e.target.value)
                                  if (timeToMinutes(e.target.value) >= timeToMinutes(splitEnd)) {
                                    setSplitEnd(minutesToTime(timeToMinutes(e.target.value) + 30))
                                  }
                                }}
                                className="border border-violet-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 bg-white"
                              >
                                {startSlots.map((t) => (
                                  <option key={t} value={t}>{formatTime(t)}</option>
                                ))}
                              </select>
                              <span className="text-sm text-violet-700">to</span>
                              <select
                                value={splitEnd}
                                onChange={(e) => setSplitEnd(e.target.value)}
                                className="border border-violet-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 bg-white"
                              >
                                {endSlots
                                  .filter((t) => timeToMinutes(t) > timeToMinutes(splitStart))
                                  .map((t) => (
                                    <option key={t} value={t}>{formatTime(t)}</option>
                                  ))}
                              </select>
                            </div>
                            {splitStart && splitEnd && timeToMinutes(splitStart) < timeToMinutes(splitEnd) && (
                              <p className="text-xs text-violet-600 mb-3">
                                You will offer <strong>{formatTimeRange(splitStart, splitEnd)}</strong> and retain the remaining time.
                              </p>
                            )}
                            <div className="flex gap-2">
                              <button
                                onClick={postSplitOffer}
                                disabled={
                                  submittingSplit ||
                                  !splitStart ||
                                  !splitEnd ||
                                  timeToMinutes(splitStart) >= timeToMinutes(splitEnd)
                                }
                                className="bg-violet-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-violet-700 disabled:opacity-40 transition-colors"
                              >
                                {submittingSplit ? 'Posting…' : 'Post split offer'}
                              </button>
                              <button
                                onClick={() => { setSplittingShiftId(null); setSplitError('') }}
                                className="text-sm text-slate-500 px-3 py-2 rounded-lg hover:bg-slate-100"
                              >
                                Cancel
                              </button>
                            </div>
                            {splitError && <p className="mt-2 text-sm text-red-500">{splitError}</p>}
                          </div>
                        )
                      })()}
                    </div>
                  )
                })}
              </div>
            )
          })()}

        </div>
      </div>}

      {/* ── PENDING SHIFT OFFERS (whole-shift) ── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-700">Pending Shift Offers</h2>
          <span className="text-xs text-slate-400">{periodPendingSwaps.length} pending</span>
        </div>

        {periodPendingSwaps.length === 0 ? (
          <p className="p-5 text-sm text-slate-400">No shifts currently offered.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {periodPendingSwaps.map((req) => {
              const isMyOffer = req.requestorUserId === myUserId
              const offerDate = shiftById[req.requestorShiftId]?.date ?? ''
              const myConflict = !isMyOffer ? filteredPublished.find(
                (a) => a.shiftId !== req.requestorShiftId &&
                  shiftById[a.shiftId]?.date === offerDate &&
                  a.userId === myUserId
              ) : null
              const myConflictClinic = myConflict
                ? (clinicAbbr[shiftById[myConflict.shiftId]?.clinic ?? ''] ?? shiftById[myConflict.shiftId]?.clinic ?? '')
                : null
              const requestorDisplayName = dn(req.requestorUserId, req.requestorName)
              const requestorShift = shiftById[req.requestorShiftId]
              const offerStarted = requestorShift ? isShiftStarted(requestorShift) : false
              return (
                <div key={req.id} className="p-5">
                  <p className="text-sm text-slate-700 mb-1">
                    <strong>{requestorDisplayName}</strong> is offering{' '}
                    <span className="font-medium text-slate-800">{shiftLabel(req.requestorShiftId)}</span>
                  </p>
                  <p className="text-xs text-slate-400 mb-3">
                    Offered {formatDateTime(req.requestedAt)}
                  </p>

                  {offerStarted && !isMyOffer ? (
                    <span className="text-xs text-slate-400">Shift has started</span>
                  ) : !isMyOffer && acceptingId === req.id ? (
                    <div className={`border rounded-lg p-4 space-y-3 ${myConflictClinic ? 'bg-amber-50 border-amber-200' : 'bg-green-50 border-green-200'}`}>
                      {myConflictClinic ? (
                        <p className="text-sm text-amber-800">
                          You&apos;re assigned to <strong>{myConflictClinic}</strong> on this day — accepting will move you to this shift and open up your <strong>{myConflictClinic}</strong> slot.
                        </p>
                      ) : (
                        <p className="text-sm text-green-800">
                          Take <strong>{shiftLabel(req.requestorShiftId)}</strong> from <strong>{requestorDisplayName}</strong>? No shift needed in return.
                        </p>
                      )}
                      <div className="flex gap-2">
                        <button
                          onClick={() => acceptOffer(req.id, !!myConflictClinic)}
                          disabled={submittingAccept}
                          className={`text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-40 transition-colors ${myConflictClinic ? 'bg-amber-500 hover:bg-amber-600' : 'bg-green-600 hover:bg-green-700'}`}
                        >
                          {submittingAccept ? 'Accepting…' : 'Accept'}
                        </button>
                        <button
                          onClick={() => { setAcceptingId(null); setAcceptError('') }}
                          className="text-sm text-slate-500 px-3 py-2 rounded-lg hover:bg-slate-100"
                        >
                          Cancel
                        </button>
                      </div>
                      {acceptError && <p className="text-sm text-red-500">{acceptError}</p>}
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      {!isMyOffer && (
                        <button
                          onClick={() => { setAcceptingId(req.id); setAcceptError('') }}
                          className="bg-green-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors"
                        >
                          Take this shift
                        </button>
                      )}
                      {isMyOffer && (
                        <button
                          onClick={() => cancelSwap(req.id)}
                          className="text-sm text-slate-400 hover:text-red-500 px-2 py-1.5 transition-colors"
                        >
                          Withdraw offer
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── PENDING PORTION OFFERS (splits) ── */}
      {periodPendingSplits.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-700">Pending Split Offers</h2>
            <span className="text-xs text-slate-400">{periodPendingSplits.length} pending</span>
          </div>
          <div className="divide-y divide-slate-100">
            {periodPendingSplits.map((split) => {
              const isMyOffer = split.offerorUserId === myUserId
              const offerorDisplayName = dn(split.offerorUserId, split.offerorName)
              const splitShift = shiftById[split.shiftId]
              const splitStarted = splitShift ? isShiftStarted(splitShift) : false
              const splitDate = shiftById[split.shiftId]?.date ?? ''
              const myConflict = !isMyOffer ? filteredPublished.find((a) => {
                if (a.userId !== myUserId) return false
                if (a.shiftId === split.shiftId) return false
                if (shiftById[a.shiftId]?.date !== splitDate) return false
                const s = shiftById[a.shiftId]
                if (!s?.startTime || !s?.endTime) return false
                return timeToMinutes(split.offeredStart) < timeToMinutes(s.endTime) &&
                  timeToMinutes(s.startTime) < timeToMinutes(split.offeredEnd)
              }) : null
              const myConflictClinic = myConflict
                ? (clinicAbbr[shiftById[myConflict.shiftId]?.clinic ?? ''] ?? shiftById[myConflict.shiftId]?.clinic ?? '')
                : null
              return (
                <div key={split.id} className="p-5">
                  <p className="text-sm text-slate-700 mb-0.5">
                    <strong>{offerorDisplayName}</strong> is offering part of{' '}
                    <span className="font-medium text-slate-800">{shiftLabel(split.shiftId)}</span>
                  </p>
                  <p className="text-sm font-medium text-violet-700 mb-1">
                    {formatTimeRange(split.offeredStart, split.offeredEnd)}
                  </p>
                  <p className="text-xs text-slate-400 mb-3">
                    Offered {formatDateTime(split.offeredAt)}
                  </p>

                  {splitStarted && !isMyOffer ? (
                    <span className="text-xs text-slate-400">Shift has started</span>
                  ) : !isMyOffer && acceptingSplitId === split.id ? (
                    <div className={`border rounded-lg p-4 space-y-3 ${myConflictClinic ? 'bg-amber-50 border-amber-200' : 'bg-green-50 border-green-200'}`}>
                      {myConflictClinic ? (
                        <p className="text-sm text-amber-800">
                          You&apos;re assigned to <strong>{myConflictClinic}</strong> on this day — accepting this split will move you off that shift.
                        </p>
                      ) : (
                        <p className="text-sm text-green-800">
                          Cover <strong>{formatTimeRange(split.offeredStart, split.offeredEnd)}</strong> of <strong>{shiftLabel(split.shiftId)}</strong> for <strong>{offerorDisplayName}</strong>?
                        </p>
                      )}
                      <div className="flex gap-2">
                        <button
                          onClick={() => acceptSplit(split.id, !!myConflict)}
                          disabled={submittingSplitAccept}
                          className={`text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-40 transition-colors ${myConflictClinic ? 'bg-amber-500 hover:bg-amber-600' : 'bg-green-600 hover:bg-green-700'}`}
                        >
                          {submittingSplitAccept ? 'Accepting…' : 'Accept'}
                        </button>
                        <button
                          onClick={() => { setAcceptingSplitId(null); setSplitAcceptError('') }}
                          className="text-sm text-slate-500 px-3 py-2 rounded-lg hover:bg-slate-100"
                        >
                          Cancel
                        </button>
                      </div>
                      {splitAcceptError && <p className="text-sm text-red-500">{splitAcceptError}</p>}
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      {!isMyOffer && (
                        <button
                          onClick={() => { setAcceptingSplitId(split.id); setSplitAcceptError('') }}
                          className="bg-green-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors"
                        >
                          Accept split
                        </button>
                      )}
                      {isMyOffer && (
                        <button
                          onClick={() => cancelSplit(split.id)}
                          className="text-sm text-slate-400 hover:text-red-500 px-2 py-1.5 transition-colors"
                        >
                          Withdraw offer
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Completed / cancelled offers */}
      {(periodCompletedSwaps.length > 0 || periodCompletedSplits.length > 0) && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 bg-slate-50">
            <h2 className="text-sm font-semibold text-slate-600">Completed & Cancelled Offers</h2>
          </div>
          <div className="divide-y divide-slate-100">
            {[
              ...periodCompletedSwaps
                .map((r) => ({ type: 'swap' as const, at: r.acceptedAt ?? r.requestedAt, item: r })),
              ...periodCompletedSplits
                .map((s) => ({ type: 'split' as const, at: s.acceptedAt ?? s.offeredAt, item: s })),
            ]
              .sort((a, b) => b.at.localeCompare(a.at))
              .map(({ type, item }) =>
                type === 'swap' ? (
                  <div key={item.id} className="px-5 py-3 flex items-start gap-3">
                    <span
                      className={`mt-0.5 shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${
                        item.status === 'accepted'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      {item.status}
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm text-slate-700">
                        {dn(item.requestorUserId, item.requestorName)}
                        {item.status === 'accepted' && (
                          <> → {dn(item.acceptorUserId, item.acceptorName)}</>
                        )}
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">{shiftLabel(item.requestorShiftId)}</div>
                    </div>
                  </div>
                ) : (
                  <div key={item.id} className="px-5 py-3 flex items-start gap-3">
                    <span
                      className={`mt-0.5 shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${
                        item.status === 'accepted'
                          ? 'bg-violet-100 text-violet-700'
                          : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      {item.status === 'accepted' ? 'split' : item.status}
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm text-slate-700">
                        {dn(item.offerorUserId, item.offerorName)}
                        {item.status === 'accepted' && (
                          <> → {dn(item.acceptorUserId, item.acceptorName)}</>
                        )}
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {shiftLabel(item.shiftId)} · {formatTimeRange(item.offeredStart, item.offeredEnd)}
                      </div>
                    </div>
                  </div>
                )
              )}
          </div>
        </div>
      )}
    </div>
  )
}
