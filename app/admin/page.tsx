'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useUser } from '@clerk/nextjs'
import type { Shift, AvailabilitySubmission, ClinicName, SwapRequest, SchedulingPeriod, ShiftSplit, Clinic } from '@/lib/types'
import { formatTimeRange, computeCoverageSegments, buildDisplayNames, clinicDefaultShiftTimes, clinicDefaultActiveClinics } from '@/lib/types'
import type { BillingContactRecord } from '@/lib/invoices'

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  if (digits.length === 11 && digits[0] === '1') return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  return raw
}

type Tab = 'shifts' | 'availability' | 'schedule' | 'swaps' | 'users' | 'clinics'

const ENTITY_DISPLAY: Record<string, string> = {
  MRCT:   'BCCA MRI/CT',
  PET:    'BCCA PET',
  UBC:  'UBC MRI',
  BCWH: "BC Women's MRI",
  INITIO: 'INITIO Medical Imaging',
}

// Rate rows for complex BCCA billing entities — shown inline in the clinic card
const COMPLEX_ENTITY_RATES: Record<string, { key: string; label: string }[]> = {
  MRCT: [
    { key: 'MRCT_base',       label: 'MRI + PET (normal)' },
    { key: 'MRCT_standalone', label: 'MRI standalone / MRI + CT' },
    { key: 'MRCT_ct',         label: 'CT-only coverage' },
  ],
  PET: [
    { key: 'PET_base',        label: 'PET + MRI (normal)' },
    { key: 'PET_standalone',  label: 'PET standalone (MRI down)' },
  ],
}

interface ClerkUser {
  id: string
  fullName: string
  email: string
  role: string
  createdAt: string
  phone?: string
}

function fmtBlockDate(dateStr: string): string {
  return new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(dateStr + 'T00:00:00Z'))
}

function blockLabel(p: { name: string; startDate: string; endDate: string }): string {
  const today = new Date().toISOString().split('T')[0]
  const thisYear = today.slice(0, 4)
  const startYear = p.startDate.slice(0, 4)
  const endYear = p.endDate.slice(0, 4)
  const yearSuffix = startYear !== thisYear || endYear !== thisYear ? `, ${endYear}` : ''
  return `${p.name} · ${fmtBlockDate(p.startDate)} – ${fmtBlockDate(p.endDate)}${yearSuffix}`
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

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] // Mon–Sun display order

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

