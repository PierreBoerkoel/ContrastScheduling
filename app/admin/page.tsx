'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useUser } from '@clerk/nextjs'
import type { Shift, AvailabilitySubmission, Schedule, ClinicName, SwapRequest, SchedulingPeriod, ShiftSplit } from '@/lib/types'
import { CLINICS, CLINIC_ABBR, defaultShiftTimes, formatTimeRange, computeCoverageSegments, buildDisplayNames } from '@/lib/types'

type Tab = 'shifts' | 'availability' | 'schedule' | 'swaps' | 'users'

interface ClerkUser {
  id: string
  fullName: string
  email: string
  role: string
  createdAt: string
}

function formatDate(dateStr: string) {
  return new Intl.DateTimeFormat('en-CA', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(dateStr))
}

function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
}

function isWeekend(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00Z').getUTCDay()
  return d === 0 || d === 6
}

function defaultClinicsForDay(dateStr: string): Set<ClinicName> {
  const day = new Date(dateStr + 'T00:00:00Z').getUTCDay() // 0=Sun,1=Mon,...,6=Sat
  const s = new Set<ClinicName>()
  if (day === 6) s.add('BC Cancer Agency CT')           // Saturdays only
  s.add('BC Cancer Agency MRI/PET')                     // all days
  s.add('INITIO Medical Imaging')                       // all days
  if (day >= 1 && day <= 5) s.add('UBC Hospital')       // weekdays only
  if (day === 2) s.add("BC Women's Hospital")           // Tuesdays only
  return s
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

function parseTimeInput(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '')
  if (!s) return null

  let ampm: 'am' | 'pm' | null = null
  let digits = s
  if (s.endsWith('am')) { ampm = 'am'; digits = s.slice(0, -2) }
  else if (s.endsWith('pm')) { ampm = 'pm'; digits = s.slice(0, -2) }
  else if (s.endsWith('a')) { ampm = 'am'; digits = s.slice(0, -1) }
  else if (s.endsWith('p')) { ampm = 'pm'; digits = s.slice(0, -1) }

  digits = digits.replace(':', '')
  if (!/^\d{1,4}$/.test(digits)) return null

  let h: number, m: number
  if (digits.length <= 2) {
    h = parseInt(digits, 10); m = 0
  } else if (digits.length === 3) {
    h = parseInt(digits.slice(0, 1), 10); m = parseInt(digits.slice(1), 10)
  } else {
    h = parseInt(digits.slice(0, 2), 10); m = parseInt(digits.slice(2), 10)
  }

  if (m < 0 || m > 59 || h < 0) return null
  if (ampm === 'am') {
    if (h === 12) h = 0
    if (h > 12) return null
  } else if (ampm === 'pm') {
    if (h !== 12) h += 12
    if (h > 23) return null
  } else {
    if (h > 23) return null
  }

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function formatTimeValue(hhmm: string): string {
  if (!hhmm) return ''
  const [h, m] = hhmm.split(':').map(Number)
  const ampm = h < 12 ? 'AM' : 'PM'
  const hour = h % 12 || 12
  return m === 0 ? `${hour} ${ampm}` : `${hour}:${String(m).padStart(2, '0')} ${ampm}`
}

function TimeInput({ value, onChange, className }: {
  value: string
  onChange: (hhmm: string) => void
  className?: string
}) {
  const [raw, setRaw] = useState(() => formatTimeValue(value))
  const [error, setError] = useState(false)

  useEffect(() => {
    setRaw(formatTimeValue(value))
    setError(false)
  }, [value])

  function handleBlur() {
    if (!raw.trim()) { onChange(''); setError(false); return }
    const parsed = parseTimeInput(raw)
    if (parsed) {
      setRaw(formatTimeValue(parsed))
      onChange(parsed)
      setError(false)
    } else {
      setError(true)
    }
  }

  return (
    <input
      type="text"
      value={raw}
      onChange={(e) => { setRaw(e.target.value); setError(false) }}
      onBlur={handleBlur}
      placeholder="e.g. 8am"
      className={`border rounded focus:outline-none focus:ring-1 ${error ? 'border-red-400 focus:ring-red-400' : 'border-slate-200 focus:ring-blue-400'} ${className ?? ''}`}
    />
  )
}

export default function AdminPage() {
  const { user, isLoaded } = useUser()
  const isAdmin = user?.publicMetadata?.role === 'admin'

  const [tab, setTab] = useState<Tab>('shifts')

  // Block / shift setup state
  const [selectedBlock, setSelectedBlock] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [activeClinics, setActiveClinics] = useState<Record<string, Set<ClinicName>>>({})
  const [shiftTimes, setShiftTimes] = useState<Record<string, Partial<Record<ClinicName, { startTime: string; endTime: string }>>>>({})
  const [savingShifts, setSavingShifts] = useState(false)
  const [shiftsSaved, setShiftsSaved] = useState(false)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [saveError, setSaveError] = useState('')
  const skipNextAutoInit = useRef(false)

  // Data
  const [shifts, setShifts] = useState<Shift[]>([])
  const [submissions, setSubmissions] = useState<AvailabilitySubmission[]>([])
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [swapRequests, setSwapRequests] = useState<SwapRequest[]>([])
  const [periods, setPeriods] = useState<SchedulingPeriod[]>([])
  const [splits, setSplits] = useState<ShiftSplit[]>([])

  // Period management
  const [deletingPeriodId, setDeletingPeriodId] = useState<string | null>(null)

  // Users
  const [users, setUsers] = useState<ClerkUser[]>([])
  const [removingUserId, setRemovingUserId] = useState<string | null>(null)
  const [promotingUserId, setPromotingUserId] = useState<string | null>(null)

  // Schedule interaction
  const [selectedScheduleBlock, setSelectedScheduleBlock] = useState('')
  const [editingShiftId, setEditingShiftId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)

  // Shift time editing + removal
  const [editingTimesShiftId, setEditingTimesShiftId] = useState<string | null>(null)
  const [timesEdit, setTimesEdit] = useState({ startTime: '', endTime: '' })
  const [savingTimes, setSavingTimes] = useState(false)
  const [removingShiftId, setRemovingShiftId] = useState<string | null>(null)

  // Inline add-shift cell (post-publish)
  const [addingShiftCell, setAddingShiftCell] = useState<{ date: string; clinic: ClinicName } | null>(null)
  const [addCellTimes, setAddCellTimes] = useState({ startTime: '', endTime: '' })
  const [addingCell, setAddingCell] = useState(false)

  // Flash confirmation after live shift edits
  const [shiftChangedAt, setShiftChangedAt] = useState<Date | null>(null)

  const fetchData = useCallback(async () => {
    const safe = (p: Promise<Response>) => p.then((r) => r.json()).catch(() => null)
    const [s, sub, sched, swaps, userList, periodList, splitList] = await Promise.all([
      safe(fetch('/api/shifts')),
      safe(fetch('/api/availability')),
      safe(fetch('/api/schedule')),
      safe(fetch('/api/swaps')),
      safe(fetch('/api/admin/users')),
      safe(fetch('/api/periods')),
      safe(fetch('/api/splits')),
    ])
    if (Array.isArray(s)) setShifts(s)
    if (Array.isArray(sub)) setSubmissions(sub)
    if (sched && typeof sched === 'object' && !sched.error) setSchedule(sched)
    if (Array.isArray(swaps)) setSwapRequests(swaps)
    if (Array.isArray(userList)) setUsers(userList)
    if (Array.isArray(periodList)) setPeriods(periodList)
    if (Array.isArray(splitList)) setSplits(splitList)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // Initialize the clinic grid whenever the date range changes (skip when loading an existing block)
  useEffect(() => {
    if (!startDate || !endDate || startDate > endDate) return
    if (skipNextAutoInit.current) {
      skipNextAutoInit.current = false
      return
    }
    const dates = datesInRange(startDate, endDate)
    setActiveClinics((prev) => {
      const next: Record<string, Set<ClinicName>> = {}
      for (const d of dates) {
        next[d] = prev[d] ?? defaultClinicsForDay(d)
      }
      return next
    })
    setShiftTimes((prev) => {
      const next = { ...prev }
      for (const d of dates) {
        if (!next[d]) {
          next[d] = {}
          for (const clinic of CLINICS) {
            const t = defaultShiftTimes(clinic, d)
            if (t) next[d][clinic] = t
          }
        }
      }
      return next
    })
  }, [startDate, endDate])

  function toggleClinic(date: string, clinic: ClinicName) {
    setActiveClinics((prev) => {
      const next = { ...prev, [date]: new Set(prev[date]) }
      const adding = !next[date].has(clinic)
      adding ? next[date].add(clinic) : next[date].delete(clinic)
      if (adding && !shiftTimes[date]?.[clinic]) {
        const t = defaultShiftTimes(clinic, date)
        if (t) setShiftTimes((pt) => ({ ...pt, [date]: { ...(pt[date] ?? {}), [clinic]: t } }))
      }
      return next
    })
  }

  function setTime(date: string, clinic: ClinicName, field: 'startTime' | 'endTime', value: string) {
    setShiftTimes((prev) => ({
      ...prev,
      [date]: { ...(prev[date] ?? {}), [clinic]: { ...(prev[date]?.[clinic] ?? { startTime: '', endTime: '' }), [field]: value } },
    }))
  }

  function handleBlockSelect(blockName: string) {
    setSelectedBlock(blockName)
    setShiftsSaved(false)
    setSaveError('')
    const existingPeriod = periods.find((p) => p.name === blockName)
    if (existingPeriod) {
      const blockShifts = shifts.filter((s) => s.periodId === existingPeriod.id)
      const newClinics: Record<string, Set<ClinicName>> = {}
      const newTimes: Record<string, Partial<Record<ClinicName, { startTime: string; endTime: string }>>> = {}
      for (const d of datesInRange(existingPeriod.startDate, existingPeriod.endDate)) {
        newClinics[d] = new Set(
          blockShifts.filter((s) => s.date === d).map((s) => s.clinic as ClinicName)
        )
        for (const s of blockShifts.filter((sh) => sh.date === d)) {
          if (s.startTime && s.endTime) {
            newTimes[d] = { ...(newTimes[d] ?? {}), [s.clinic]: { startTime: s.startTime, endTime: s.endTime } }
          }
        }
      }
      skipNextAutoInit.current = true
      setActiveClinics(newClinics)
      setShiftTimes(newTimes)
      setStartDate(existingPeriod.startDate)
      setEndDate(existingPeriod.endDate)
    } else {
      setStartDate('')
      setEndDate('')
      setActiveClinics({})
      setShiftTimes({})
    }
  }

  async function saveShifts() {
    if (!selectedBlock) return
    setSavingShifts(true)
    setShiftsSaved(false)
    setSaveError('')
    const payload: Record<string, ClinicName[]> = {}
    for (const [date, clinicSet] of Object.entries(activeClinics)) {
      payload[date] = Array.from(clinicSet)
    }
    const timesPayload: Record<string, Record<string, { startTime: string; endTime: string }>> = {}
    for (const [date, clinicMap] of Object.entries(shiftTimes)) {
      for (const [clinic, times] of Object.entries(clinicMap)) {
        if (times) {
          timesPayload[date] = { ...(timesPayload[date] ?? {}), [clinic]: times }
        }
      }
    }
    const res = await fetch('/api/shifts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockName: selectedBlock, startDate, endDate, activeClinics: payload, shiftTimes: timesPayload }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setSaveError(data.error ?? 'Failed to save block')
    } else {
      await fetchData()
      setShiftsSaved(true)
      setSavedAt(new Date())
    }
    setSavingShifts(false)
  }

  async function generateSchedule() {
    const schedPeriod = periods.find((p) => p.name === selectedScheduleBlock)
    setGenerating(true)
    await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'generate', periodId: schedPeriod?.id }),
    })
    await fetchData()
    setGenerating(false)
  }

  async function publishSchedule() {
    setPublishing(true)
    await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'publish', periodId: schedPeriod?.id }),
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

  async function addCellShift() {
    if (!schedPeriod || !addingShiftCell) return
    setAddingCell(true)
    try {
      await fetch('/api/shifts/single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          periodId: schedPeriod.id,
          date: addingShiftCell.date,
          clinic: addingShiftCell.clinic,
          ...(addCellTimes.startTime && addCellTimes.endTime ? { startTime: addCellTimes.startTime, endTime: addCellTimes.endTime } : {}),
        }),
      })
      setAddingShiftCell(null)
      setShiftChangedAt(new Date())
      await fetchData()
    } finally {
      setAddingCell(false)
    }
  }

  async function saveShiftTimes(shiftId: string) {
    setSavingTimes(true)
    try {
      await fetch('/api/shifts/single', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shiftId, startTime: timesEdit.startTime || null, endTime: timesEdit.endTime || null }),
      })
      setEditingTimesShiftId(null)
      setShiftChangedAt(new Date())
      await fetchData()
    } finally {
      setSavingTimes(false)
    }
  }

  async function removeShift(shiftId: string) {
    setRemovingShiftId(null)
    await fetch('/api/shifts/single', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shiftId }),
    })
    setShiftChangedAt(new Date())
    await fetchData()
  }

  // Block-scoped derived data for the Schedule tab
  const schedPeriod = periods.find((p) => p.name === selectedScheduleBlock)
  const blockShifts = schedPeriod ? shifts.filter((s) => s.periodId === schedPeriod.id) : []
  const blockSubmissions = schedPeriod ? submissions.filter((s) => s.periodId === schedPeriod.id) : []
  const blockShiftIds = new Set(blockShifts.map((s) => s.id))

  const byDate = blockShifts.reduce<Record<string, Shift[]>>((acc, shift) => {
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

  function availableFor(shiftId: string): string[] {
    return blockSubmissions
      .filter((s) => s.availableShiftIds.includes(shiftId))
      .map((s) => s.residentName)
  }

  const blockAssignments = schedule ? schedule.assignments.filter((a) => blockShiftIds.has(a.shiftId)) : []
  const blockIsPublished = schedule ? schedule.publishedAssignments.some((a) => blockShiftIds.has(a.shiftId)) : false

  const splitsByShift: Record<string, ShiftSplit[]> = {}
  for (const sp of splits) (splitsByShift[sp.shiftId] ??= []).push(sp)
  const counts: Record<string, number> = {}
  for (const a of blockAssignments) {
    if (a.residentName) counts[a.residentName] = (counts[a.residentName] ?? 0) + 1
  }

  const allNamesInView = new Set<string>()
  for (const a of blockAssignments) {
    if (a.residentName) allNamesInView.add(a.residentName)
  }
  for (const sp of splits) {
    if (blockShiftIds.has(sp.shiftId)) {
      allNamesInView.add(sp.offerorName)
      if (sp.acceptorName) allNamesInView.add(sp.acceptorName)
    }
  }
  const displayMap = buildDisplayNames([...allNamesInView])

  const dateRange = startDate && endDate && startDate <= endDate ? datesInRange(startDate, endDate) : []

  if (!isLoaded) return null

  if (!isAdmin) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <div className="text-5xl mb-4">🔒</div>
        <h2 className="text-xl font-bold text-slate-700 mb-2">Admin access required</h2>
        <p className="text-slate-400 text-sm">
          Your account does not have admin privileges. Contact the site administrator to request access.
        </p>
      </div>
    )
  }

  async function setRole(userId: string, role: string) {
    setPromotingUserId(userId)
    try {
      await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, role }),
      })
      await fetchData()
    } finally {
      setPromotingUserId(null)
    }
  }

  async function removeUser(userId: string) {
    setRemovingUserId(userId)
    try {
      await fetch('/api/admin/users', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      })
      await fetchData()
    } finally {
      setRemovingUserId(null)
    }
  }

  async function deletePeriod(periodId: string) {
    const period = periods.find((p) => p.id === periodId)
    setDeletingPeriodId(periodId)
    try {
      await fetch(`/api/periods/${periodId}`, { method: 'DELETE' })
      if (period && selectedBlock === period.name) {
        setSelectedBlock('')
        setStartDate('')
        setEndDate('')
        setActiveClinics({})
      }
      await fetchData()
    } finally {
      setDeletingPeriodId(null)
    }
  }

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
            {(() => {
              const publishedShiftIds = new Set(schedule?.publishedAssignments.map((a) => a.shiftId) ?? [])
              const unpublishedPeriodIds = new Set(
                periods
                  .filter((p) => {
                    const ids = shifts.filter((s) => s.periodId === p.id).map((s) => s.id)
                    return ids.length > 0 && !ids.some((id) => publishedShiftIds.has(id))
                  })
                  .map((p) => p.id)
              )
              const count = submissions.filter((s) => s.periodId && unpublishedPeriodIds.has(s.periodId)).length
              return count > 0 ? (
                <span className="ml-1.5 bg-blue-100 text-blue-700 text-xs px-1.5 py-0.5 rounded-full">
                  {count}
                </span>
              ) : null
            })()}
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
          <button onClick={() => setTab('users')} className={tabClass('users')}>
            Residents
            {users.length > 0 && (
              <span className="ml-1.5 bg-slate-100 text-slate-600 text-xs px-1.5 py-0.5 rounded-full">
                {users.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ── SHIFTS TAB ── */}
      {tab === 'shifts' && (
        <div className="space-y-6">

          {/* ── Configure block ── */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-base font-semibold text-slate-700 mb-4">Configure Block</h2>
            <div className="flex gap-4 mb-6 flex-wrap items-end">
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                Block
                <select
                  value={selectedBlock}
                  onChange={(e) => handleBlockSelect(e.target.value)}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select block…</option>
                  {Array.from({ length: 13 }, (_, i) => `Block ${i + 1}`).map((block) => (
                    <option key={block} value={block}>{block}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                Start date
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  disabled={!selectedBlock}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                End date
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  disabled={!selectedBlock}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40"
                />
              </label>
            </div>

            {!selectedBlock && (
              <p className="text-sm text-slate-400">Select a block above to configure its dates and shifts.</p>
            )}

            {selectedBlock && (() => {
              const cfgPeriod = periods.find((p) => p.name === selectedBlock)
              const cfgPublished = cfgPeriod
                ? shifts.filter((s) => s.periodId === cfgPeriod.id).some((s) => schedule?.publishedAssignments.some((a) => a.shiftId === s.id))
                : false
              return cfgPublished ? (
                <div className="mb-4 flex gap-3 bg-amber-50 border border-amber-300 rounded-lg px-4 py-3 text-sm text-amber-900">
                  <span className="text-amber-500 text-base leading-snug shrink-0">⚠</span>
                  <div>
                    <p className="font-semibold mb-0.5">This block has already been published.</p>
                    <p className="text-amber-800">Saving changes here will replace all shifts for this block and trigger a full schedule regeneration, which may create conflicts for residents already assigned. Use the <strong>Schedule tab</strong> to make targeted changes to a live schedule instead.</p>
                  </div>
                </div>
              ) : null
            })()}

            {selectedBlock && dateRange.length > 0 && (
              <>
                <p className="text-xs text-slate-400 mb-3">
                  Check the clinics that have shifts on each day.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50">
                        <th className="text-left px-3 py-2 font-medium text-slate-600">Date</th>
                        {CLINICS.map((c) => (
                          <th key={c} className="text-center px-3 py-2 font-medium text-slate-600 whitespace-nowrap">
                            {CLINIC_ABBR[c] ?? c}
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
                          {CLINICS.map((clinic) => {
                            const active = activeClinics[date]?.has(clinic) ?? false
                            const times = shiftTimes[date]?.[clinic]
                            return (
                              <td key={clinic} className="text-center px-2 py-2">
                                <div className="flex flex-col items-center gap-1">
                                  <input
                                    type="checkbox"
                                    checked={active}
                                    onChange={() => toggleClinic(date, clinic)}
                                    className="w-4 h-4 accent-blue-600 cursor-pointer"
                                  />
                                  {active && (
                                    <div className="flex flex-col gap-0.5">
                                      <TimeInput
                                        value={times?.startTime ?? ''}
                                        onChange={(v) => setTime(date, clinic, 'startTime', v)}
                                        className="w-24 text-xs px-1 py-0.5 text-slate-600"
                                      />
                                      <TimeInput
                                        value={times?.endTime ?? ''}
                                        onChange={(v) => setTime(date, clinic, 'endTime', v)}
                                        className="w-24 text-xs px-1 py-0.5 text-slate-600"
                                      />
                                    </div>
                                  )}
                                </div>
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 flex flex-col gap-1.5">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={saveShifts}
                      disabled={savingShifts}
                      className="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
                    >
                      {savingShifts ? 'Saving…' : `Save ${selectedBlock}`}
                    </button>
                    {saveError && <span className="text-sm text-red-500">{saveError}</span>}
                  </div>
                  {savedAt && (
                    <span className="text-xs text-slate-400">
                      Last saved at {savedAt.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', hour12: true })}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>

          {/* ── Configured blocks list ── */}
          {periods.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
              <h2 className="text-base font-semibold text-slate-700 mb-4">Configured Blocks</h2>
              <div className="space-y-2">
                {periods
                  .slice()
                  .sort((a, b) => a.startDate.localeCompare(b.startDate))
                  .map((p) => {
                    const blockShiftCount = shifts.filter((s) => s.periodId === p.id).length
                    return (
                      <div
                        key={p.id}
                        className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-2.5"
                      >
                        <div>
                          <span className="text-sm font-medium text-slate-800">{p.name}</span>
                          <span className="ml-3 text-xs text-slate-400">
                            {formatDate(p.startDate)} – {formatDate(p.endDate)}
                          </span>
                          {blockShiftCount > 0 && (
                            <span className="ml-2 text-xs text-blue-500">{blockShiftCount} shifts</span>
                          )}
                        </div>
                        <div className="flex items-center gap-4">
                          <button
                            onClick={() => handleBlockSelect(p.name)}
                            className="text-xs text-blue-500 hover:text-blue-700 transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => deletePeriod(p.id)}
                            disabled={deletingPeriodId === p.id}
                            className="text-xs text-red-400 hover:text-red-600 transition-colors disabled:opacity-40"
                          >
                            {deletingPeriodId === p.id ? '…' : 'Delete'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── AVAILABILITY TAB ── */}
      {tab === 'availability' && (() => {
        const activePeriodIds = new Set(periods.map((p) => p.id))
        const activeSubmissions = submissions.filter((s) => s.periodId && activePeriodIds.has(s.periodId))
        return (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            {activeSubmissions.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-sm">
                No availability submissions yet.
              </div>
            ) : (
              <>
                <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-700">
                    {activeSubmissions.length} submission{activeSubmissions.length !== 1 ? 's' : ''}
                  </h2>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50">
                      <th className="text-left px-4 py-3 font-medium text-slate-600">Resident</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-600">Block</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-600">Shifts available</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-600">Max shifts</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-600">Submitted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeSubmissions
                      .slice()
                      .sort((a, b) => {
                        const pa = periods.find((p) => p.id === a.periodId)
                        const pb = periods.find((p) => p.id === b.periodId)
                        return (pa?.startDate ?? '').localeCompare(pb?.startDate ?? '') || a.residentName.localeCompare(b.residentName)
                      })
                      .map((sub) => {
                        const period = periods.find((p) => p.id === sub.periodId)
                        const periodShiftCount = shifts.filter((s) => s.periodId === sub.periodId).length
                        return (
                          <tr key={sub.id} className="border-b border-slate-100 last:border-0">
                            <td className="px-4 py-3 font-medium text-slate-800">{sub.residentName}</td>
                            <td className="px-4 py-3 text-slate-600">
                              <span className="font-medium">{period?.name ?? '—'}</span>
                              {period && (
                                <div className="text-xs text-slate-400">{formatDate(period.startDate)} – {formatDate(period.endDate)}</div>
                              )}
                            </td>
                            <td className="px-4 py-3 text-slate-600">
                              {sub.availableShiftIds.length} / {periodShiftCount}
                              <div className="w-32 h-1.5 bg-slate-100 rounded-full mt-1 overflow-hidden">
                                <div
                                  className="h-full bg-blue-500 rounded-full"
                                  style={{ width: periodShiftCount > 0 ? `${(sub.availableShiftIds.length / periodShiftCount) * 100}%` : '0%' }}
                                />
                              </div>
                            </td>
                            <td className="px-4 py-3 text-slate-600 text-sm">
                              {sub.maxShifts ? (
                                <span className="font-medium">{sub.maxShifts}</span>
                              ) : (
                                <span className="text-slate-300">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-slate-400 text-xs">
                              {new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short' }).format(
                                new Date(sub.submittedAt)
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
        )
      })()}

      {/* ── SCHEDULE TAB ── */}
      {tab === 'schedule' && (
        <div className="space-y-6">
          {/* Block selector + actions */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
            <div className="flex flex-wrap gap-4 items-end">
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                Block
                <select
                  value={selectedScheduleBlock}
                  onChange={(e) => { setSelectedScheduleBlock(e.target.value); setEditingShiftId(null); setConfirmRegenerate(false); setEditingTimesShiftId(null); setRemovingShiftId(null); setAddingShiftCell(null) }}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select block…</option>
                  {periods
                    .slice()
                    .sort((a, b) => a.startDate.localeCompare(b.startDate))
                    .map((p) => (
                      <option key={p.id} value={p.name}>{p.name}</option>
                    ))}
                </select>
              </label>

              {selectedScheduleBlock && (
                <>
                  {confirmRegenerate ? (
                    <div className="flex items-start gap-3 bg-amber-50 border border-amber-300 rounded-lg px-4 py-3">
                      <span className="text-amber-500 text-base leading-snug shrink-0">⚠</span>
                      <div className="text-sm text-amber-900">
                        <p className="font-semibold mb-0.5">This block has already been published.</p>
                        <p className="text-amber-800 mb-3">Regenerating triggers a full schedule rebuild and will discard all current assignments for this block. Residents already assigned may be moved to different shifts, creating conflicts. Use Edit / Remove in the grid below to make targeted changes instead.</p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => { setConfirmRegenerate(false); generateSchedule() }}
                            disabled={generating}
                            className="shrink-0 bg-amber-500 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-amber-600 disabled:opacity-40 transition-colors"
                          >
                            {generating ? 'Generating…' : 'Yes, regenerate'}
                          </button>
                          <button
                            onClick={() => setConfirmRegenerate(false)}
                            className="shrink-0 text-sm text-slate-500 hover:text-slate-700 px-2"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        if (blockIsPublished && blockAssignments.length > 0) {
                          setConfirmRegenerate(true)
                        } else {
                          generateSchedule()
                        }
                      }}
                      disabled={generating || blockShifts.length === 0 || blockSubmissions.length === 0}
                      className="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
                    >
                      {generating ? 'Generating…' : blockAssignments.length > 0 ? 'Regenerate' : 'Generate Schedule'}
                    </button>
                  )}
                  {blockAssignments.length > 0 && !confirmRegenerate && (
                    <button
                      onClick={publishSchedule}
                      disabled={publishing}
                      className="bg-green-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-40 transition-colors"
                    >
                      {publishing ? 'Publishing…' : 'Publish'}
                    </button>
                  )}
                </>
              )}
            </div>

            {!selectedScheduleBlock && periods.length === 0 && (
              <p className="mt-3 text-sm text-slate-400">Configure blocks in the Shifts tab first.</p>
            )}
            {selectedScheduleBlock && blockShifts.length === 0 && (
              <p className="mt-3 text-sm text-slate-400">No shifts configured for {selectedScheduleBlock}. Set them up in the Shifts tab.</p>
            )}
            {selectedScheduleBlock && blockShifts.length > 0 && blockSubmissions.length === 0 && (
              <p className="mt-3 text-sm text-slate-400">No availability submitted for {selectedScheduleBlock} yet.</p>
            )}
          </div>

          {selectedScheduleBlock && blockAssignments.length > 0 && (
            <>
              {/* Assignment summary */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                <h2 className="text-sm font-semibold text-slate-600 mb-3">
                  Shift totals — {selectedScheduleBlock}
                </h2>
                <div className="flex flex-wrap gap-3">
                  {Object.entries(counts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([resident, count]) => (
                      <span
                        key={resident}
                        className="inline-flex items-center gap-1.5 bg-slate-100 text-slate-700 text-sm px-3 py-1 rounded-full"
                      >
                        <span className="font-medium">{displayMap[resident] ?? resident}</span>
                        <span className="text-slate-400 text-xs">{count}</span>
                      </span>
                    ))}
                  {blockAssignments.filter((a) => !a.residentName).length > 0 && (
                    <span className="text-xs text-red-400 self-center">
                      {blockAssignments.filter((a) => !a.residentName).length} unassigned
                    </span>
                  )}
                </div>
              </div>

              {/* Schedule grid */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between gap-4 flex-wrap">
                  <span className="text-xs text-slate-400">
                    Click a cell to reassign. Use Edit / Remove to update times or delete a shift.
                    {blockIsPublished && (
                      <span className="ml-1 text-slate-500">Publish after making any changes to update what residents see.</span>
                    )}
                  </span>
                  <span className="text-xs text-slate-400 shrink-0">
                    {shiftChangedAt
                      ? <span className="text-green-600">Last updated: {formatDateTime(shiftChangedAt.toISOString())}</span>
                      : schedule?.updatedAt
                      ? <span>Last updated: {formatDateTime(schedule.updatedAt)}</span>
                      : null}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Date</th>
                        {CLINICS.map((clinic) => (
                          <th key={clinic} className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">
                            {CLINIC_ABBR[clinic] ?? clinic}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedDates.map((date) => {
                        const shiftsOnDay = byDate[date] ?? []
                        return (
                          <tr key={date} className="border-b border-slate-100 last:border-0">
                            <td className="px-4 py-3 font-medium text-slate-700 whitespace-nowrap">
                              {formatDate(date)}
                            </td>
                            {CLINICS.map((clinic) => {
                              const shift = shiftsOnDay.find((s) => s.clinic === clinic)
                              if (!shift) {
                                const isAddingHere = blockIsPublished &&
                                  addingShiftCell?.date === date && addingShiftCell?.clinic === clinic
                                if (isAddingHere) {
                                  return (
                                    <td key={clinic} className="px-4 py-3">
                                      <div className="space-y-1">
                                        <TimeInput
                                          value={addCellTimes.startTime}
                                          onChange={(v) => setAddCellTimes((p) => ({ ...p, startTime: v }))}
                                          className="w-full text-xs px-1.5 py-0.5"
                                        />
                                        <TimeInput
                                          value={addCellTimes.endTime}
                                          onChange={(v) => setAddCellTimes((p) => ({ ...p, endTime: v }))}
                                          className="w-full text-xs px-1.5 py-0.5"
                                        />
                                        <div className="flex gap-2 pt-0.5">
                                          <button
                                            onClick={addCellShift}
                                            disabled={addingCell}
                                            className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-40"
                                          >
                                            {addingCell ? 'Adding…' : 'Add'}
                                          </button>
                                          <button
                                            onClick={() => setAddingShiftCell(null)}
                                            className="text-xs text-slate-400 hover:text-slate-600"
                                          >
                                            Cancel
                                          </button>
                                        </div>
                                      </div>
                                    </td>
                                  )
                                }
                                if (blockIsPublished) {
                                  return (
                                    <td
                                      key={clinic}
                                      className="px-4 py-3 text-slate-300 text-xs cursor-pointer hover:bg-slate-50 hover:text-blue-500 transition-colors"
                                      onClick={() => {
                                        const t = defaultShiftTimes(clinic, date) ?? { startTime: '', endTime: '' }
                                        setAddingShiftCell({ date, clinic })
                                        setAddCellTimes(t)
                                      }}
                                    >
                                      + Add
                                    </td>
                                  )
                                }
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
                                      onChange={(e) => updateAssignment(shift.id, e.target.value || null)}
                                      onBlur={() => setEditingShiftId(null)}
                                      className="border border-blue-400 rounded px-2 py-1 text-sm focus:outline-none"
                                    >
                                      <option value="">Unassigned</option>
                                      {blockSubmissions.map((sub) => (
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
                                  className="px-4 py-3 hover:bg-slate-50"
                                  onClick={() => {
                                    if (editingTimesShiftId === shift.id || removingShiftId === shift.id) return
                                    setEditingShiftId(shift.id)
                                  }}
                                >
                                  <div className="cursor-pointer mb-1">
                                    {resident ? (() => {
                                      const segs = computeCoverageSegments(shift, resident, splitsByShift[shift.id] ?? [])
                                      const hasSplits = segs.length > 1 || segs.some((sg) => sg.residentName !== resident)
                                      if (!hasSplits) {
                                        return <span className="font-medium text-slate-800 hover:text-blue-600 transition-colors">{displayMap[resident] ?? resident}</span>
                                      }
                                      return (
                                        <div className="space-y-0.5">
                                          {segs.map((sg, i) => (
                                            <div key={i} className="text-xs leading-snug">
                                              <span className={sg.residentName === resident ? 'font-medium text-slate-800' : 'font-medium text-violet-700'}>
                                                {displayMap[sg.residentName] ?? sg.residentName}
                                              </span>
                                              {sg.start && sg.end && (
                                                <span className="text-slate-400 ml-1">{formatTimeRange(sg.start, sg.end)}</span>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      )
                                    })() : (
                                      <span className="text-red-400 text-xs italic">Unassigned</span>
                                    )}
                                  </div>
                                  {editingTimesShiftId === shift.id ? (
                                    <div onClick={(e) => e.stopPropagation()} className="space-y-1">
                                      <TimeInput
                                        value={timesEdit.startTime}
                                        onChange={(v) => setTimesEdit((p) => ({ ...p, startTime: v }))}
                                        className="w-full text-xs px-1.5 py-0.5"
                                      />
                                      <TimeInput
                                        value={timesEdit.endTime}
                                        onChange={(v) => setTimesEdit((p) => ({ ...p, endTime: v }))}
                                        className="w-full text-xs px-1.5 py-0.5"
                                      />
                                      <div className="flex gap-2 pt-0.5">
                                        <button
                                          onClick={() => saveShiftTimes(shift.id)}
                                          disabled={savingTimes}
                                          className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-40"
                                        >
                                          {savingTimes ? 'Saving…' : 'Save'}
                                        </button>
                                        <button
                                          onClick={() => setEditingTimesShiftId(null)}
                                          className="text-xs text-slate-400 hover:text-slate-600"
                                        >
                                          Cancel
                                        </button>
                                      </div>
                                    </div>
                                  ) : removingShiftId === shift.id ? (
                                    <div onClick={(e) => e.stopPropagation()} className="text-xs space-y-1">
                                      <p className="text-slate-600">Remove this shift?</p>
                                      <div className="flex gap-2">
                                        <button
                                          onClick={() => removeShift(shift.id)}
                                          className="font-medium text-red-500 hover:text-red-700"
                                        >
                                          Remove
                                        </button>
                                        <button
                                          onClick={() => setRemovingShiftId(null)}
                                          className="text-slate-400 hover:text-slate-600"
                                        >
                                          Cancel
                                        </button>
                                      </div>
                                    </div>
                                  ) : (
                                    <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-2 text-xs text-slate-400">
                                      <span>{formatTimeRange(shift.startTime, shift.endTime) || 'No times'}</span>
                                      <button
                                        onClick={() => { setEditingTimesShiftId(shift.id); setTimesEdit({ startTime: shift.startTime ?? '', endTime: shift.endTime ?? '' }) }}
                                        className="text-blue-400 hover:text-blue-600 transition-colors"
                                      >
                                        Edit
                                      </button>
                                      <button
                                        onClick={() => setRemovingShiftId(shift.id)}
                                        className="text-red-400 hover:text-red-500 transition-colors"
                                      >
                                        Remove
                                      </button>
                                    </div>
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

      {/* ── USERS TAB ── */}
      {tab === 'users' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          {users.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-sm">No users found.</div>
          ) : (
            <>
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50">
                <h2 className="text-sm font-semibold text-slate-700">
                  {users.length} resident{users.length !== 1 ? 's' : ''}
                </h2>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50">
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Name</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Email</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Role</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Joined</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {users
                    .slice()
                    .sort((a, b) => a.fullName.localeCompare(b.fullName))
                    .map((u) => (
                      <tr key={u.id} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-3 font-medium text-slate-800">{u.fullName}</td>
                        <td className="px-4 py-3 text-slate-500">{u.email}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                              u.role === 'admin'
                                ? 'bg-blue-100 text-blue-700'
                                : 'bg-slate-100 text-slate-500'
                            }`}
                          >
                            {u.role}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-400 text-xs">
                          {new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium' }).format(
                            new Date(u.createdAt)
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {u.id !== user?.id && (
                            <div className="flex items-center justify-end gap-3">
                              <button
                                onClick={() => setRole(u.id, u.role === 'admin' ? 'resident' : 'admin')}
                                disabled={promotingUserId === u.id}
                                className="text-xs text-blue-500 hover:text-blue-700 transition-colors disabled:opacity-40"
                              >
                                {promotingUserId === u.id
                                  ? '…'
                                  : u.role === 'admin'
                                  ? 'Demote'
                                  : 'Make admin'}
                              </button>
                              <button
                                onClick={() => removeUser(u.id)}
                                disabled={removingUserId === u.id}
                                className="text-xs text-red-400 hover:text-red-600 transition-colors disabled:opacity-40"
                              >
                                {removingUserId === u.id ? 'Removing…' : 'Remove'}
                              </button>
                            </div>
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