function TimeInput({ value, onChange, className, disabled }: {
  value: string
  onChange: (hhmm: string) => void
  className?: string
  disabled?: boolean
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
      disabled={disabled}
      className={`border rounded focus:outline-none focus:ring-1 disabled:opacity-40 ${error ? 'border-red-400 focus:ring-red-400' : 'border-slate-200 focus:ring-blue-400'} ${className ?? ''}`}
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
  const [scheduleClinicFilter, setScheduleClinicFilter] = useState<ClinicName | ''>('')
  const [swapsBlockFilter, setSwapsBlockFilter] = useState('')
  const [availabilityBlockFilter, setAvailabilityBlockFilter] = useState('')
  const [editingShiftId, setEditingShiftId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)
  const [notifyingAvailability, setNotifyingAvailability] = useState(false)
  const [availabilityNotifiedPeriod, setAvailabilityNotifiedPeriod] = useState<string | null>(null)
  const [notifyingSchedule, setNotifyingSchedule] = useState(false)
  const [scheduleNotifiedPeriod, setScheduleNotifiedPeriod] = useState<string | null>(null)

  // Shift time editing + removal
  const [timesEdit, setTimesEdit] = useState({ startTime: '', endTime: '' })
  const [timesEditError, setTimesEditError] = useState('')
  const [savingTimes, setSavingTimes] = useState(false)
  const [removingShiftId, setRemovingShiftId] = useState<string | null>(null)

  // Admin split creation / deletion
  const [adminSplitShiftId, setAdminSplitShiftId] = useState<string | null>(null)
  const [adminSplitStart, setAdminSplitStart] = useState('')
  const [adminSplitEnd, setAdminSplitEnd] = useState('')
  const [adminSplitAcceptorId, setAdminSplitAcceptorId] = useState('')
  const [adminSplitError, setAdminSplitError] = useState('')
  const [removingAdminSplitId, setRemovingAdminSplitId] = useState<string | null>(null)
  const [adminSplitting, setAdminSplitting] = useState(false)

  // Clinic defaults
  const [clinicDefaults, setClinicDefaults] = useState<Clinic[]>([])
  const clinicDefaultsRef = useRef<Clinic[]>([])
  const clinicNames = clinicDefaults.map((c) => c.name)
  const clinicAbbr = Object.fromEntries(clinicDefaults.map((c) => [c.name, c.abbreviation]))
  const [expandedClinics, setExpandedClinics] = useState<Set<string>>(new Set())
  const [editingClinic, setEditingClinic] = useState<string | null>(null)
  const [clinicEdit, setClinicEdit] = useState<{
    name: string
    abbreviation: string
    activeDays: Set<number>
    weekdayStart: string
    weekdayEnd: string
    weekendStart: string
    weekendEnd: string
    rates: Record<string, string>
    contacts: Record<string, { contactName: string; org: string; address: string; email: string }>
    petEndTime: string
  }>({ name: '', abbreviation: '', activeDays: new Set(), weekdayStart: '', weekdayEnd: '', weekendStart: '', weekendEnd: '', petEndTime: '', rates: {}, contacts: {} })
  const [savingClinic, setSavingClinic] = useState(false)
  const [clinicEditError, setClinicEditError] = useState('')
  const [archivedClinics, setArchivedClinics] = useState<Clinic[]>([])
  const [archivedLoaded, setArchivedLoaded] = useState(false)
  const [archivingClinic, setArchivingClinic] = useState<string | null>(null)
  const [deletingClinic, setDeletingClinic] = useState<string | null>(null)
  const [showArchivedSection, setShowArchivedSection] = useState(false)

  // Billing contacts
  const [billingContacts, setBillingContacts] = useState<BillingContactRecord[]>([])

  // Billing rates
  const [billingRates, setBillingRates] = useState<Record<string, number>>({})

  // Billing entities (DB-managed list)
  const [billingEntities, setBillingEntities] = useState<{ id: string; code: string; label: string; simpleRate: number | null }[]>([])

  // Add Clinic form
  const [showAddClinic, setShowAddClinic] = useState(false)
  const [addClinicName, setAddClinicName] = useState('')
  const [addClinicAbbr, setAddClinicAbbr] = useState('')
  const [addClinicActiveDays, setAddClinicActiveDays] = useState<Set<number>>(new Set())
  const [addClinicWeekdayStart, setAddClinicWeekdayStart] = useState('')
  const [addClinicWeekdayEnd, setAddClinicWeekdayEnd] = useState('')
  const [addClinicWeekendStart, setAddClinicWeekendStart] = useState('')
  const [addClinicWeekendEnd, setAddClinicWeekendEnd] = useState('')
  const [addClinicBillingType, setAddClinicBillingType] = useState<'existing' | 'new'>('existing')
  const [addClinicEntityCode, setAddClinicEntityCode] = useState('')
  const [addClinicNewCode, setAddClinicNewCode] = useState('')
  const [addClinicNewRate, setAddClinicNewRate] = useState('')
  const [addClinicNewContact, setAddClinicNewContact] = useState('')
  const [addClinicNewOrg, setAddClinicNewOrg] = useState('')
  const [addClinicNewAddress, setAddClinicNewAddress] = useState('')
  const [addClinicNewEmail, setAddClinicNewEmail] = useState('')
  const [addClinicSaving, setAddClinicSaving] = useState(false)
  const [addClinicError, setAddClinicError] = useState('')

  // Inline add-shift cell (post-publish)
  const [addingShiftCell, setAddingShiftCell] = useState<{ date: string; clinic: ClinicName } | null>(null)
  const [addCellTimes, setAddCellTimes] = useState({ startTime: '', endTime: '' })
  const [addCellError, setAddCellError] = useState('')
  const [addingCell, setAddingCell] = useState(false)


  const fetchData = useCallback(async () => {
    const safe = (p: Promise<Response>) => p.then((r) => r.json()).catch(() => null)
    const [s, sub, swaps, userList, periodList, splitList] = await Promise.all([
      safe(fetch('/api/shifts')),
      safe(fetch('/api/availability')),
      safe(fetch('/api/swaps')),
      safe(fetch('/api/admin/users')),
      safe(fetch('/api/periods')),
      safe(fetch('/api/splits')),
    ])
    if (Array.isArray(s)) setShifts(s)
    if (Array.isArray(sub)) setSubmissions(sub)
    if (Array.isArray(swaps)) setSwapRequests(swaps)
    if (Array.isArray(userList)) setUsers(userList)
    if (Array.isArray(periodList)) setPeriods(periodList)
    if (Array.isArray(splitList)) setSplits(splitList)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // Auto-select the block containing today, or the most recent past block
  useEffect(() => {
    if (periods.length === 0 || selectedScheduleBlock) return
    const today = new Date().toISOString().split('T')[0]
    const sorted = [...periods].sort((a, b) => a.startDate.localeCompare(b.startDate))
    const current = sorted.find((p) => p.startDate <= today && today <= p.endDate)
    if (current) { setSelectedScheduleBlock(current.name); return }
    const past = [...sorted].reverse().find((p) => p.endDate < today)
    if (past) setSelectedScheduleBlock(past.name)
  }, [periods, selectedScheduleBlock])

  useEffect(() => {
    fetch('/api/admin/clinic-defaults')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) { setClinicDefaults(d); clinicDefaultsRef.current = d } })
      .catch(() => {})
  }, [])

  useEffect(() => { clinicDefaultsRef.current = clinicDefaults }, [clinicDefaults])

  useEffect(() => {
    fetch('/api/admin/billing-contacts')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setBillingContacts(d) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetch('/api/admin/billing-rates')
      .then((r) => r.json())
      .then((d) => { if (d && typeof d === 'object' && !d.error) setBillingRates(d) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetch('/api/admin/billing-entities')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setBillingEntities(d) })
      .catch(() => {})
  }, [])

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
        next[d] = prev[d] ?? clinicDefaultActiveClinics(d, clinicDefaultsRef.current)
      }
      return next
    })
    setShiftTimes((prev) => {
      const next = { ...prev }
      for (const d of dates) {
        if (!next[d]) {
          next[d] = {}
          for (const clinic of clinicDefaultsRef.current.map((c) => c.name)) {
            const t = clinicDefaultShiftTimes(clinic, d, clinicDefaultsRef.current)
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
        const t = clinicDefaultShiftTimes(clinic, date, clinicDefaultsRef.current)
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
    for (const [date, clinicMap] of Object.entries(shiftTimes)) {
      for (const [clinic, times] of Object.entries(clinicMap)) {
        if (times && endBeforeStart(times.startTime, times.endTime)) {
          setSaveError(`End time must be after start time (${date}, ${clinic}).`)
          return
        }
      }
    }
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
    const period = periods.find((p) => p.name === selectedScheduleBlock)
    setGenerating(true)
    await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'generate', periodId: period?.id }),
    })
    await fetchData()
    setGenerating(false)
  }

  async function publishSchedule() {
    const period = periods.find((p) => p.name === selectedScheduleBlock)
    setPublishing(true)
    await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'publish', periodId: period?.id }),
    })
    await fetchData()
    setPublishing(false)
  }

  async function notifyAvailability() {
    const period = periods.find((p) => p.name === selectedBlock)
    if (!period) return
    setNotifyingAvailability(true)
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'availability', periodId: period.id }),
    })
    setNotifyingAvailability(false)
    setAvailabilityNotifiedPeriod(period.id)
  }

  async function notifySchedule() {
    const period = periods.find((p) => p.name === selectedScheduleBlock)
    if (!period) return
    setNotifyingSchedule(true)
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'schedule', periodId: period.id }),
    })
    setNotifyingSchedule(false)
    setScheduleNotifiedPeriod(period.id)
  }

  async function updateAssignment(shiftId: string, residentName: string | null) {
    const matchingUser = residentName ? users.find((u) => u.fullName === residentName) : null
    await fetch('/api/schedule', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shiftId, residentName, userId: matchingUser?.id ?? null }),
    })
    await fetchData()
  }

  function endBeforeStart(start: string, end: string): boolean {
    return !!(start && end && end <= start)
  }

  async function addCellShift() {
    if (!schedPeriod || !addingShiftCell) return
    if (endBeforeStart(addCellTimes.startTime, addCellTimes.endTime)) {
      setAddCellError('End time must be after start time.')
      return
    }
    setAddCellError('')
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
      await fetchData()
    } finally {
      setAddingCell(false)
    }
  }

  async function saveShiftTimes(shiftId: string) {
    if (endBeforeStart(timesEdit.startTime, timesEdit.endTime)) {
      setTimesEditError('End time must be after start time.')
      return
    }
    setTimesEditError('')
    setSavingTimes(true)
    try {
      await fetch('/api/shifts/single', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shiftId, startTime: timesEdit.startTime || null, endTime: timesEdit.endTime || null }),
      })
      setEditingShiftId(null)
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
    await fetchData()
  }

  async function adminCreateSplit(shiftId: string) {
    const acceptor = users.find((u) => u.id === adminSplitAcceptorId)
    if (!acceptor) { setAdminSplitError('Select a covering resident'); return }
    setAdminSplitting(true)
    setAdminSplitError('')
    const res = await fetch('/api/admin/splits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shiftId,
        offeredStart: adminSplitStart,
        offeredEnd: adminSplitEnd,
        acceptorUserId: acceptor.id,
        acceptorName: acceptor.fullName,
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      setAdminSplitError(data.error ?? 'Failed to create split')
      setAdminSplitting(false)
      return
    }
    setSplits((prev) => [...prev, data])
    setAdminSplitShiftId(null)
    setAdminSplitting(false)
  }

  async function removeAdminSplit(splitId: string) {
    setRemovingAdminSplitId(splitId)
    await fetch('/api/admin/splits', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ splitId }),
    })
    setSplits((prev) => prev.filter((s) => s.id !== splitId))
    setRemovingAdminSplitId(null)
  }

  function openAdminSplit(shiftId: string, shift: { startTime?: string; endTime?: string }) {
    setAdminSplitShiftId(shiftId)
    setAdminSplitStart(shift.startTime ?? '')
    setAdminSplitEnd(shift.endTime ?? '')
    setAdminSplitAcceptorId('')
    setAdminSplitError('')
    setRemovingShiftId(null)
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
  const blockDateRange = schedPeriod ? datesInRange(schedPeriod.startDate, schedPeriod.endDate) : []

  const assignmentMap: Record<string, string | null> = {}
  for (const a of schedPeriod?.assignments ?? []) {
    assignmentMap[a.shiftId] = a.residentName
  }

  function availableFor(shiftId: string): string[] {
    return blockSubmissions
      .filter((s) => s.availableShiftIds.includes(shiftId))
      .map((s) => (s.userId && userCurrentName[s.userId]) ? userCurrentName[s.userId] : s.residentName)
  }

  const blockAssignments = (schedPeriod?.assignments ?? []).filter((a) => blockShiftIds.has(a.shiftId))
  const blockIsPublished = !!schedPeriod?.publishedAt

  const visibleClinics: string[] = scheduleClinicFilter ? [scheduleClinicFilter] : clinicNames

  const splitsByShift: Record<string, ShiftSplit[]> = {}
  for (const sp of splits) (splitsByShift[sp.shiftId] ??= []).push(sp)
  const blockShiftById = Object.fromEntries(blockShifts.map((s) => [s.id, s]))

  // Stable key per person: userId when available, name for legacy records
  const userCurrentName = Object.fromEntries(users.map(u => [u.id, u.fullName]))
  const cKey = (userId: string | null | undefined, name: string | null | undefined) => userId ?? name ?? ''
  const cName = (key: string) => userCurrentName[key] ?? key

  const shiftToUserId: Record<string, string | null> = {}
  for (const a of blockAssignments) shiftToUserId[a.shiftId] = a.userId ?? null

  const currentNameForShift = (shiftId: string): string | null => {
    const uid = shiftToUserId[shiftId]
    if (uid && userCurrentName[uid]) return userCurrentName[uid]
    return assignmentMap[shiftId] ?? null
  }

  const currentNameForSeg = (sg: { residentName: string; userId?: string | null }): string =>
    (sg.userId && userCurrentName[sg.userId]) ? userCurrentName[sg.userId] : sg.residentName

  const counts: Record<string, number> = {}
  for (const a of blockAssignments) {
    if (!a.residentName && !a.userId) continue
    const k = cKey(a.userId, a.residentName)
    counts[k] = (counts[k] ?? 0) + 1
  }
  for (const sp of splits) {
    if (sp.status !== 'accepted' || !sp.acceptorName) continue
    if (!blockShiftIds.has(sp.shiftId)) continue
    const shift = blockShiftById[sp.shiftId]
    const frac = splitFraction(sp.offeredStart, sp.offeredEnd, shift?.startTime, shift?.endTime)
    const offerorKey = cKey(sp.offerorUserId, sp.offerorName)
    const acceptorKey = cKey(sp.acceptorUserId, sp.acceptorName)
    counts[offerorKey] = (counts[offerorKey] ?? 0) - frac
    counts[acceptorKey] = (counts[acceptorKey] ?? 0) + frac
  }

  const allNamesInView = new Set<string>()
  for (const a of blockAssignments) {
    if (a.residentName || a.userId) allNamesInView.add(cName(cKey(a.userId, a.residentName)))
  }
  for (const sp of splits) {
    if (blockShiftIds.has(sp.shiftId)) {
      allNamesInView.add(cName(cKey(sp.offerorUserId, sp.offerorName)))
      if (sp.acceptorName || sp.acceptorUserId) allNamesInView.add(cName(cKey(sp.acceptorUserId, sp.acceptorName)))
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

  function downloadBlockCsv() {
    if (!schedPeriod) return
    const pubMap: Record<string, string | null> = {}
    const pubUserIdMap: Record<string, string | null> = {}
    for (const a of schedPeriod.publishedAssignments) {
      pubMap[a.shiftId] = a.residentName ?? null
      pubUserIdMap[a.shiftId] = a.userId ?? null
    }

    function fmt(t: string) {
      const [h, m] = t.split(':').map(Number)
      const ampm = h < 12 ? 'AM' : 'PM'
      const hour = h % 12 || 12
      return m === 0 ? `${hour} ${ampm}` : `${hour}:${String(m).padStart(2, '0')} ${ampm}`
    }

    const dayName = (d: string) =>
      new Intl.DateTimeFormat('en-CA', { weekday: 'long', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'))

    const header = ['Date', 'Day', ...visibleClinics.map((c) => clinicAbbr[c] ?? c)]
    const rows: string[][] = [header]

    for (const date of sortedDates) {
      const row: string[] = [date, dayName(date)]
      for (const clinic of visibleClinics) {
        const shift = (byDate[date] ?? []).find((s) => s.clinic === clinic)
        if (!shift) { row.push(''); continue }
        const assignedStored = pubMap[shift.id] ?? null
        const assignedUid = pubUserIdMap[shift.id]
        const segs = computeCoverageSegments(shift, assignedStored, splitsByShift[shift.id] ?? [], assignedUid)
        if (segs.length === 0) {
          const times = shift.startTime && shift.endTime ? ` ${fmt(shift.startTime)}–${fmt(shift.endTime)}` : ''
          row.push(`Unassigned${times}`)
        } else {
          row.push(segs.map((sg) => `${currentNameForSeg(sg)} ${fmt(sg.start)}–${fmt(sg.end)}`).join('; '))
        }
      }
      rows.push(row)
    }

    const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${selectedScheduleBlock}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleAddClinic() {
    if (!addClinicName.trim()) { setAddClinicError('Clinic name is required'); return }
    if (!addClinicAbbr.trim()) { setAddClinicError('Abbreviation is required'); return }
    if (addClinicBillingType === 'new') {
      if (!addClinicNewCode.trim()) { setAddClinicError('Entity code is required'); return }
      if (!addClinicNewOrg.trim()) { setAddClinicError('Organization is required'); return }
      const r = parseFloat(addClinicNewRate)
      if (!addClinicNewRate || isNaN(r) || r < 0) { setAddClinicError('Valid hourly rate is required'); return }
    } else {
      if (!addClinicEntityCode) { setAddClinicError('Select a billing entity'); return }
    }
    setAddClinicSaving(true)
    setAddClinicError('')
    try {
      let entityCode = addClinicEntityCode
      if (addClinicBillingType === 'new') {
        const entityRes = await fetch('/api/admin/billing-entities', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: addClinicNewCode.trim(),
            org: addClinicNewOrg.trim(),
            contactName: addClinicNewContact.trim(),
            address: addClinicNewAddress.trim(),
            email: addClinicNewEmail.trim() || null,
            rate: parseFloat(addClinicNewRate),
          }),
        })
        if (!entityRes.ok) {
          const data = await entityRes.json()
          setAddClinicError(data.error ?? 'Failed to create billing entity')
          return
        }
        const newEntity = await entityRes.json()
        entityCode = newEntity.code
        setBillingEntities((prev) => [...prev, newEntity])
        setBillingRates((prev) => ({ ...prev, [`${newEntity.code}_rate`]: parseFloat(addClinicNewRate) }))
        setBillingContacts((prev) => [...prev, { entity: newEntity.code, contactName: addClinicNewContact.trim(), org: addClinicNewOrg.trim(), address: addClinicNewAddress.trim(), email: addClinicNewEmail.trim() || null }])
      }
      const activeDays = [...addClinicActiveDays].sort()
      const hasWd = activeDays.some((d) => d >= 1 && d <= 5)
      const hasWe = activeDays.some((d) => d === 0 || d === 6)
      const clinicRes = await fetch('/api/admin/clinics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: addClinicName.trim(),
          abbreviation: addClinicAbbr.trim(),
          activeDays,
          weekdayStart: hasWd ? addClinicWeekdayStart || null : null,
          weekdayEnd: hasWd ? addClinicWeekdayEnd || null : null,
          weekendStart: hasWe ? addClinicWeekendStart || null : null,
          weekendEnd: hasWe ? addClinicWeekendEnd || null : null,
          billingMode: 'simple',
          billingEntityCodes: [entityCode],
          sortOrder: 999,
        }),
      })
      if (!clinicRes.ok) {
        const data = await clinicRes.json()
        setAddClinicError(data.error ?? 'Failed to create clinic')
        return
      }
      const newClinic = await clinicRes.json()
      setClinicDefaults((prev) => [...prev, newClinic])
      setShowAddClinic(false)
      setAddClinicName(''); setAddClinicAbbr(''); setAddClinicActiveDays(new Set())
      setAddClinicWeekdayStart(''); setAddClinicWeekdayEnd('')
      setAddClinicWeekendStart(''); setAddClinicWeekendEnd('')
      setAddClinicBillingType('existing'); setAddClinicEntityCode('')
      setAddClinicNewCode(''); setAddClinicNewRate(''); setAddClinicNewContact('')
      setAddClinicNewOrg(''); setAddClinicNewAddress(''); setAddClinicNewEmail('')
    } finally {
      setAddClinicSaving(false)
    }
  }

  const tabClass = (t: Tab) =>
    `px-2 py-1.5 sm:px-4 sm:py-2 text-xs sm:text-sm font-medium rounded-lg transition-colors ${
      tab === t ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'
    }`

  return (
    <div className="max-w-6xl mx-auto px-4 py-10">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-6 gap-3">
        <h1 className="text-2xl font-bold text-slate-800">Admin Dashboard</h1>
        <div className="flex gap-1.5 flex-wrap">
          <button onClick={() => setTab('shifts')} className={tabClass('shifts')}>Shifts</button>
          <button onClick={() => setTab('availability')} className={tabClass('availability')}>
            <span className="sm:hidden">Avail</span>
            <span className="hidden sm:inline">Availability</span>
            {(() => {
              const unpublishedPeriodIds = new Set(
                periods.filter((p) => !p.publishedAt && shifts.some((s) => s.periodId === p.id)).map((p) => p.id)
              )
              const count = submissions.filter((s) => s.periodId && unpublishedPeriodIds.has(s.periodId)).length
              return count > 0 ? (
                <span className="ml-1.5 bg-blue-100 text-blue-700 text-xs px-1.5 py-0.5 rounded-full">
                  {count}
                </span>
              ) : null
            })()}
          </button>
          <button onClick={() => setTab('schedule')} className={tabClass('schedule')}>
            <span className="sm:hidden">Sched</span>
            <span className="hidden sm:inline">Schedule</span>
          </button>
          <button onClick={() => setTab('swaps')} className={tabClass('swaps')}>
            Swaps
            {swapRequests.filter((r) => r.status === 'pending').length > 0 && (
              <span className="ml-1.5 bg-amber-100 text-amber-700 text-xs px-1.5 py-0.5 rounded-full">
                {swapRequests.filter((r) => r.status === 'pending').length}
              </span>
            )}
          </button>
          <button onClick={() => setTab('users')} className={tabClass('users')}>
            <span className="sm:hidden">Users</span>
            <span className="hidden sm:inline">Residents</span>
            {users.length > 0 && (
              <span className="ml-1.5 bg-slate-100 text-slate-600 text-xs px-1.5 py-0.5 rounded-full">
                {users.length}
              </span>
            )}
          </button>
          <button onClick={() => { setTab('clinics'); if (!archivedLoaded) { fetch('/api/admin/clinics?archivedOnly=true').then((r) => r.json()).then((d) => { if (Array.isArray(d)) { setArchivedClinics(d); setArchivedLoaded(true) } }).catch(() => {}) } }} className={tabClass('clinics')}>
            <span className="sm:hidden">Clinics</span>
            <span className="hidden sm:inline">Clinic Management</span>
          </button>
        </div>
      </div>

      {/* ── SHIFTS TAB ── */}
      {tab === 'shifts' && (
        <div className="space-y-6">

          {/* ── Configure block ── */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50">
              <h2 className="text-sm font-semibold text-slate-700">Configure Block</h2>
            </div>
            <div className="p-6">
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
                  disabled={!selectedBlock || !!periods.find((p) => p.name === selectedBlock)?.publishedAt}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                End date
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  disabled={!selectedBlock || !!periods.find((p) => p.name === selectedBlock)?.publishedAt}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40"
                />
              </label>
            </div>

            {!selectedBlock && (
              <p className="text-sm text-slate-400">Select a block above to configure its dates and shifts.</p>
            )}

            {selectedBlock && (() => {
              const cfgPeriod = periods.find((p) => p.name === selectedBlock)
              const cfgLocked = !!cfgPeriod?.publishedAt
              return cfgLocked ? (
                <div className="mb-4 flex gap-3 bg-amber-50 border border-amber-300 rounded-lg px-4 py-3 text-sm text-amber-900">
                  <span className="text-amber-500 text-base leading-snug shrink-0">⚠</span>
                  <div>
                    <p className="font-semibold mb-0.5">This block has been published and is locked.</p>
                    <p className="text-amber-800">To reconfigure it from scratch, delete the block and create a new one with the same name. Use the <strong>Schedule tab</strong> to make targeted changes to a live schedule instead.</p>
                  </div>
                </div>
              ) : null
            })()}

            {selectedBlock && dateRange.length > 0 && (() => {
              const isLocked = !!periods.find((p) => p.name === selectedBlock)?.publishedAt
              return (
              <>
                <p className="text-xs text-slate-400 mb-3">
                  Check the clinics that have shifts on each day.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50">
                        <th className="text-left px-3 py-2 font-medium text-slate-600">Date</th>
                        {clinicNames.map((c) => (
                          <th key={c} className="text-center px-3 py-2 font-medium text-slate-600 whitespace-nowrap">
                            {clinicAbbr[c] ?? c}
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
                          {clinicNames.map((clinic) => {
                            const active = activeClinics[date]?.has(clinic) ?? false
                            const times = shiftTimes[date]?.[clinic]
                            return (
                              <td key={clinic} className="text-center px-2 py-2">
                                <div className="flex flex-col items-center gap-1">
                                  <input
                                    type="checkbox"
                                    checked={active}
                                    onChange={() => toggleClinic(date, clinic)}
                                    disabled={isLocked}
                                    className="w-4 h-4 accent-blue-600 cursor-pointer disabled:opacity-40 disabled:cursor-default"
                                  />
                                  {active && (
                                    <div className="flex flex-col gap-0.5">
                                      <TimeInput
                                        value={times?.startTime ?? ''}
                                        onChange={(v) => setTime(date, clinic, 'startTime', v)}
                                        className="w-24 text-xs px-1 py-0.5 text-slate-600"
                                        disabled={isLocked}
                                      />
                                      <TimeInput
                                        value={times?.endTime ?? ''}
                                        onChange={(v) => setTime(date, clinic, 'endTime', v)}
                                        className="w-24 text-xs px-1 py-0.5 text-slate-600"
                                        disabled={isLocked}
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
                    {isLocked ? (
                      <span className="flex items-center gap-1.5 text-sm text-slate-400">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        </svg>
                        Published — delete this block to reconfigure it
                      </span>
                    ) : (
                      <button
                        onClick={saveShifts}
                        disabled={savingShifts}
                        className="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
                      >
                        {savingShifts ? 'Saving…' : `Save ${selectedBlock}`}
                      </button>
                    )}
                    {saveError && <span className="text-sm text-red-500">{saveError}</span>}
                  </div>
                  {savedAt && (
                    <span className="text-xs text-slate-400">
                      Last saved at {savedAt.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', hour12: true })}
                    </span>
                  )}
                  {!isLocked && !!periods.find((p) => p.name === selectedBlock) && (
                    availabilityNotifiedPeriod === periods.find((p) => p.name === selectedBlock)?.id ? (
                      <span className="text-xs text-green-600 flex items-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                        Residents notified
                      </span>
                    ) : (
                      <button
                        onClick={notifyAvailability}
                        disabled={notifyingAvailability}
                        className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-40 transition-colors text-left"
                      >
                        {notifyingAvailability ? 'Sending…' : 'Email residents — availability now open'}
                      </button>
                    )
                  )}
                </div>
              </>
              )
            })()}
            </div>
          </div>

          {/* ── Configured blocks list ── */}
          {periods.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50">
                <h2 className="text-sm font-semibold text-slate-700">Configured Blocks</h2>
              </div>
              <div className="p-6">
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
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-slate-800">{p.name}</span>
                            {blockShiftCount > 0 && (
                              <span className="text-xs text-blue-500">{blockShiftCount} shifts</span>
                            )}
                          </div>
                          <div className="text-xs text-slate-400 mt-0.5">
                            {formatDate(p.startDate)} – {formatDate(p.endDate)}
                          </div>
                        </div>
                        <div className="flex items-center gap-4 shrink-0 ml-3">
                          {p.publishedAt ? (
                            <span className="text-xs text-slate-400 flex items-center gap-1" title="Published — delete this block to reconfigure it">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                              </svg>
                              Published
                            </span>
                          ) : (
                            <button
                              onClick={() => handleBlockSelect(p.name)}
                              className="text-xs text-blue-500 hover:text-blue-700 transition-colors"
                            >
                              Edit
                            </button>
                          )}
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
            </div>
          )}
        </div>
      )}

      {/* ── AVAILABILITY TAB ── */}
      {tab === 'availability' && (() => {
        const activePeriodIds = new Set(periods.map((p) => p.id))
        const allActiveSubmissions = submissions.filter((s) => s.periodId && activePeriodIds.has(s.periodId))
        const activeSubmissions = availabilityBlockFilter
          ? allActiveSubmissions.filter((s) => s.periodId === periods.find((p) => p.name === availabilityBlockFilter)?.id)
          : allActiveSubmissions
        return (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            {allActiveSubmissions.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-sm">
                No availability submissions yet.
              </div>
            ) : (
              <>
                <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex flex-wrap items-center gap-3 justify-between">
                  <h2 className="text-sm font-semibold text-slate-700">
                    {activeSubmissions.length} submission{activeSubmissions.length !== 1 ? 's' : ''}
                  </h2>
                  <select
                    value={availabilityBlockFilter}
                    onChange={(e) => setAvailabilityBlockFilter(e.target.value)}
                    className="border border-slate-300 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400"
                  >
                    <option value="">All blocks</option>
                    {periods.slice().sort((a, b) => b.startDate.localeCompare(a.startDate)).map((p) => (
                      <option key={p.id} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                </div>
                {/* Mobile cards */}
                <div className="sm:hidden divide-y divide-slate-100">
                  {activeSubmissions
                    .slice()
                    .sort((a, b) => {
                      const pa = periods.find((p) => p.id === a.periodId)
                      const pb = periods.find((p) => p.id === b.periodId)
                      const aName = (a.userId && userCurrentName[a.userId]) ? userCurrentName[a.userId] : a.residentName
                      const bName = (b.userId && userCurrentName[b.userId]) ? userCurrentName[b.userId] : b.residentName
                      return (pa?.startDate ?? '').localeCompare(pb?.startDate ?? '') || aName.localeCompare(bName)
                    })
                    .map((sub) => {
                      const period = periods.find((p) => p.id === sub.periodId)
                      const periodShiftCount = shifts.filter((s) => s.periodId === sub.periodId).length
                      const subCurrentName = (sub.userId && userCurrentName[sub.userId]) ? userCurrentName[sub.userId] : sub.residentName
                      return (
                        <div key={sub.id} className="px-4 py-3 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-slate-800 text-sm">{subCurrentName}</span>
                            <span className="text-xs font-medium text-slate-600 shrink-0">{period?.name ?? '—'}</span>
                          </div>
                          <div>
                            <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                              <span>{sub.availableShiftIds.length} / {periodShiftCount} shifts available</span>
                              {sub.maxShifts && <span className="text-slate-400">max {sub.maxShifts}</span>}
                            </div>
                            <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-500 rounded-full"
                                style={{ width: periodShiftCount > 0 ? `${(sub.availableShiftIds.length / periodShiftCount) * 100}%` : '0%' }}
                              />
                            </div>
                          </div>
                          <div className="text-xs text-slate-400">
                            Submitted {new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(sub.submittedAt))}
                          </div>
                        </div>
                      )
                    })}
                </div>
                {/* Desktop table */}
                <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50">
                      <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Resident</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Block</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Shifts available</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Max shifts</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Submitted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeSubmissions
                      .slice()
                      .sort((a, b) => {
                        const pa = periods.find((p) => p.id === a.periodId)
                        const pb = periods.find((p) => p.id === b.periodId)
                        const aName = (a.userId && userCurrentName[a.userId]) ? userCurrentName[a.userId] : a.residentName
                        const bName = (b.userId && userCurrentName[b.userId]) ? userCurrentName[b.userId] : b.residentName
                        return (pa?.startDate ?? '').localeCompare(pb?.startDate ?? '') || aName.localeCompare(bName)
                      })
                      .map((sub) => {
                        const period = periods.find((p) => p.id === sub.periodId)
                        const periodShiftCount = shifts.filter((s) => s.periodId === sub.periodId).length
                        const subCurrentName = (sub.userId && userCurrentName[sub.userId]) ? userCurrentName[sub.userId] : sub.residentName
                        return (
                          <tr key={sub.id} className="border-b border-slate-100 last:border-0">
                            <td className="px-4 py-3 font-medium text-slate-800">{subCurrentName}</td>
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
                </div>
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
                  onChange={(e) => { setSelectedScheduleBlock(e.target.value); setEditingShiftId(null); setConfirmRegenerate(false); setRemovingShiftId(null); setAddingShiftCell(null) }}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select block…</option>
                  {periods
                    .slice()
                    .sort((a, b) => a.startDate.localeCompare(b.startDate))
                    .map((p) => (
                      <option key={p.id} value={p.name}>{blockLabel(p)}</option>
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
                      {publishing
                        ? (schedPeriod?.publishedAt ? 'Updating…' : 'Publishing…')
                        : (schedPeriod?.publishedAt ? 'Update' : 'Publish')}
                    </button>
                  )}
                </>
              )}
            </div>
            {blockAssignments.length > 0 && !confirmRegenerate && (
              <div className="mt-2 text-xs text-slate-400 space-y-0.5">
                {schedPeriod?.publishedAt ? (
                  <>
                    <p>Published {formatDateTime(schedPeriod.publishedAt)}</p>
                    {schedPeriod.updatedAt && <p>Updated {formatDateTime(schedPeriod.updatedAt)}</p>}
                    {scheduleNotifiedPeriod === schedPeriod.id ? (
                      <p className="text-green-600 flex items-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                        Residents notified
                      </p>
                    ) : (
                      <button
                        onClick={notifySchedule}
                        disabled={notifyingSchedule}
                        className="text-blue-600 hover:text-blue-800 disabled:opacity-40 transition-colors text-left"
                      >
                        {notifyingSchedule ? 'Sending…' : 'Email residents — schedule published'}
                      </button>
                    )}
                  </>
                ) : (
                  <p className="text-amber-500">Not yet published</p>
                )}
              </div>
            )}

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
                    .map(([key, count]) => (
                      <span
                        key={key}
                        className="inline-flex items-center gap-1.5 bg-slate-100 text-slate-700 text-sm px-3 py-1 rounded-full"
                      >
                        <span className="font-medium">{displayMap[cName(key)] ?? cName(key)}</span>
                        <span className="text-slate-400 text-xs">{formatShiftCount(count)}</span>
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
                  <div className="flex items-center gap-3 shrink-0">
                    <select
                      value={scheduleClinicFilter}
                      onChange={(e) => setScheduleClinicFilter(e.target.value as ClinicName | '')}
                      className="text-xs border border-slate-200 rounded-lg px-2 py-1 text-slate-600 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
                    >
                      <option value="">All clinics</option>
                      {clinicNames.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    {blockIsPublished && (
                      <button
                        onClick={downloadBlockCsv}
                        className="text-xs text-blue-600 hover:text-blue-800 transition-colors"
                      >
                        Download CSV
                      </button>
                    )}
                  </div>
                </div>
                {scheduleClinicFilter ? (
                  // ── Calendar view (single clinic selected) ────────────────
                  (() => {
                    const clinic = scheduleClinicFilter
                    const blockDateSet = new Set(blockDateRange)
                    if (blockDateRange.length === 0) return null

                    const firstDate = blockDateRange[0]
                    const lastDate = blockDateRange[blockDateRange.length - 1]

                    // Grid: Monday of first block week → Sunday of last block week
                    const firstObj = new Date(firstDate + 'T00:00:00Z')
                    const firstDow = (firstObj.getUTCDay() + 6) % 7
                    const gridStart = new Date(firstObj.getTime() - firstDow * 86400000)

                    const lastObj = new Date(lastDate + 'T00:00:00Z')
                    const lastDow = (lastObj.getUTCDay() + 6) % 7
                    const gridEnd = new Date(lastObj.getTime() + (6 - lastDow) * 86400000)

                    const gridDates: string[] = []
                    const cur = new Date(gridStart)
                    while (cur <= gridEnd) {
                      gridDates.push(cur.toISOString().split('T')[0])
                      cur.setUTCDate(cur.getUTCDate() + 1)
                    }

                    const fmtMD = (d: string) => new Intl.DateTimeFormat('en-CA', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'))
                    const firstYear = firstDate.slice(0, 4), lastYear = lastDate.slice(0, 4)
                    const rangeLabel = firstYear === lastYear
                      ? `${fmtMD(firstDate)} – ${fmtMD(lastDate)}, ${firstYear}`
                      : `${fmtMD(firstDate)}, ${firstYear} – ${fmtMD(lastDate)}, ${lastYear}`

                    return (
                      <div className="p-5">
                        <div className="text-sm font-medium text-slate-500 mb-4">{rangeLabel}</div>
                        <div className="grid grid-cols-7 gap-px bg-slate-200 rounded-lg overflow-hidden border border-slate-200">
                          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                            <div key={d} className="bg-slate-50 text-xs font-medium text-slate-500 text-center py-2">{d}</div>
                          ))}
                          {gridDates.map((dateStr, i) => {
                            const inBlock = blockDateSet.has(dateStr)
                            const shift = inBlock ? (byDate[dateStr] ?? []).find((s) => s.clinic === clinic) : undefined
                            const day = parseInt(dateStr.slice(8))
                            const showMonthLabel = i === 0 || day === 1
                            const monthName = showMonthLabel
                              ? new Intl.DateTimeFormat('en-CA', { month: 'short', timeZone: 'UTC' }).format(new Date(dateStr + 'T00:00:00Z'))
                              : null
                            return (
                              <div key={dateStr} className={`relative bg-white min-h-[80px] p-2 ${!inBlock ? 'opacity-25' : ''}`}>
                                <div className="flex items-baseline gap-1 mb-1">
                                  <span className="text-xs font-medium text-slate-600">{day}</span>
                                  {monthName && <span className="text-xs font-semibold text-blue-500 leading-none">{monthName}</span>}
                                </div>

                                      {/* Empty cell */}
                                      {inBlock && !shift && (() => {
                                        const isAddingHere = blockIsPublished && addingShiftCell?.date === dateStr && addingShiftCell?.clinic === clinic
                                        if (isAddingHere) return (
                                          <div className="space-y-1">
                                            <TimeInput value={addCellTimes.startTime} onChange={(v) => setAddCellTimes((p) => ({ ...p, startTime: v }))} className="w-full text-xs px-1 py-0.5" />
                                            <TimeInput value={addCellTimes.endTime} onChange={(v) => setAddCellTimes((p) => ({ ...p, endTime: v }))} className="w-full text-xs px-1 py-0.5" />
                                            {addCellError && <p className="text-xs text-red-500">{addCellError}</p>}
                                            <div className="flex gap-1.5 pt-0.5">
                                              <button onClick={addCellShift} disabled={addingCell} className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-40">{addingCell ? '…' : 'Add'}</button>
                                              <button onClick={() => { setAddingShiftCell(null); setAddCellError('') }} className="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
                                            </div>
                                          </div>
                                        )
                                        if (blockIsPublished) return (
                                          <div
                                            className="text-xs text-slate-300 cursor-pointer hover:text-blue-500 transition-colors"
                                            onClick={() => {
                                              const t = clinicDefaultShiftTimes(clinic, dateStr, clinicDefaultsRef.current) ?? { startTime: '', endTime: '' }
                                              setAddingShiftCell({ date: dateStr, clinic })
                                              setAddCellTimes(t)
                                            }}
                                          >+ Add</div>
                                        )
                                        return <div className="text-xs text-slate-300">—</div>
                                      })()}

                                      {/* Cell with shift */}
                                      {shift && (() => {
                                        const resident = currentNameForShift(shift.id)
                                        const isEditing = editingShiftId === shift.id
                                        const available = availableFor(shift.id)
                                        const overlayPos = (i % 7) >= 4 ? 'right-0' : 'left-0'
                                        const segs = computeCoverageSegments(shift, assignmentMap[shift.id] ?? null, splitsByShift[shift.id] ?? [], shiftToUserId[shift.id])
                                        const hasSplits = segs.length > 1 || segs.some((sg) => currentNameForSeg(sg) !== (resident ?? ''))
                                        return (
                                          <div>
                                            {/* Resident display */}
                                            <div className="mb-1">
                                              {resident ? (
                                                hasSplits ? (
                                                  <div className="space-y-1">
                                                    {segs.map((sg, j) => {
                                                      const sgName = currentNameForSeg(sg)
                                                      return (
                                                        <div key={j}>
                                                          <div className={`text-xs font-medium leading-tight ${sgName === resident ? 'text-slate-800' : 'text-violet-700'}`}>
                                                            {displayMap[sgName] ?? sgName}
                                                          </div>
                                                          {sg.start && sg.end && <div className="text-xs text-slate-400">{formatTimeRange(sg.start, sg.end)}</div>}
                                                        </div>
                                                      )
                                                    })}
                                                  </div>
                                                ) : (
                                                  <div className="text-xs font-medium text-slate-800 leading-tight">
                                                    {displayMap[resident] ?? resident}
                                                  </div>
                                                )
                                              ) : (
                                                <div className="text-xs text-red-400 italic">Unassigned</div>
                                              )}
                                            </div>
                                            {/* Edit / remove controls */}
                                            {(isEditing && adminSplitShiftId !== shift.id) || adminSplitShiftId === shift.id || removingShiftId === shift.id ? (
                                              <>
                                                <div className="fixed inset-0 z-40 sm:hidden bg-black/30" onClick={() => { setEditingShiftId(null); setAdminSplitShiftId(null); setRemovingShiftId(null); setTimesEditError('') }} />
                                                <div className={`fixed inset-x-0 bottom-0 z-50 rounded-t-2xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:top-0 sm:z-20 sm:rounded-lg sm:min-w-[220px] ${overlayPos === 'right-0' ? 'sm:right-0 sm:left-auto' : 'sm:left-0 sm:right-auto'} bg-white border border-slate-200 shadow-md`}>
                                                  <div className="sm:hidden px-4 pt-3 pb-3 border-b border-slate-100">
                                                    <div className="w-10 h-1 bg-slate-300 rounded-full mx-auto mb-3" />
                                                    <div className="text-sm font-semibold text-slate-800">
                                                      {new Intl.DateTimeFormat('en-CA', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(dateStr + 'T00:00:00Z'))}
                                                    </div>
                                                    <div className="text-xs text-slate-500 mt-0.5">{clinicAbbr[clinic] ?? clinic}</div>
                                                  </div>
                                                  <div className="p-4 sm:p-2 overflow-y-auto max-h-[55vh] sm:max-h-none sm:overflow-y-visible">
                                                {isEditing && adminSplitShiftId !== shift.id ? (
                                                  <div onClick={(e) => e.stopPropagation()} className="space-y-2 sm:space-y-1">
                                                    {(splitsByShift[shift.id] ?? []).filter((sp) => sp.status === 'accepted').map((sp) => (
                                                      <div key={sp.id} className="flex items-center justify-between text-sm sm:text-xs bg-violet-50 rounded px-2 py-1.5 sm:px-1.5 sm:py-0.5">
                                                        <span className="text-violet-700">{sp.acceptorName} · {formatTimeRange(sp.offeredStart, sp.offeredEnd)}</span>
                                                        <button
                                                          onClick={() => removeAdminSplit(sp.id)}
                                                          disabled={removingAdminSplitId === sp.id}
                                                          className="text-red-400 hover:text-red-600 ml-2 sm:ml-1 disabled:opacity-40 text-base sm:text-xs"
                                                        >×</button>
                                                      </div>
                                                    ))}
                                                    <select
                                                      key={resident ?? ''}
                                                      defaultValue={resident ?? ''}
                                                      onChange={(e) => updateAssignment(shift.id, e.target.value || null)}
                                                      className="w-full border border-slate-200 rounded px-3 py-2 sm:px-1 sm:py-0.5 text-sm sm:text-xs focus:outline-none focus:border-blue-400"
                                                    >
                                                      <option value="">Unassigned</option>
                                                      {users.slice().sort((a, b) => a.fullName.localeCompare(b.fullName)).map((u) => {
                                                        const name = userCurrentName[u.id] ?? u.fullName
                                                        const hasSubmission = blockSubmissions.some((s) => s.userId === u.id)
                                                        const suffix = !hasSubmission ? ' (no submission)' : !available.includes(name) ? ' (unavailable)' : ''
                                                        return <option key={u.id} value={name}>{name}{suffix}</option>
                                                      })}
                                                    </select>
                                                    <div className="flex gap-2 sm:gap-1">
                                                      <TimeInput value={timesEdit.startTime} onChange={(v) => setTimesEdit((p) => ({ ...p, startTime: v }))} className="flex-1 text-sm sm:text-xs px-3 py-2 sm:px-1 sm:py-0.5" />
                                                      <span className="text-slate-300 self-center text-sm sm:text-xs">–</span>
                                                      <TimeInput value={timesEdit.endTime} onChange={(v) => setTimesEdit((p) => ({ ...p, endTime: v }))} className="flex-1 text-sm sm:text-xs px-3 py-2 sm:px-1 sm:py-0.5" />
                                                    </div>
                                                    {timesEditError && <p className="text-sm sm:text-xs text-red-500">{timesEditError}</p>}
                                                    <div className="flex items-center gap-3 sm:gap-1.5 pt-1 sm:pt-0.5 flex-wrap">
                                                      {resident && shift.startTime && shift.endTime && (
                                                        <button onClick={() => openAdminSplit(shift.id, shift)} className="text-sm sm:text-xs py-1 sm:py-0 text-violet-400 hover:text-violet-600 transition-colors">Split</button>
                                                      )}
                                                      <button onClick={() => saveShiftTimes(shift.id)} disabled={savingTimes} className="text-sm sm:text-xs py-1 sm:py-0 font-medium text-blue-600 hover:text-blue-800 disabled:opacity-40">{savingTimes ? '…' : 'Save'}</button>
                                                      <button onClick={() => { setEditingShiftId(null); setTimesEditError('') }} className="text-sm sm:text-xs py-1 sm:py-0 text-slate-400 hover:text-slate-600">Cancel</button>
                                                    </div>
                                                  </div>
                                                ) : adminSplitShiftId === shift.id ? (
                                                  <div onClick={(e) => e.stopPropagation()} className="space-y-2 sm:space-y-1">
                                                    <div className="flex gap-2 sm:gap-1">
                                                      <TimeInput value={adminSplitStart} onChange={setAdminSplitStart} className="flex-1 text-sm sm:text-xs px-3 py-2 sm:px-1 sm:py-0.5" />
                                                      <span className="text-slate-300 self-center text-sm sm:text-xs">–</span>
                                                      <TimeInput value={adminSplitEnd} onChange={setAdminSplitEnd} className="flex-1 text-sm sm:text-xs px-3 py-2 sm:px-1 sm:py-0.5" />
                                                    </div>
                                                    <select
                                                      value={adminSplitAcceptorId}
                                                      onChange={(e) => setAdminSplitAcceptorId(e.target.value)}
                                                      className="w-full border border-slate-200 rounded px-3 py-2 sm:px-1 sm:py-0.5 text-sm sm:text-xs focus:outline-none focus:border-blue-400"
                                                    >
                                                      <option value="">Covered by…</option>
                                                      {users.filter((u) => u.id !== shiftToUserId[shift.id]).map((u) => (
                                                        <option key={u.id} value={u.id}>{u.fullName}</option>
                                                      ))}
                                                    </select>
                                                    {adminSplitError && <p className="text-sm sm:text-xs text-red-500">{adminSplitError}</p>}
                                                    <div className="flex gap-3 sm:gap-1.5 pt-1 sm:pt-0.5">
                                                      <button onClick={() => adminCreateSplit(shift.id)} disabled={adminSplitting} className="text-sm sm:text-xs py-1 sm:py-0 font-medium text-violet-600 hover:text-violet-800 disabled:opacity-40">{adminSplitting ? '…' : 'Save'}</button>
                                                      <button onClick={() => setAdminSplitShiftId(null)} className="text-sm sm:text-xs py-1 sm:py-0 text-slate-400 hover:text-slate-600">Back</button>
                                                    </div>
                                                  </div>
                                                ) : (
                                                  <div onClick={(e) => e.stopPropagation()} className="text-sm sm:text-xs space-y-2 sm:space-y-1">
                                                    <p className="text-slate-600">Remove?</p>
                                                    <div className="flex gap-3 sm:gap-1.5">
                                                      <button onClick={() => removeShift(shift.id)} className="py-1 sm:py-0 font-medium text-red-500 hover:text-red-700">Remove</button>
                                                      <button onClick={() => setRemovingShiftId(null)} className="py-1 sm:py-0 text-slate-400 hover:text-slate-600">Cancel</button>
                                                    </div>
                                                  </div>
                                                )}
                                                </div>
                                              </div>
                                              </>
                                            ) : !isEditing && (
                                              <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 text-xs text-slate-400 flex-wrap">
                                                <span>{formatTimeRange(shift.startTime, shift.endTime) || 'No times'}</span>
                                                <button
                                                  onClick={() => { setEditingShiftId(shift.id); setTimesEdit({ startTime: shift.startTime ?? '', endTime: shift.endTime ?? '' }) }}
                                                  className="text-blue-400 hover:text-blue-600 transition-colors"
                                                >Edit</button>
                                                <button onClick={() => setRemovingShiftId(shift.id)} className="text-red-400 hover:text-red-500 transition-colors">Remove</button>
                                              </div>
                                            )}
                                          </div>
                                        )
                                      })()}
                                    </div>
                                  )
                                })}
                              </div>
                      </div>
                    )
                  })()
                ) : (
                  // ── Table view (all clinics) ───────────────────────────────
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-100">
                          <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Date</th>
                          {visibleClinics.map((clinic) => (
                            <th key={clinic} className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">
                              {clinicAbbr[clinic] ?? clinic}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {blockDateRange.map((date) => {
                          const shiftsOnDay = byDate[date] ?? []
                          return (
                            <tr key={date} className="border-b border-slate-100 last:border-0">
                              <td className="px-4 py-3 font-medium text-slate-700 whitespace-nowrap">
                                {formatDate(date)}
                              </td>
                              {visibleClinics.map((clinic, clinicIdx) => {
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
                                          {addCellError && <p className="text-xs text-red-500">{addCellError}</p>}
                                          <div className="flex gap-2 pt-0.5">
                                            <button onClick={addCellShift} disabled={addingCell} className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-40">
                                              {addingCell ? 'Adding…' : 'Add'}
                                            </button>
                                            <button onClick={() => { setAddingShiftCell(null); setAddCellError('') }} className="text-xs text-slate-400 hover:text-slate-600">
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
                                          const t = clinicDefaultShiftTimes(clinic, date, clinicDefaultsRef.current) ?? { startTime: '', endTime: '' }
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
                                const resident = currentNameForShift(shift.id)
                                const isEditing = editingShiftId === shift.id
                                const available = availableFor(shift.id)
                                const segs = computeCoverageSegments(shift, assignmentMap[shift.id] ?? null, splitsByShift[shift.id] ?? [], shiftToUserId[shift.id])
                                const hasSplits = resident ? (segs.length > 1 || segs.some((sg) => currentNameForSeg(sg) !== resident)) : false
                                const overlayPos = clinicIdx >= visibleClinics.length - 1 ? 'right-0' : 'left-0'

                                return (
                                  <td
                                    key={clinic}
                                    className="relative px-4 py-3"
                                  >
                                    <div className="mb-1">
                                      {resident ? (
                                        hasSplits ? (
                                          <div className="space-y-0.5">
                                            {segs.map((sg, i) => {
                                              const sgName = currentNameForSeg(sg)
                                              return (
                                                <div key={i} className="text-xs leading-snug">
                                                  <span className={sgName === resident ? 'font-medium text-slate-800' : 'font-medium text-violet-700'}>
                                                    {displayMap[sgName] ?? sgName}
                                                  </span>
                                                  {sg.start && sg.end && (
                                                    <span className="text-slate-400 ml-1">{formatTimeRange(sg.start, sg.end)}</span>
                                                  )}
                                                </div>
                                              )
                                            })}
                                          </div>
                                        ) : (
                                          <span className="font-medium text-slate-800">{displayMap[resident] ?? resident}</span>
                                        )
                                      ) : (
                                        <span className="text-red-400 text-xs italic">Unassigned</span>
                                      )}
                                    </div>
                                    {(isEditing && adminSplitShiftId !== shift.id) || adminSplitShiftId === shift.id || removingShiftId === shift.id ? (
                                      <div className={`absolute ${overlayPos} top-0 z-20 min-w-[220px] bg-white border border-slate-200 rounded-lg shadow-md p-2`}>
                                        {isEditing && adminSplitShiftId !== shift.id ? (
                                          <div onClick={(e) => e.stopPropagation()} className="space-y-1">
                                            {(splitsByShift[shift.id] ?? []).filter((sp) => sp.status === 'accepted').map((sp) => (
                                              <div key={sp.id} className="flex items-center justify-between text-xs bg-violet-50 rounded px-1.5 py-0.5">
                                                <span className="text-violet-700">{sp.acceptorName} · {formatTimeRange(sp.offeredStart, sp.offeredEnd)}</span>
                                                <button
                                                  onClick={() => removeAdminSplit(sp.id)}
                                                  disabled={removingAdminSplitId === sp.id}
                                                  className="text-red-400 hover:text-red-600 ml-1 disabled:opacity-40"
                                                >×</button>
                                              </div>
                                            ))}
                                            <select
                                              key={resident ?? ''}
                                              defaultValue={resident ?? ''}
                                              onChange={(e) => updateAssignment(shift.id, e.target.value || null)}
                                              className="w-full border border-slate-200 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-blue-400"
                                            >
                                              <option value="">Unassigned</option>
                                              {users.slice().sort((a, b) => a.fullName.localeCompare(b.fullName)).map((u) => {
                                                const name = userCurrentName[u.id] ?? u.fullName
                                                const hasSubmission = blockSubmissions.some((s) => s.userId === u.id)
                                                const suffix = !hasSubmission ? ' (no submission)' : !available.includes(name) ? ' (unavailable)' : ''
                                                return <option key={u.id} value={name}>{name}{suffix}</option>
                                              })}
                                            </select>
                                            <div className="flex gap-1">
                                              <TimeInput
                                                value={timesEdit.startTime}
                                                onChange={(v) => setTimesEdit((p) => ({ ...p, startTime: v }))}
                                                className="flex-1 text-xs px-1.5 py-0.5"
                                              />
                                              <span className="text-slate-300 self-center text-xs">–</span>
                                              <TimeInput
                                                value={timesEdit.endTime}
                                                onChange={(v) => setTimesEdit((p) => ({ ...p, endTime: v }))}
                                                className="flex-1 text-xs px-1.5 py-0.5"
                                              />
                                            </div>
                                            {timesEditError && <p className="text-xs text-red-500">{timesEditError}</p>}
                                            <div className="flex items-center gap-2 pt-0.5">
                                              {resident && shift.startTime && shift.endTime && (
                                                <button onClick={() => openAdminSplit(shift.id, shift)} className="text-xs text-violet-400 hover:text-violet-600 transition-colors">Split</button>
                                              )}
                                              <button onClick={() => saveShiftTimes(shift.id)} disabled={savingTimes} className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-40">
                                                {savingTimes ? 'Saving…' : 'Save'}
                                              </button>
                                              <button onClick={() => { setEditingShiftId(null); setTimesEditError('') }} className="text-xs text-slate-400 hover:text-slate-600">
                                                Cancel
                                              </button>
                                            </div>
                                          </div>
                                        ) : adminSplitShiftId === shift.id ? (
                                          <div onClick={(e) => e.stopPropagation()} className="space-y-1">
                                            <div className="flex gap-1">
                                              <TimeInput value={adminSplitStart} onChange={setAdminSplitStart} className="flex-1 text-xs px-1.5 py-0.5" />
                                              <span className="text-slate-300 self-center">–</span>
                                              <TimeInput value={adminSplitEnd} onChange={setAdminSplitEnd} className="flex-1 text-xs px-1.5 py-0.5" />
                                            </div>
                                            <select
                                              value={adminSplitAcceptorId}
                                              onChange={(e) => setAdminSplitAcceptorId(e.target.value)}
                                              className="w-full border border-slate-200 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-blue-400"
                                            >
                                              <option value="">Covered by…</option>
                                              {users.filter((u) => u.id !== shiftToUserId[shift.id]).map((u) => (
                                                <option key={u.id} value={u.id}>{u.fullName}</option>
                                              ))}
                                            </select>
                                            {adminSplitError && <p className="text-xs text-red-500">{adminSplitError}</p>}
                                            <div className="flex gap-2 pt-0.5">
                                              <button onClick={() => adminCreateSplit(shift.id)} disabled={adminSplitting} className="text-xs font-medium text-violet-600 hover:text-violet-800 disabled:opacity-40">{adminSplitting ? '…' : 'Save'}</button>
                                              <button onClick={() => setAdminSplitShiftId(null)} className="text-xs text-slate-400 hover:text-slate-600">Back</button>
                                            </div>
                                          </div>
                                        ) : (
                                          <div onClick={(e) => e.stopPropagation()} className="text-xs space-y-1">
                                            <p className="text-slate-600">Remove this shift?</p>
                                            <div className="flex gap-2">
                                              <button onClick={() => removeShift(shift.id)} className="font-medium text-red-500 hover:text-red-700">Remove</button>
                                              <button onClick={() => setRemovingShiftId(null)} className="text-slate-400 hover:text-slate-600">Cancel</button>
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    ) : (
                                      <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-2 text-xs text-slate-400">
                                        <span>{formatTimeRange(shift.startTime, shift.endTime) || 'No times'}</span>
                                        <button
                                          onClick={() => { setEditingShiftId(shift.id); setTimesEdit({ startTime: shift.startTime ?? '', endTime: shift.endTime ?? '' }) }}
                                          className="text-blue-400 hover:text-blue-600 transition-colors"
                                        >
                                          Edit
                                        </button>
                                        <button onClick={() => setRemovingShiftId(shift.id)} className="text-red-400 hover:text-red-500 transition-colors">
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
                )}
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
              {/* Mobile cards */}
              <div className="sm:hidden divide-y divide-slate-100">
                {users
                  .slice()
                  .sort((a, b) => a.fullName.localeCompare(b.fullName))
                  .map((u) => (
                    <div key={u.id} className="px-4 py-3 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-medium text-slate-800 text-sm truncate">{u.fullName}</span>
                          <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${u.role === 'admin' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                            {u.role}
                          </span>
                        </div>
                        {u.id !== user?.id && (
                          <div className="flex items-center gap-3 shrink-0">
                            <button
                              onClick={() => setRole(u.id, u.role === 'admin' ? 'resident' : 'admin')}
                              disabled={promotingUserId === u.id}
                              className="text-xs text-blue-500 hover:text-blue-700 transition-colors disabled:opacity-40"
                            >
                              {promotingUserId === u.id ? '…' : u.role === 'admin' ? 'Demote' : 'Make admin'}
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
                      </div>
                      <div className="text-xs text-slate-500 break-all">{u.email}</div>
                      {u.phone && <div className="text-xs text-slate-500">{formatPhone(u.phone)}</div>}
                      <div className="text-xs text-slate-400">
                        Joined {new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium' }).format(new Date(u.createdAt))}
                      </div>
                    </div>
                  ))}
              </div>
              {/* Desktop table */}
              <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50">
                    <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Name</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Email</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Phone</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Role</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Joined</th>
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
                        <td className="px-4 py-3 text-slate-500">{u.phone ? formatPhone(u.phone) : <span className="text-slate-300">—</span>}</td>
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
              </div>
            </>
          )}
        </div>
      )}

      {/* ── SWAPS TAB ── */}
      {tab === 'swaps' && (() => {
        const swapsBlockShiftIds = swapsBlockFilter
          ? new Set(shifts.filter((s) => s.periodId === periods.find((p) => p.name === swapsBlockFilter)?.id).map((s) => s.id))
          : null
        const visibleSwaps = swapsBlockShiftIds
          ? swapRequests.filter((r) => swapsBlockShiftIds.has(r.requestorShiftId))
          : swapRequests
        return (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          {swapRequests.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-sm">No swap requests yet.</div>
          ) : (
            <>
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex flex-wrap items-center gap-3 justify-between">
                <h2 className="text-sm font-semibold text-slate-700">Swap Requests</h2>
                <div className="flex flex-wrap items-center gap-3">
                  <select
                    value={swapsBlockFilter}
                    onChange={(e) => setSwapsBlockFilter(e.target.value)}
                    className="border border-slate-300 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400"
                  >
                    <option value="">All blocks</option>
                    {periods.slice().sort((a, b) => b.startDate.localeCompare(a.startDate)).map((p) => (
                      <option key={p.id} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                  <div className="flex gap-3 text-xs text-slate-400">
                    <span>{visibleSwaps.filter((r) => r.status === 'pending').length} pending</span>
                    <span>{visibleSwaps.filter((r) => r.status === 'accepted').length} accepted</span>
                    <span>{visibleSwaps.filter((r) => r.status === 'cancelled').length} cancelled</span>
                  </div>
                </div>
              </div>
              {/* Mobile cards */}
              <div className="sm:hidden divide-y divide-slate-100">
                {visibleSwaps
                  .slice()
                  .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
                  .map((req) => {
                    const offeredShift = shifts.find((s) => s.id === req.requestorShiftId)
                    const reqName = (req.requestorUserId && userCurrentName[req.requestorUserId]) ? userCurrentName[req.requestorUserId] : req.requestorName
                    const accName = req.acceptorUserId ? (userCurrentName[req.acceptorUserId] ?? req.acceptorName) : req.acceptorName
                    return (
                      <div key={req.id} className="px-4 py-3 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${req.status === 'pending' ? 'bg-amber-100 text-amber-700' : req.status === 'accepted' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                              {req.status}
                            </span>
                            <span className="font-medium text-slate-800 text-sm">{reqName}</span>
                          </div>
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
                              className="text-xs text-red-400 hover:text-red-600 transition-colors shrink-0"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                        {offeredShift ? (
                          <div className="text-xs text-slate-600">
                            <span className="font-medium">{formatDate(offeredShift.date)}</span>
                            <span className="text-slate-400 ml-1">· {clinicAbbr[offeredShift.clinic] ?? offeredShift.clinic}</span>
                          </div>
                        ) : null}
                        {accName && (
                          <div className="text-xs text-slate-500">Taken by {accName}</div>
                        )}
                        <div className="text-xs text-slate-400">
                          {new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(req.requestedAt))}
                        </div>
                      </div>
                    )
                  })}
              </div>
              {/* Desktop table */}
              <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50">
                    <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Requestor</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Shift offered</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Accepted by</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {visibleSwaps
                    .slice()
                    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
                    .map((req) => {
                      const offeredShift = shifts.find((s) => s.id === req.requestorShiftId)
                      const reqName = (req.requestorUserId && userCurrentName[req.requestorUserId]) ? userCurrentName[req.requestorUserId] : req.requestorName
                      const accName = req.acceptorUserId ? (userCurrentName[req.acceptorUserId] ?? req.acceptorName) : req.acceptorName
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
                          <td className="px-4 py-3 font-medium text-slate-800">{reqName}</td>
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
                          <td className="px-4 py-3 text-slate-600">{accName ?? '—'}</td>
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
              </div>
            </>
          )}
        </div>
        )
      })()}
      {/* ── CLINIC MANAGEMENT TAB ── */}
      {tab === 'clinics' && (
        <div className="space-y-3">
          {/* Add Clinic CTA at top */}
          {!showAddClinic ? (
            <div>
              <button
                onClick={() => { setShowAddClinic(true); setAddClinicError('') }}
                className="text-xs text-blue-600 hover:text-blue-800 border border-blue-200 rounded-lg px-3 py-1.5 transition-colors"
              >
                + Add Clinic
              </button>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-5 py-5 space-y-4">
              <div className="text-sm font-medium text-slate-800">New Clinic</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Clinic name</label>
                  <input value={addClinicName} onChange={(e) => setAddClinicName(e.target.value)} placeholder="e.g. Lions Gate Hospital" className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Abbreviation</label>
                  <input value={addClinicAbbr} onChange={(e) => setAddClinicAbbr(e.target.value)} placeholder="e.g. LGH" className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1.5">Active days</div>
                <div className="flex gap-1">
                  {DAY_ORDER.map((day) => {
                    const active = addClinicActiveDays.has(day)
                    return (
                      <button key={day} onClick={() => setAddClinicActiveDays((prev) => { const next = new Set(prev); active ? next.delete(day) : next.add(day); return next })} className={`w-8 h-8 text-xs rounded-full font-medium transition-colors ${active ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                        {DAY_LABELS[day]}
                      </button>
                    )
                  })}
                </div>
              </div>
              {[1, 2, 3, 4, 5].some((d) => addClinicActiveDays.has(d)) && (
                <div>
                  <div className="text-xs text-slate-500 mb-1.5">Weekday times</div>
                  <div className="flex items-center gap-2">
                    <TimeInput value={addClinicWeekdayStart} onChange={setAddClinicWeekdayStart} className="w-24 px-2 py-1 text-sm" />
                    <span className="text-slate-400 text-xs">–</span>
                    <TimeInput value={addClinicWeekdayEnd} onChange={setAddClinicWeekdayEnd} className="w-24 px-2 py-1 text-sm" />
                  </div>
                </div>
              )}
              {[0, 6].some((d) => addClinicActiveDays.has(d)) && (
                <div>
                  <div className="text-xs text-slate-500 mb-1.5">Weekend times</div>
                  <div className="flex items-center gap-2">
                    <TimeInput value={addClinicWeekendStart} onChange={setAddClinicWeekendStart} className="w-24 px-2 py-1 text-sm" />
                    <span className="text-slate-400 text-xs">–</span>
                    <TimeInput value={addClinicWeekendEnd} onChange={setAddClinicWeekendEnd} className="w-24 px-2 py-1 text-sm" />
                  </div>
                </div>
              )}
              <div>
                <div className="text-xs text-slate-500 mb-2">Billing entity</div>
                <div className="flex gap-4 mb-3">
                  <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                    <input type="radio" checked={addClinicBillingType === 'existing'} onChange={() => setAddClinicBillingType('existing')} className="accent-blue-600" />
                    Use existing
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                    <input type="radio" checked={addClinicBillingType === 'new'} onChange={() => setAddClinicBillingType('new')} className="accent-blue-600" />
                    Create new
                  </label>
                </div>
                {addClinicBillingType === 'existing' ? (
                  <select value={addClinicEntityCode} onChange={(e) => setAddClinicEntityCode(e.target.value)} className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 w-full max-w-xs">
                    <option value="">Select entity…</option>
                    {billingEntities.map((e) => <option key={e.code} value={e.code}>{ENTITY_DISPLAY[e.code] ?? e.code}</option>)}
                  </select>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Entity code</label>
                        <input value={addClinicNewCode} onChange={(e) => setAddClinicNewCode(e.target.value.toUpperCase().replace(/\s+/g, ''))} placeholder="e.g. LGHMR" className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-400" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Hourly rate ($/hr)</label>
                        <input type="number" min="0" step="0.01" value={addClinicNewRate} onChange={(e) => setAddClinicNewRate(e.target.value)} placeholder="75.00" className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Contact person (optional)</label>
                        <input value={addClinicNewContact} onChange={(e) => setAddClinicNewContact(e.target.value)} placeholder="e.g. Jane Smith" className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Organization</label>
                        <input value={addClinicNewOrg} onChange={(e) => setAddClinicNewOrg(e.target.value)} placeholder="e.g. Lions Gate Radiology" className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Billing address</label>
                      <textarea value={addClinicNewAddress} onChange={(e) => setAddClinicNewAddress(e.target.value)} rows={2} placeholder={'231 East 15th St\nNorth Vancouver BC  V7L 2L7'} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none" />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Billing email (optional)</label>
                      <input type="email" value={addClinicNewEmail} onChange={(e) => setAddClinicNewEmail(e.target.value)} placeholder="billing@example.com" className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
                    </div>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button onClick={handleAddClinic} disabled={addClinicSaving} className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors">{addClinicSaving ? 'Saving…' : 'Add Clinic'}</button>
                <button onClick={() => { setShowAddClinic(false); setAddClinicError('') }} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">Cancel</button>
                {addClinicError && <span className="text-xs text-red-500">{addClinicError}</span>}
              </div>
            </div>
          )}

          {/* Active clinic cards */}
          {clinicDefaults.map((def) => {
            const clinic = def.name
            const isExpanded = expandedClinics.has(clinic)
            const isEditing = editingClinic === clinic
            const isComplex = def.billingEntityCodes.some((code) => COMPLEX_ENTITY_RATES[code] !== undefined)
            const hasWeekdays = (def.activeDays ?? []).some((d) => d >= 1 && d <= 5)
            const hasWeekends = (def.activeDays ?? []).some((d) => d === 0 || d === 6)
            const editHasWeekdays = isEditing ? [...clinicEdit.activeDays].some((d) => d >= 1 && d <= 5) : false
            const editHasWeekends = isEditing ? [...clinicEdit.activeDays].some((d) => d === 0 || d === 6) : false
            const simpleRateCode = !isComplex && def.billingEntityCodes.length === 1 ? def.billingEntityCodes[0] : null
            const simpleRate = simpleRateCode !== null ? billingRates[`${simpleRateCode}_rate`] : undefined
            return (
              <div key={clinic} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                {/* Clickable header row */}
                <button
                  onClick={() => setExpandedClinics((prev) => { const next = new Set(prev); isExpanded ? next.delete(clinic) : next.add(clinic); return next })}
                  className="w-full px-5 py-4 flex items-center gap-3 text-left hover:bg-slate-50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-semibold text-slate-800">{clinic}</span>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <div className="flex gap-1">
                        {DAY_ORDER.map((day) => {
                          const active = (def.activeDays ?? []).includes(day)
                          return (
                            <span key={day} className={`w-6 h-6 text-xs flex items-center justify-center rounded-full font-medium ${active ? 'bg-blue-100 text-blue-700' : 'text-slate-200'}`}>
                              {DAY_LABELS[day]}
                            </span>
                          )
                        })}
                      </div>
                      {hasWeekdays && def.weekdayStart && def.weekdayEnd && (
                        <span className="text-xs text-slate-500">Weekday: {formatTimeValue(def.weekdayStart)} – {formatTimeValue(def.weekdayEnd)}</span>
                      )}
                      {hasWeekends && def.weekendStart && def.weekendEnd && (
                        <span className="text-xs text-slate-500">Weekend: {formatTimeValue(def.weekendStart)} – {formatTimeValue(def.weekendEnd)}</span>
                      )}
                    </div>
                  </div>
                  <svg className={`w-4 h-4 text-slate-400 transition-transform shrink-0 ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {isExpanded && (
                  <div className="border-t border-slate-100">
                    {isEditing ? (
                      /* ── Edit mode ── */
                      <div className="px-5 py-4 space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">Clinic name</label>
                            <input value={clinicEdit.name} onChange={(e) => setClinicEdit((p) => ({ ...p, name: e.target.value }))} className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
                          </div>
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">Abbreviation</label>
                            <input value={clinicEdit.abbreviation} onChange={(e) => setClinicEdit((p) => ({ ...p, abbreviation: e.target.value }))} className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-500 mb-1.5">Active days</div>
                          <div className="flex gap-1">
                            {DAY_ORDER.map((day) => {
                              const active = clinicEdit.activeDays.has(day)
                              return (
                                <button key={day} type="button"
                                  onClick={() => setClinicEdit((prev) => { const next = new Set(prev.activeDays); active ? next.delete(day) : next.add(day); return { ...prev, activeDays: next } })}
                                  className={`w-8 h-8 text-xs rounded-full font-medium transition-colors ${active ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                                >
                                  {DAY_LABELS[day]}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                        {(editHasWeekdays || editHasWeekends) && (
                          <div className="flex flex-wrap gap-x-6 gap-y-3">
                            {editHasWeekdays && (
                              <div>
                                <div className="text-xs text-slate-500 mb-1.5">Weekday times</div>
                                <div className="flex items-center gap-2">
                                  <TimeInput value={clinicEdit.weekdayStart} onChange={(v) => setClinicEdit((p) => ({ ...p, weekdayStart: v }))} className="w-24 px-2 py-1 text-sm" />
                                  <span className="text-slate-400 text-xs">–</span>
                                  <TimeInput value={clinicEdit.weekdayEnd} onChange={(v) => setClinicEdit((p) => ({ ...p, weekdayEnd: v }))} className="w-24 px-2 py-1 text-sm" />
                                </div>
                              </div>
                            )}
                            {editHasWeekends && (
                              <div>
                                <div className="text-xs text-slate-500 mb-1.5">Weekend times</div>
                                <div className="flex items-center gap-2">
                                  <TimeInput value={clinicEdit.weekendStart} onChange={(v) => setClinicEdit((p) => ({ ...p, weekendStart: v }))} className="w-24 px-2 py-1 text-sm" />
                                  <span className="text-slate-400 text-xs">–</span>
                                  <TimeInput value={clinicEdit.weekendEnd} onChange={(v) => setClinicEdit((p) => ({ ...p, weekendEnd: v }))} className="w-24 px-2 py-1 text-sm" />
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        {isComplex && (
                          <div className="pt-2 border-t border-slate-100">
                            <div className="text-xs text-slate-500 mb-1.5">PET end time</div>
                            <TimeInput value={clinicEdit.petEndTime} onChange={(v) => setClinicEdit((p) => ({ ...p, petEndTime: v }))} className="w-24 px-2 py-1 text-sm" />
                          </div>
                        )}
                        {def.billingEntityCodes.map((entityCode) => {
                          const complexRows = COMPLEX_ENTITY_RATES[entityCode]
                          const displayName = ENTITY_DISPLAY[entityCode] ?? entityCode
                          const contact = clinicEdit.contacts[entityCode]
                          return (
                            <div key={entityCode} className="space-y-3 pt-2 border-t border-slate-100">
                              {isComplex && <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{displayName}</div>}
                              {complexRows ? (
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                  {complexRows.map((row) => (
                                    <div key={row.key}>
                                      <label className="block text-xs text-slate-500 mb-1">{row.label}</label>
                                      <div className="flex items-center gap-1">
                                        <span className="text-xs text-slate-400">$</span>
                                        <input type="number" min="0" step="0.01" value={clinicEdit.rates[row.key] ?? ''} onChange={(e) => setClinicEdit((p) => ({ ...p, rates: { ...p.rates, [row.key]: e.target.value } }))} className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
                                        <span className="text-xs text-slate-400">/hr</span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="flex items-center gap-2">
                                  <label className="text-xs text-slate-500 w-20 shrink-0">Hourly rate</label>
                                  <span className="text-xs text-slate-400">$</span>
                                  <input type="number" min="0" step="0.01" value={clinicEdit.rates[`${entityCode}_rate`] ?? ''} onChange={(e) => setClinicEdit((p) => ({ ...p, rates: { ...p.rates, [`${entityCode}_rate`]: e.target.value } }))} className="w-24 border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
                                  <span className="text-xs text-slate-400">/hr</span>
                                </div>
                              )}
                              {contact && (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                  <div>
                                    <label className="block text-xs text-slate-400 mb-0.5">Contact person</label>
                                    <input value={contact.contactName} onChange={(e) => setClinicEdit((p) => ({ ...p, contacts: { ...p.contacts, [entityCode]: { ...p.contacts[entityCode], contactName: e.target.value } } }))} placeholder="e.g. Jane Smith" className="w-full border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400" />
                                  </div>
                                  <div>
                                    <label className="block text-xs text-slate-400 mb-0.5">Organization</label>
                                    <input value={contact.org} onChange={(e) => setClinicEdit((p) => ({ ...p, contacts: { ...p.contacts, [entityCode]: { ...p.contacts[entityCode], org: e.target.value } } }))} className="w-full border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400" />
                                  </div>
                                  <div>
                                    <label className="block text-xs text-slate-400 mb-0.5">Address</label>
                                    <textarea value={contact.address} onChange={(e) => setClinicEdit((p) => ({ ...p, contacts: { ...p.contacts, [entityCode]: { ...p.contacts[entityCode], address: e.target.value } } }))} rows={2} className="w-full border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none" />
                                  </div>
                                  <div>
                                    <label className="block text-xs text-slate-400 mb-0.5">Email (optional)</label>
                                    <input type="email" value={contact.email} onChange={(e) => setClinicEdit((p) => ({ ...p, contacts: { ...p.contacts, [entityCode]: { ...p.contacts[entityCode], email: e.target.value } } }))} className="w-full border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400" />
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })}
                        <div className="flex items-center gap-1.5 pt-1">
                          <span className="text-xs text-slate-400">Billing entity:</span>
                          {def.billingEntityCodes.map((code) => (
                            <span key={code} className="text-xs font-mono bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">{code}</span>
                          ))}
                        </div>
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            disabled={savingClinic}
                            onClick={async () => {
                              if (!clinicEdit.name.trim()) { setClinicEditError('Name is required'); return }
                              const activeDays = [...clinicEdit.activeDays].sort()
                              const hasWd = activeDays.some((d) => d >= 1 && d <= 5)
                              const hasWe = activeDays.some((d) => d === 0 || d === 6)
                              const weekdayStart = hasWd ? clinicEdit.weekdayStart || null : null
                              const weekdayEnd   = hasWd ? clinicEdit.weekdayEnd   || null : null
                              const weekendStart = hasWe ? clinicEdit.weekendStart || null : null
                              const weekendEnd   = hasWe ? clinicEdit.weekendEnd   || null : null
                              setSavingClinic(true)
                              setClinicEditError('')
                              try {
                                const saves: Promise<Response>[] = [
                                  fetch('/api/admin/clinics', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...def, name: clinicEdit.name.trim(), abbreviation: clinicEdit.abbreviation.trim(), activeDays, weekdayStart, weekdayEnd, weekendStart, weekendEnd, petEndTime: clinicEdit.petEndTime || null }) }),
                                ]
                                for (const [key, val] of Object.entries(clinicEdit.rates)) {
                                  const num = parseFloat(val)
                                  if (!isNaN(num) && num >= 0) saves.push(fetch('/api/admin/billing-rates', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value: num }) }))
                                }
                                for (const [entityCode, c] of Object.entries(clinicEdit.contacts)) {
                                  saves.push(fetch('/api/admin/billing-contacts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entity: entityCode, ...c, email: c.email || null }) }))
                                }
                                const results = await Promise.all(saves)
                                if (results.some((r) => !r.ok)) { setClinicEditError('Failed to save'); return }
                                const newName = clinicEdit.name.trim()
                                setClinicDefaults((prev) => prev.map((d) => d.id === def.id ? { ...d, name: newName, abbreviation: clinicEdit.abbreviation.trim(), activeDays, weekdayStart, weekdayEnd, weekendStart, weekendEnd, petEndTime: clinicEdit.petEndTime || null } : d))
                                const rateUpdates: Record<string, number> = {}
                                for (const [key, val] of Object.entries(clinicEdit.rates)) { const n = parseFloat(val); if (!isNaN(n)) rateUpdates[key] = n }
                                setBillingRates((prev) => ({ ...prev, ...rateUpdates }))
                                for (const [entityCode, c] of Object.entries(clinicEdit.contacts)) {
                                  setBillingContacts((prev) => {
                                    const existing = prev.find((x) => x.entity === entityCode)
                                    const record = { entity: entityCode, ...c, email: c.email || null }
                                    return existing ? prev.map((x) => x.entity === entityCode ? record : x) : [...prev, record]
                                  })
                                }
                                if (newName !== def.name) {
                                  setExpandedClinics((prev) => { const next = new Set(prev); next.delete(def.name); next.add(newName); return next })
                                }
                                setEditingClinic(null)
                              } finally {
                                setSavingClinic(false)
                              }
                            }}
                            className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors"
                          >
                            {savingClinic ? 'Saving…' : 'Save'}
                          </button>
                          <button onClick={() => { setEditingClinic(null); setClinicEditError(''); setArchivingClinic(null); setDeletingClinic(null) }} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">Cancel</button>
                          {archivingClinic === clinic ? (
                            <span className="flex items-center gap-2 ml-auto">
                              <span className="text-xs text-slate-500">Archive &ldquo;{def.name}&rdquo;?</span>
                              <button
                                onClick={async () => {
                                  const res = await fetch('/api/admin/clinics', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: def.id, archived: true }) })
                                  if (res.ok) {
                                    setClinicDefaults((prev) => prev.filter((d) => d.id !== def.id))
                                    setArchivedClinics((prev) => [...prev, { ...def, archivedAt: new Date().toISOString() }])
                                    setEditingClinic(null); setArchivingClinic(null)
                                    setExpandedClinics((prev) => { const next = new Set(prev); next.delete(clinic); return next })
                                  } else {
                                    setClinicEditError('Failed to archive')
                                  }
                                }}
                                className="text-xs bg-amber-500 text-white px-2.5 py-1 rounded-lg hover:bg-amber-600 transition-colors"
                              >
                                Confirm archive
                              </button>
                              <button onClick={() => setArchivingClinic(null)} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">No</button>
                            </span>
                          ) : deletingClinic === clinic ? (
                            <span className="flex items-center gap-2 ml-auto">
                              <span className="text-xs text-slate-500">Permanently delete &ldquo;{def.name}&rdquo;?</span>
                              <button
                                onClick={async () => {
                                  const res = await fetch('/api/admin/clinics', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: def.id }) })
                                  if (res.ok) {
                                    setClinicDefaults((prev) => prev.filter((d) => d.id !== def.id))
                                    setEditingClinic(null); setDeletingClinic(null)
                                    setExpandedClinics((prev) => { const next = new Set(prev); next.delete(clinic); return next })
                                  } else {
                                    const data = await res.json().catch(() => ({}))
                                    setClinicEditError((data as { error?: string }).error ?? 'Failed to delete')
                                    setDeletingClinic(null)
                                  }
                                }}
                                className="text-xs bg-red-600 text-white px-2.5 py-1 rounded-lg hover:bg-red-700 transition-colors"
                              >
                                Confirm delete
                              </button>
                              <button onClick={() => setDeletingClinic(null)} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">No</button>
                            </span>
                          ) : (
                            <span className="flex items-center gap-3 ml-auto">
                              <button onClick={() => setArchivingClinic(clinic)} className="text-xs text-amber-600 hover:text-amber-800 transition-colors">Archive</button>
                              <button onClick={() => setDeletingClinic(clinic)} className="text-xs text-red-500 hover:text-red-700 transition-colors">Delete</button>
                            </span>
                          )}
                          {clinicEditError && <span className="text-xs text-red-500">{clinicEditError}</span>}
                        </div>
                      </div>
                    ) : (
                      /* ── Read-only view ── */
                      <div className="px-5 py-4 space-y-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                            <div className="flex gap-0.5">
                              {DAY_ORDER.map((day) => {
                                const active = (def.activeDays ?? []).includes(day)
                                return (
                                  <span key={day} className={`w-7 h-7 flex items-center justify-center rounded-full text-xs font-medium ${active ? 'bg-blue-100 text-blue-700' : 'text-slate-200'}`}>
                                    {DAY_LABELS[day]}
                                  </span>
                                )
                              })}
                            </div>
                            {hasWeekdays && def.weekdayStart && def.weekdayEnd && (
                              <span>Weekday: {formatTimeValue(def.weekdayStart)} – {formatTimeValue(def.weekdayEnd)}</span>
                            )}
                            {hasWeekends && def.weekendStart && def.weekendEnd && (
                              <span>Weekend: {formatTimeValue(def.weekendStart)} – {formatTimeValue(def.weekendEnd)}</span>
                            )}
                          </div>
                          <button
                            onClick={() => {
                              setClinicEditError('')
                              setClinicEdit({
                                name: def.name,
                                abbreviation: def.abbreviation,
                                activeDays: new Set(def.activeDays ?? []),
                                weekdayStart: def.weekdayStart ?? '',
                                weekdayEnd: def.weekdayEnd ?? '',
                                weekendStart: def.weekendStart ?? '',
                                weekendEnd: def.weekendEnd ?? '',
                                petEndTime: def.petEndTime ?? '',
                                rates: Object.fromEntries(
                                  def.billingEntityCodes.flatMap((code) => {
                                    const rows = COMPLEX_ENTITY_RATES[code]
                                    if (rows) return rows.map((r) => [r.key, billingRates[r.key] !== undefined ? String(billingRates[r.key]) : ''])
                                    return [[`${code}_rate`, billingRates[`${code}_rate`] !== undefined ? String(billingRates[`${code}_rate`]) : '']]
                                  })
                                ),
                                contacts: Object.fromEntries(
                                  def.billingEntityCodes.map((code) => {
                                    const c = billingContacts.find((x) => x.entity === code)
                                    return [code, { contactName: c?.contactName ?? '', org: c?.org ?? '', address: c?.address ?? '', email: c?.email ?? '' }]
                                  })
                                ),
                              })
                              setEditingClinic(clinic)
                            }}
                            className="text-xs text-blue-600 hover:text-blue-800 transition-colors shrink-0"
                          >
                            Edit
                          </button>
                        </div>
                        {def.billingEntityCodes.map((entityCode) => {
                          const complexRows = COMPLEX_ENTITY_RATES[entityCode]
                          const contact = billingContacts.find((c) => c.entity === entityCode)
                          const displayName = ENTITY_DISPLAY[entityCode] ?? billingEntities.find((e) => e.code === entityCode)?.label ?? entityCode
                          return (
                            <div key={entityCode} className={isComplex ? 'rounded-lg border border-slate-200 overflow-hidden' : ''}>
                              {isComplex && (
                                <div className="px-4 py-2 bg-slate-50 border-b border-slate-100">
                                  <span className="text-xs font-semibold text-slate-600">{displayName}</span>
                                </div>
                              )}
                              <div className={isComplex ? 'px-4 py-3 space-y-3' : 'space-y-2'}>
                                {complexRows ? (
                                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                                    {complexRows.map((row) => {
                                      const val = billingRates[row.key]
                                      return <span key={row.key}>{row.label}: <span className="font-medium text-slate-800">{val !== undefined ? `$${val.toFixed(0)}/hr` : '—'}</span></span>
                                    })}
                                  </div>
                                ) : (
                                  <div className="text-xs text-slate-600">Rate: <span className="font-medium text-slate-800">{billingRates[`${entityCode}_rate`] !== undefined ? `$${billingRates[`${entityCode}_rate`].toFixed(0)}/hr` : '—'}</span></div>
                                )}
                                <div className="text-xs text-slate-500 space-y-0.5">
                                  {contact?.contactName && <div className="font-medium text-slate-700">{contact.contactName}</div>}
                                  {contact?.org && <div>{contact.org}</div>}
                                  {contact?.address && contact.address.split('\n').map((l, i) => <div key={i}>{l}</div>)}
                                  {contact?.email && <div>{contact.email}</div>}
                                  {!contact && <div className="italic text-slate-300">No billing contact</div>}
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {/* Archived clinics section */}
          {archivedClinics.length > 0 && (
            <div className="mt-4">
              <button
                onClick={() => setShowArchivedSection((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors"
              >
                <span className={`transition-transform ${showArchivedSection ? 'rotate-90' : ''}`}>▶</span>
                Archived clinics ({archivedClinics.length})
              </button>
              {showArchivedSection && (
                <div className="mt-2 space-y-2">
                  {archivedClinics.map((def) => (
                    <div key={def.id} className="bg-white rounded-xl border border-slate-200 shadow-sm px-5 py-3 flex items-center justify-between gap-3 opacity-60">
                      <span className="text-sm font-medium text-slate-600">{def.name}</span>
                      <div className="flex items-center gap-3 shrink-0">
                        <button
                          onClick={async () => {
                            const res = await fetch('/api/admin/clinics', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: def.id, archived: false }) })
                            if (res.ok) {
                              setArchivedClinics((prev) => prev.filter((c) => c.id !== def.id))
                              setClinicDefaults((prev) => [...prev, { ...def, archivedAt: null }].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)))
                            }
                          }}
                          className="text-xs text-blue-600 hover:text-blue-800 transition-colors"
                        >
                          Unarchive
                        </button>
                        {deletingClinic === def.id ? (
                          <span className="flex items-center gap-2">
                            <span className="text-xs text-slate-500">Delete permanently?</span>
                            <button
                              onClick={async () => {
                                const res = await fetch('/api/admin/clinics', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: def.id }) })
                                if (res.ok) {
                                  setArchivedClinics((prev) => prev.filter((c) => c.id !== def.id))
                                  setDeletingClinic(null)
                                } else {
                                  const data = await res.json().catch(() => ({}))
                                  alert((data as { error?: string }).error ?? 'Cannot delete this clinic')
                                  setDeletingClinic(null)
                                }
                              }}
                              className="text-xs bg-red-600 text-white px-2.5 py-1 rounded-lg hover:bg-red-700 transition-colors"
                            >
                              Confirm
                            </button>
                            <button onClick={() => setDeletingClinic(null)} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">No</button>
                          </span>
                        ) : (
                          <button onClick={() => setDeletingClinic(def.id)} className="text-xs text-red-500 hover:text-red-700 transition-colors">Delete</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
