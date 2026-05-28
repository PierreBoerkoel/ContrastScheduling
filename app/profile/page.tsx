'use client'

import { useEffect, useRef, useState } from 'react'
import { useUser } from '@clerk/nextjs'
import type { Shift, SchedulingPeriod, ShiftAssignment, ShiftSplit, ClinicName, Clinic } from '@/lib/types'
import { formatTimeRange, computeCoverageSegments } from '@/lib/types'
import { calculateLineItems, ratesToBillingRates } from '@/lib/invoices'
import type { CompletedShiftForInvoice } from '@/lib/invoices'
import InvoiceGenerator from '@/app/components/InvoiceGenerator'

const DAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const VAN_TZ = 'America/Vancouver'

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  if (digits.length === 11 && digits[0] === '1') return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  return raw
}

// Returns current Vancouver date as YYYY-MM-DD
function vanToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: VAN_TZ })
}

// Returns current Vancouver time as HH:MM (24h)
function vanNowTime(): string {
  return new Date().toLocaleTimeString('en-CA', { timeZone: VAN_TZ, hour12: false }).slice(0, 5)
}

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


function isShiftEnded(shift: { date: string; endTime?: string }): boolean {
  const today = vanToday()
  if (shift.endTime) {
    return today > shift.date || (today === shift.date && vanNowTime() >= shift.endTime)
  }
  return today > shift.date
}

function isShiftInProgress(shift: { date: string; startTime?: string; endTime?: string }): boolean {
  const today = vanToday()
  if (shift.date !== today) return false
  const now = vanNowTime()
  if (shift.startTime && shift.endTime) return now >= shift.startTime && now < shift.endTime
  return false
}

function nextDayStr(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().split('T')[0].replace(/-/g, '')
}

function formatCompactTime(startTime?: string, endTime?: string): string {
  if (!startTime || !endTime) return ''
  const fmt = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    const hour = h % 12 || 12
    return m === 0 ? `${hour}` : `${hour}:${m.toString().padStart(2, '0')}`
  }
  const startH = parseInt(startTime.split(':')[0])
  const endH = parseInt(endTime.split(':')[0])
  const sameHalf = (startH < 12) === (endH < 12)
  const ampm = endH < 12 ? 'a' : 'p'
  return sameHalf
    ? `${fmt(startTime)}–${fmt(endTime)}${ampm}`
    : `${fmt(startTime)}a–${fmt(endTime)}p`
}

function googleCalendarUrl(shift: Shift) {
  const dateBase = shift.date.replace(/-/g, '')
  if (shift.startTime && shift.endTime) {
    const startTs = `${dateBase}T${shift.startTime.replace(':', '')}00`
    const endTs = `${dateBase}T${shift.endTime.replace(':', '')}00`
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: `Contrast Call – ${shift.clinic}`,
      dates: `${startTs}/${endTs}`,
      details: `Contrast coverage call shift at ${shift.clinic}\n${formatTimeRange(shift.startTime, shift.endTime)}`,
    })
    return `https://calendar.google.com/calendar/render?${params}`
  }
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Contrast Call – ${shift.clinic}`,
    dates: `${dateBase}/${nextDayStr(shift.date)}`,
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
    'BEGIN:VTIMEZONE',
    'TZID:America/Vancouver',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0700',
    'TZOFFSETTO:-0800',
    'TZNAME:PST',
    'DTSTART:19701101T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0800',
    'TZOFFSETTO:-0700',
    'TZNAME:PDT',
    'DTSTART:19700308T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
  ]
  for (const s of shifts) {
    const dateBase = s.date.replace(/-/g, '')
    const timed = s.startTime && s.endTime
    lines.push(
      'BEGIN:VEVENT',
      `UID:${s.id}@contrast-scheduling`,
      timed
        ? `DTSTART;TZID=America/Vancouver:${dateBase}T${s.startTime!.replace(':', '')}00`
        : `DTSTART;VALUE=DATE:${dateBase}`,
      timed
        ? `DTEND;TZID=America/Vancouver:${dateBase}T${s.endTime!.replace(':', '')}00`
        : `DTEND;VALUE=DATE:${nextDayStr(s.date)}`,
      `SUMMARY:Contrast Call – ${s.clinic}`,
      `DESCRIPTION:Contrast coverage call shift at ${s.clinic}${timed ? `\\n${formatTimeRange(s.startTime, s.endTime)}` : ''}`,
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
  const myUserId = user?.id ?? ''

  const [shifts, setShifts] = useState<Shift[]>([])
  const [periods, setPeriods] = useState<SchedulingPeriod[]>([])
  const [allSplits, setAllSplits] = useState<ShiftSplit[]>([])
  const [loading, setLoading] = useState(true)
  const [showGoogleLinks, setShowGoogleLinks] = useState(false)

  const [editingContact, setEditingContact] = useState(false)
  const [contactFirstName, setContactFirstName] = useState('')
  const [contactLastName, setContactLastName] = useState('')
  const [contactAddress, setContactAddress] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactSaving, setContactSaving] = useState(false)
  const [contactError, setContactError] = useState('')

  const [showInvoiceGenerator, setShowInvoiceGenerator] = useState(false)
  const [showEarningsCsv, setShowEarningsCsv] = useState(false)
  const [contactPrompt, setContactPrompt] = useState(false)
  const contactCardRef = useRef<HTMLDivElement>(null)
  const [earningsFrom, setEarningsFrom] = useState(() => `${vanToday().slice(0, 4)}-01-01`)
  const [earningsTo, setEarningsTo] = useState(() => vanToday())
  const [downloadingCsv, setDownloadingCsv] = useState(false)
  const [toggledMonths, setToggledMonths] = useState<Set<string>>(new Set())

  type ClinicDayPrefs = Record<string, { weekday: boolean; weekend: boolean }>
  const [shiftDefaults, setShiftDefaults] = useState<ClinicDayPrefs>({})
  const [editingDefaults, setEditingDefaults] = useState(false)
  const [editingPrefs, setEditingPrefs] = useState(false)
  const [defaultsSaving, setDefaultsSaving] = useState(false)
  const [defaultsError, setDefaultsError] = useState('')
  const [prefsSaving, setPrefsSaving] = useState(false)
  const [prefsError, setPrefsError] = useState('')
  const defaultsSnapshot = useRef<ClinicDayPrefs>({})
  const [weekdayRanking, setWeekdayRanking] = useState<string[]>([])
  const [weekendRanking, setWeekendRanking] = useState<string[]>([])
  const weekdayRankingSnapshot = useRef<string[]>([])
  const weekendRankingSnapshot = useRef<string[]>([])
  const [clinics, setClinics] = useState<Clinic[]>([])
  const clinicNames = clinics.map((c) => c.name)
  const clinicAbbrMap = Object.fromEntries(clinics.map((c) => [c.name, c.abbreviation]))
  const clinicAbbr = (clinic: string) => clinicAbbrMap[clinic] ?? clinic
  const clinicEntityMap = Object.fromEntries(clinics.map((c) => [c.name, c.billingEntityCodes]))

  // Re-render every 60 s so isShiftEnded() stays current without a page refresh
  const [, forceUpdate] = useState(0)
  useEffect(() => {
    const id = setInterval(() => forceUpdate((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  const [vanYear, vanMonth] = vanToday().split('-').map(Number)
  const [calYear, setCalYear] = useState(vanYear)
  const [calMonth, setCalMonth] = useState(vanMonth - 1) // 0-indexed

  useEffect(() => {
    Promise.all([
      fetch('/api/shifts').then((r) => r.json()),
      fetch('/api/periods?all=true').then((r) => r.json()),
      fetch('/api/splits').then((r) => r.json()),
      fetch('/api/admin/clinic-defaults?includeArchived=true').then((r) => r.json()),
    ]).then(([shiftList, periodList, splitList, clinicList]) => {
      setShifts(Array.isArray(shiftList) ? shiftList : [])
      setPeriods(Array.isArray(periodList) ? periodList : [])
      setAllSplits(Array.isArray(splitList) ? splitList : [])
      if (Array.isArray(clinicList)) setClinics(clinicList)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (!user) return
    fetch('/api/preferences')
      .then((r) => r.json())
      .then(async (data) => {
        // Migrate shiftDefaults from Clerk metadata if not yet in DB
        const meta = user.unsafeMetadata as { shiftDefaults?: ClinicDayPrefs } | undefined
        if (Object.keys(data.shiftDefaults ?? {}).length === 0 && meta?.shiftDefaults && Object.keys(meta.shiftDefaults).length > 0) {
          await fetch('/api/preferences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shiftDefaults: meta.shiftDefaults }),
          })
          await user.update({ unsafeMetadata: { ...user.unsafeMetadata, shiftDefaults: undefined } })
          setShiftDefaults(meta.shiftDefaults)
        } else {
          setShiftDefaults(data.shiftDefaults ?? {})
        }
        setWeekdayRanking(data.weekdayRanking ?? [])
        setWeekendRanking(data.weekendRanking ?? [])
      })
      .catch(() => {})
  }, [user])

  async function saveContact() {
    if (!user) return
    setContactSaving(true)
    setContactError('')
    try {
      await user.update({
        firstName: contactFirstName.trim(),
        lastName: contactLastName.trim(),
        unsafeMetadata: {
          ...(user.unsafeMetadata ?? {}),
          address: contactAddress.trim(),
          phone: contactPhone.trim(),
          email: contactEmail.trim(),
        },
      })
      setEditingContact(false)
    } catch (e) {
      setContactError(e instanceof Error ? e.message : 'Failed to update contact info')
    } finally {
      setContactSaving(false)
    }
  }

  function startEditContact() {
    const meta = user?.unsafeMetadata as { address?: string; phone?: string; email?: string } | undefined
    setContactFirstName(user?.firstName ?? '')
    setContactLastName(user?.lastName ?? '')
    setContactAddress(meta?.address ?? '')
    setContactPhone(meta?.phone ?? '')
    setContactEmail(meta?.email ?? user?.primaryEmailAddress?.emailAddress ?? '')
    setContactError('')
    setEditingContact(true)
  }

  async function saveDefaults() {
    setDefaultsSaving(true)
    setDefaultsError('')
    try {
      const res = await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shiftDefaults }),
      })
      if (!res.ok) throw new Error('Failed to save')
      setEditingDefaults(false)
    } catch (e) {
      setDefaultsError(e instanceof Error ? e.message : 'Failed to save preferences')
    } finally {
      setDefaultsSaving(false)
    }
  }

  async function savePrefs() {
    setPrefsSaving(true)
    setPrefsError('')
    try {
      const res = await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekdayRanking, weekendRanking }),
      })
      if (!res.ok) throw new Error('Failed to save')
      setEditingPrefs(false)
    } catch (e) {
      setPrefsError(e instanceof Error ? e.message : 'Failed to save preferences')
    } finally {
      setPrefsSaving(false)
    }
  }

  if (!isLoaded || loading) return null

  const today = vanToday()

  const shiftById = Object.fromEntries(shifts.map((s) => [s.id, s]))
  const publishedAssignments = periods.flatMap((p) => p.publishedAssignments)

  function assignmentToShift(a: ShiftAssignment): Shift | null {
    if (shiftById[a.shiftId]) return shiftById[a.shiftId]
    if (a.date && a.clinic) return { id: a.shiftId, date: a.date, clinic: a.clinic as ClinicName, startTime: a.startTime, endTime: a.endTime } as Shift
    return null
  }

  // Build split-aware coverage: resolve exact time windows each resident covers
  const splitsByShift: Record<string, ShiftSplit[]> = {}
  for (const s of allSplits) (splitsByShift[s.shiftId] ??= []).push(s)

  // My coverage from the published schedule (direct assignments, split-aware)
  const myScheduleCoverage: Shift[] = []
  for (const a of publishedAssignments.filter((a) => a.userId === myUserId)) {
    const base = assignmentToShift(a)
    if (!base) continue
    const segs = computeCoverageSegments(base, a.residentName, splitsByShift[a.shiftId] ?? [], a.userId)
    for (const seg of segs.filter((s) => s.userId === myUserId)) {
      myScheduleCoverage.push({
        ...base,
        startTime: seg.start || base.startTime,
        endTime: seg.end || base.endTime,
      })
    }
  }

  // My coverage from accepted splits where I am the acceptor.
  // Deduplicated per shift so multiple accepted splits from the same shift are merged correctly.
  const mySplitCoverage: Shift[] = []
  const acceptorShiftIds = [...new Set(
    allSplits
      .filter((s) => s.status === 'accepted' && s.acceptorUserId === myUserId)
      .map((s) => s.shiftId)
  )]
  for (const sid of acceptorShiftIds) {
    const shift = shiftById[sid]
    if (!shift) continue  // shift from a deleted period not in shiftById
    const base = assignmentToShift({ shiftId: sid, residentName: myName })
    if (!base) continue
    if (!shift.startTime || !shift.endTime) {
      mySplitCoverage.push(base)
      continue
    }
    const assignment = publishedAssignments.find((a) => a.shiftId === sid)
    const segs = computeCoverageSegments(shift, assignment?.residentName ?? null, splitsByShift[sid] ?? [], assignment?.userId ?? null)
    for (const seg of segs.filter((s) => s.userId === myUserId)) {
      mySplitCoverage.push({
        ...base,
        startTime: seg.start || base.startTime,
        endTime: seg.end || base.endTime,
      })
    }
  }

  const allMyCoverage = [...myScheduleCoverage, ...mySplitCoverage]

  // Upcoming: not yet ended and not from a deleted block
  const deletedPeriodIds = new Set(periods.filter((p) => p.deletedAt).map((p) => p.id))
  const upcoming: Shift[] = allMyCoverage
    .filter((s) => !isShiftEnded(s) && !deletedPeriodIds.has(s.periodId ?? ''))
    .sort((a, b) => a.date.localeCompare(b.date))

  // Completed: ended shifts from all periods (including soft-deleted) via allMyCoverage
  const completedMap = new Map<string, Shift>()
  for (const s of allMyCoverage.filter(isShiftEnded)) {
    completedMap.set(`${s.id}::${s.startTime ?? ''}`, s)
  }
  const completed: Shift[] = [...completedMap.values()].sort((a, b) => b.date.localeCompare(a.date))

  // Group completed shifts by month for collapsible display (used when >= 10 shifts)
  const completedByMonth: { key: string; label: string; shifts: Shift[] }[] = []
  for (const s of completed) {
    const key = s.date.slice(0, 7)
    const last = completedByMonth[completedByMonth.length - 1]
    if (last?.key === key) {
      last.shifts.push(s)
    } else {
      const [y, m] = key.split('-').map(Number)
      const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      completedByMonth.push({ key, label, shifts: [s] })
    }
  }
  const mostRecentMonthKey = completedByMonth[0]?.key ?? ''
  function toggleMonth(key: string) {
    setToggledMonths((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }
  function isMonthExpanded(key: string): boolean {
    const toggled = toggledMonths.has(key)
    // Most recent month defaults to expanded; all others default to collapsed
    return key === mostRecentMonthKey ? !toggled : toggled
  }

  // Contact info for invoice generation (stored in Clerk unsafeMetadata)
  const meta = user?.unsafeMetadata as { address?: string; phone?: string; email?: string } | undefined
  const invoiceFrom = {
    name: myName,
    address: meta?.address ?? '',
    phone: meta?.phone ?? '',
    email: meta?.email ?? user?.primaryEmailAddress?.emailAddress ?? '',
  }
  const hasContactInfo = !!(invoiceFrom.address && invoiceFrom.phone && invoiceFrom.email)

  // Completed shifts eligible for invoice generation (must have time data and a billing entity)
  const invoiceableCompleted: CompletedShiftForInvoice[] = completed
    .filter((s) => s.startTime && s.endTime && (clinicEntityMap[s.clinic]?.length ?? 0) > 0)
    .map((s) => ({
      shiftId: `${s.id}::${s.startTime}`,
      date: s.date,
      clinic: s.clinic,
      startTime: s.startTime!,
      endTime: s.endTime!,
    }))

  // Combined for the calendar view (all my coverage, split-aware)
  const myCalendarShifts = [...upcoming, ...completed]

  const myDateToShifts: Record<string, Shift[]> = {}
  for (const s of myCalendarShifts) {
    (myDateToShifts[s.date] ??= []).push(s)
  }

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
  const monthLabel = new Intl.DateTimeFormat('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(calYear, calMonth, 1)))

  async function downloadEarningsCsv() {
    setDownloadingCsv(true)
    try {
      const rawRates = await fetch('/api/admin/billing-rates').then((r) => r.json())
      const rates = ratesToBillingRates(rawRates)

      const inRange = invoiceableCompleted.filter(
        (s) => s.date >= earningsFrom && s.date <= earningsTo
      )

      type Row = { date: string; clinic: string; entity: string; description: string; hours: number; rate: number; amount: number }
      const rows: Row[] = []

      for (const shift of inRange) {
        const entities = clinicEntityMap[shift.clinic] ?? []
        for (const entity of entities) {
          const items = calculateLineItems(shift, null, rates)[entity]
          for (const item of items) {
            rows.push({
              date: shift.date,
              clinic: shift.clinic,
              entity,
              description: item.description,
              hours: item.hours,
              rate: item.ratePerHour,
              amount: item.amount,
            })
          }
        }
      }

      const total = rows.reduce((sum, r) => sum + r.amount, 0)
      const fmt = (n: number) => n.toFixed(2)
      const fmtDate = (d: string) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'))

      const header = 'Date,Clinic,Entity,Description,Hours,Rate ($/hr),Amount ($)\n'
      const body = rows.map((r) =>
        `"${fmtDate(r.date)}","${r.clinic}",${r.entity},"${r.description}",${fmt(r.hours)},${fmt(r.rate)},${fmt(r.amount)}`
      ).join('\n')
      const footer = `\n,,,,,,${fmt(total)}`
      const note = rows.some((r) => r.clinic === 'BC Cancer Agency MRI/PET')
        ? '\n"Note: BC Cancer Agency MRI/PET amounts assume standard MRI + PET mode."'
        : ''

      const csv = header + body + footer + note
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `earnings_${earningsFrom}_to_${earningsTo}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setDownloadingCsv(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-10 space-y-8">
      {/* ── Header ── */}
      <h1 className="text-2xl font-bold text-slate-800">My Profile</h1>

      {/* ── Contact details ── */}
      <div ref={contactCardRef} className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-start justify-between mb-1">
          <div>
            <h2 className="text-sm font-semibold text-slate-700">Contact Details</h2>
            <p className="text-xs text-slate-400 mt-0.5">Required for invoice generation</p>
          </div>
          {!editingContact && (
            <button
              onClick={startEditContact}
              className="text-xs text-blue-600 hover:text-blue-800 border border-blue-200 rounded px-2 py-0.5 transition-colors"
            >
              {hasContactInfo ? 'Edit' : 'Add'}
            </button>
          )}
        </div>

        {editingContact ? (
          <div className="space-y-3 mt-3">
            <div className="flex gap-3 flex-wrap">
              <div className="flex-1 min-w-36">
                <label className="block text-xs text-slate-500 mb-1">First name</label>
                <input
                  value={contactFirstName}
                  onChange={(e) => setContactFirstName(e.target.value)}
                  placeholder="Jane"
                  className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>
              <div className="flex-1 min-w-36">
                <label className="block text-xs text-slate-500 mb-1">Last name</label>
                <input
                  value={contactLastName}
                  onChange={(e) => setContactLastName(e.target.value)}
                  placeholder="Smith"
                  className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Address</label>
              <textarea
                value={contactAddress}
                onChange={(e) => setContactAddress(e.target.value)}
                rows={3}
                placeholder={'123 Main St\nVancouver BC  V6B 2W9'}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"
              />
            </div>
            <div className="flex gap-3 flex-wrap">
              <div className="flex-1 min-w-48">
                <label className="block text-xs text-slate-500 mb-1">Phone</label>
                <input
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  placeholder="604-555-0100"
                  className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>
              <div className="flex-1 min-w-48">
                <label className="block text-xs text-slate-500 mb-1">Email</label>
                <input
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="you@example.com"
                  type="email"
                  className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={saveContact}
                disabled={contactSaving}
                className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
              >
                {contactSaving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => setEditingContact(false)}
                className="text-sm text-slate-500 hover:text-slate-700 px-2 py-1.5"
              >
                Cancel
              </button>
              {contactError && <span className="text-sm text-red-500">{contactError}</span>}
            </div>
          </div>
        ) : hasContactInfo ? (
          <div className="text-sm text-slate-500 space-y-0.5 mt-3">
            <p className="font-medium text-slate-700">{myName}</p>
            {invoiceFrom.address.split('\n').map((l, i) => <p key={i}>{l}</p>)}
            <p>{formatPhone(invoiceFrom.phone)}</p>
            <p>{invoiceFrom.email}</p>
          </div>
        ) : (
          <p className="text-sm text-slate-400 mt-3">Add your name, address, phone, and email to enable invoice generation.</p>
        )}
      </div>

      {/* ── Default Shift Availability ── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-start justify-between mb-1">
          <div>
            <h2 className="text-sm font-semibold text-slate-700">Default Shift Availability</h2>
            <p className="text-xs text-slate-400 mt-0.5">Pre-fills your availability form each block</p>
          </div>
          {!editingDefaults && (
            <button
              onClick={() => {
                defaultsSnapshot.current = { ...shiftDefaults }
                setShiftDefaults((prev) => {
                  const next = { ...prev }
                  for (const clinic of clinicNames) {
                    if (!next[clinic]) next[clinic] = { weekday: true, weekend: true }
                  }
                  return next
                })
                setEditingDefaults(true)
                setDefaultsError('')
              }}
              className="text-xs text-blue-600 hover:text-blue-800 border border-blue-200 rounded px-2 py-0.5 transition-colors"
            >
              {Object.keys(shiftDefaults).length > 0 ? 'Edit' : 'Set up'}
            </button>
          )}
        </div>

        {editingDefaults ? (
          <div className="mt-3 space-y-3">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="text-left text-xs font-medium text-slate-500 pb-2 pr-6">Clinic</th>
                    <th className="text-xs font-medium text-slate-500 pb-2 px-4 text-center">Weekdays</th>
                    <th className="text-xs font-medium text-slate-500 pb-2 px-4 text-center">Weekends</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {clinicNames.map((clinic) => {
                    const d = shiftDefaults[clinic] ?? { weekday: true, weekend: true }
                    return (
                      <tr key={clinic}>
                        <td className="py-2.5 pr-6 text-sm text-slate-700 whitespace-nowrap">{clinicAbbr(clinic)}</td>
                        <td className="py-2.5 px-4 text-center">
                          <input
                            type="checkbox"
                            checked={d.weekday}
                            onChange={(e) => setShiftDefaults((prev) => ({ ...prev, [clinic]: { ...d, weekday: e.target.checked } }))}
                            className="w-4 h-4 accent-blue-600 cursor-pointer"
                          />
                        </td>
                        <td className="py-2.5 px-4 text-center">
                          <input
                            type="checkbox"
                            checked={d.weekend}
                            onChange={(e) => setShiftDefaults((prev) => ({ ...prev, [clinic]: { ...d, weekend: e.target.checked } }))}
                            className="w-4 h-4 accent-blue-600 cursor-pointer"
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={saveDefaults}
                disabled={defaultsSaving}
                className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
              >
                {defaultsSaving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => { setShiftDefaults(defaultsSnapshot.current); setEditingDefaults(false); setDefaultsError('') }}
                className="text-sm text-slate-500 hover:text-slate-700 px-2 py-1.5"
              >
                Cancel
              </button>
              {defaultsError && <span className="text-sm text-red-500">{defaultsError}</span>}
            </div>
          </div>
        ) : Object.keys(shiftDefaults).length > 0 ? (
          <div className="mt-3 divide-y divide-slate-100">
            {clinicNames.map((clinic) => {
              const d = shiftDefaults[clinic] ?? { weekday: true, weekend: true }
              const parts = [...(d.weekday ? ['weekdays'] : []), ...(d.weekend ? ['weekends'] : [])]
              return (
                <div key={clinic} className="flex items-center justify-between py-1.5">
                  <span className="text-sm text-slate-600">{clinicAbbr(clinic)}</span>
                  <span className={`text-xs font-medium ${parts.length === 0 ? 'text-slate-300' : 'text-slate-500'}`}>
                    {parts.length === 0 ? 'Not available' : parts.join(' & ')}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-slate-400 mt-3">Not configured. The availability form will start empty until you set your defaults.</p>
        )}
      </div>

      {/* ── Shift Preferences ── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-start justify-between mb-1">
          <div>
            <h2 className="text-sm font-semibold text-slate-700">Shift Preferences</h2>
            <p className="text-xs text-slate-400 mt-0.5">Rank the shifts you'd prefer to work</p>
          </div>
          {!editingPrefs && (
            <button
              onClick={() => {
                weekdayRankingSnapshot.current = [...weekdayRanking]
                weekendRankingSnapshot.current = [...weekendRanking]
                setEditingPrefs(true)
                setPrefsError('')
              }}
              className="text-xs text-blue-600 hover:text-blue-800 border border-blue-200 rounded px-2 py-0.5 transition-colors"
            >
              {(weekdayRanking.length > 0 || weekendRanking.length > 0) ? 'Edit' : 'Set up'}
            </button>
          )}
        </div>

        {editingPrefs ? (
          <div className="mt-3 space-y-4">
            <div className="grid grid-cols-2 gap-6">
              {/* Weekday ranking */}
              <div>
                <p className="text-xs font-semibold text-slate-500 mb-2">Weekday</p>
                <div className="space-y-0.5">
                  {weekdayRanking.map((clinic, idx) => (
                    <div key={clinic} className="flex items-center gap-1 py-1 border-b border-slate-100">
                      <span className="text-xs text-slate-400 w-4 shrink-0 text-right">{idx + 1}.</span>
                      <span className="flex-1 text-xs text-slate-700 truncate ml-1">{clinicAbbr(clinic)}</span>
                      <button
                        disabled={idx === 0}
                        onClick={() => setWeekdayRanking((r) => { const n = [...r]; [n[idx - 1], n[idx]] = [n[idx], n[idx - 1]]; return n })}
                        className="text-slate-300 hover:text-slate-600 disabled:opacity-30 px-0.5 leading-none"
                      >↑</button>
                      <button
                        disabled={idx === weekdayRanking.length - 1}
                        onClick={() => setWeekdayRanking((r) => { const n = [...r]; [n[idx], n[idx + 1]] = [n[idx + 1], n[idx]]; return n })}
                        className="text-slate-300 hover:text-slate-600 disabled:opacity-30 px-0.5 leading-none"
                      >↓</button>
                      <button
                        onClick={() => setWeekdayRanking((r) => r.filter((_, i) => i !== idx))}
                        className="text-slate-300 hover:text-red-500 px-0.5 ml-0.5 leading-none"
                      >×</button>
                    </div>
                  ))}
                  {clinicNames.filter((c) => !weekdayRanking.includes(c)).map((clinic) => (
                    <div key={clinic} className="flex items-center gap-1 py-1">
                      <span className="w-4 shrink-0" />
                      <span className="flex-1 text-xs text-slate-400 truncate ml-1">{clinicAbbr(clinic)}</span>
                      <button
                        onClick={() => setWeekdayRanking((r) => [...r, clinic])}
                        className="text-slate-300 hover:text-blue-500 px-1 text-base leading-none"
                        title={`Add to weekday ranking`}
                      >+</button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Weekend ranking */}
              <div>
                <p className="text-xs font-semibold text-slate-500 mb-2">Weekend</p>
                <div className="space-y-0.5">
                  {weekendRanking.map((clinic, idx) => (
                    <div key={clinic} className="flex items-center gap-1 py-1 border-b border-slate-100">
                      <span className="text-xs text-slate-400 w-4 shrink-0 text-right">{idx + 1}.</span>
                      <span className="flex-1 text-xs text-slate-700 truncate ml-1">{clinicAbbr(clinic)}</span>
                      <button
                        disabled={idx === 0}
                        onClick={() => setWeekendRanking((r) => { const n = [...r]; [n[idx - 1], n[idx]] = [n[idx], n[idx - 1]]; return n })}
                        className="text-slate-300 hover:text-slate-600 disabled:opacity-30 px-0.5 leading-none"
                      >↑</button>
                      <button
                        disabled={idx === weekendRanking.length - 1}
                        onClick={() => setWeekendRanking((r) => { const n = [...r]; [n[idx], n[idx + 1]] = [n[idx + 1], n[idx]]; return n })}
                        className="text-slate-300 hover:text-slate-600 disabled:opacity-30 px-0.5 leading-none"
                      >↓</button>
                      <button
                        onClick={() => setWeekendRanking((r) => r.filter((_, i) => i !== idx))}
                        className="text-slate-300 hover:text-red-500 px-0.5 ml-0.5 leading-none"
                      >×</button>
                    </div>
                  ))}
                  {clinicNames.filter((c) => !weekendRanking.includes(c)).map((clinic) => (
                    <div key={clinic} className="flex items-center gap-1 py-1">
                      <span className="w-4 shrink-0" />
                      <span className="flex-1 text-xs text-slate-400 truncate ml-1">{clinicAbbr(clinic)}</span>
                      <button
                        onClick={() => setWeekendRanking((r) => [...r, clinic])}
                        className="text-slate-300 hover:text-blue-500 px-1 text-base leading-none"
                        title={`Add to weekend ranking`}
                      >+</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={savePrefs}
                disabled={prefsSaving}
                className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
              >
                {prefsSaving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => { setWeekdayRanking(weekdayRankingSnapshot.current); setWeekendRanking(weekendRankingSnapshot.current); setEditingPrefs(false); setPrefsError('') }}
                className="text-sm text-slate-500 hover:text-slate-700 px-2 py-1.5"
              >
                Cancel
              </button>
              {prefsError && <span className="text-sm text-red-500">{prefsError}</span>}
            </div>
          </div>
        ) : (weekdayRanking.length > 0 || weekendRanking.length > 0) ? (
          <div className="mt-3 grid grid-cols-2 gap-6">
            <div>
              <p className="text-xs font-semibold text-slate-500 mb-1.5">Weekday</p>
              {weekdayRanking.length > 0 ? (
                <ol className="space-y-1">
                  {weekdayRanking.map((clinic, idx) => (
                    <li key={clinic} className="flex items-center gap-1.5 text-xs text-slate-600">
                      <span className="text-slate-400 w-4 text-right shrink-0">{idx + 1}.</span>
                      <span>{clinicAbbr(clinic)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-xs text-slate-400 italic">No preference</p>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-500 mb-1.5">Weekend</p>
              {weekendRanking.length > 0 ? (
                <ol className="space-y-1">
                  {weekendRanking.map((clinic, idx) => (
                    <li key={clinic} className="flex items-center gap-1.5 text-xs text-slate-600">
                      <span className="text-slate-400 w-4 text-right shrink-0">{idx + 1}.</span>
                      <span>{clinicAbbr(clinic)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-xs text-slate-400 italic">No preference</p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-400 mt-2">No preferences set.</p>
        )}

        <p className="text-xs text-slate-500 mt-4 leading-relaxed">
          Scheduling works by random draw — all available residents have equal odds of being selected regardless of their rankings. When selected, you&apos;re placed at your top-ranked shift still available that day. If preferences aren&apos;t set, you&apos;re placed randomly among your remaining available options.
        </p>
      </div>

      {publishedAssignments.length === 0 && completed.length === 0 ? (
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
                const dayShifts = myDateToShifts[dateStr] ?? []
                const hasShift = dayShifts.length > 0
                const isToday = dateStr === today
                const isPast = dateStr < today || (hasShift && dayShifts.every((s) => isShiftEnded(s)))
                const isInProgress = hasShift && dayShifts.some((s) => isShiftInProgress(s))
                const tooltipParts = dayShifts.map((s) => {
                  const t = formatTimeRange(s.startTime, s.endTime)
                  return t ? `${s.clinic} (${t})` : s.clinic
                })
                return (
                  <div
                    key={dateStr}
                    title={tooltipParts.join(', ')}
                    className={`aspect-square flex flex-col items-center justify-center text-center rounded-lg text-xs select-none
                      ${hasShift
                        ? isInProgress
                          ? 'bg-green-500 text-white'
                          : isPast
                          ? 'bg-slate-500 text-white'
                          : 'bg-blue-600 text-white'
                        : isToday
                        ? 'border-2 border-blue-400 text-blue-600 font-semibold'
                        : 'text-slate-600'
                      }`}
                  >
                    <span className="font-medium">{d.getUTCDate()}</span>
                    {dayShifts.length === 1 && (
                      <>
                        <span className="text-[9px] leading-tight opacity-80">{clinicAbbr(dayShifts[0].clinic)}</span>
                        {formatCompactTime(dayShifts[0].startTime, dayShifts[0].endTime) && (
                          <span className="hidden sm:inline text-[8px] leading-tight opacity-70">
                            {formatCompactTime(dayShifts[0].startTime, dayShifts[0].endTime)}
                          </span>
                        )}
                      </>
                    )}
                    {dayShifts.length > 1 && (
                      <span className="text-[9px] leading-tight opacity-80">{dayShifts.length} shifts</span>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex gap-4 text-xs text-slate-500">
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded bg-green-500 inline-block" /> In progress
                </span>
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
                    <span className="text-xs text-blue-600 group-hover:text-blue-700">{clinicAbbr(s.clinic)} →</span>
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* ── Upcoming shifts list ── */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">Upcoming Shifts</h2>
              <span className="text-xs text-slate-400">{upcoming.length} total</span>
            </div>
            {upcoming.length === 0 ? (
              <p className="p-5 text-sm text-slate-400">No upcoming shifts.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {upcoming.map((s) => {
                  const inProgress = isShiftInProgress(s)
                  return (
                    <div key={s.id} className="px-5 py-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-slate-700">
                          <span className="sm:hidden">{formatDateShort(s.date)}</span>
                          <span className="hidden sm:inline">{formatDateLong(s.date)}</span>
                        </span>
                        {inProgress && (
                          <span className="text-xs text-green-700 bg-green-50 px-2 py-0.5 rounded-full font-medium">In progress</span>
                        )}
                      </div>
                      <div className="text-right">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${inProgress ? 'text-green-700 bg-green-50' : 'text-blue-700 bg-blue-50'}`}>
                          {clinicAbbr(s.clinic)}
                        </span>
                        {formatTimeRange(s.startTime, s.endTime) && (
                          <div className="text-xs text-slate-400 mt-0.5">{formatTimeRange(s.startTime, s.endTime)}</div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* ── Completed shifts list ── */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">Completed Shifts</h2>
              <div className="flex items-center gap-3">
                <span className="hidden sm:inline text-xs text-slate-400">{completed.length} total</span>
                {invoiceableCompleted.length > 0 && (
                  <>
                    <button
                      onClick={() => { setShowEarningsCsv((v) => !v); setShowInvoiceGenerator(false) }}
                      className="flex items-center gap-1.5 text-xs text-blue-600 border border-blue-200 rounded-lg px-2.5 py-1 hover:bg-blue-50 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      {showEarningsCsv
                        ? <><span className="sm:hidden">Hide</span><span className="hidden sm:inline">Hide CSV</span></>
                        : <><span className="sm:hidden">CSV</span><span className="hidden sm:inline">Download CSV</span></>
                      }
                    </button>
                    <button
                      onClick={() => {
                        if (!hasContactInfo) {
                          startEditContact()
                          setContactPrompt(true)
                          contactCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                          return
                        }
                        setContactPrompt(false)
                        setShowInvoiceGenerator((v) => !v)
                        setShowEarningsCsv(false)
                      }}
                      className="flex items-center gap-1.5 text-xs text-blue-600 border border-blue-200 rounded-lg px-2.5 py-1 hover:bg-blue-50 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      {showInvoiceGenerator
                        ? <><span className="sm:hidden">Hide</span><span className="hidden sm:inline">Hide invoice</span></>
                        : <><span className="sm:hidden">Invoice</span><span className="hidden sm:inline">Generate invoice</span></>
                      }
                    </button>
                  </>
                )}
              </div>
            </div>

            {contactPrompt && !hasContactInfo && (
              <div className="px-5 py-2.5 border-b border-amber-100 bg-amber-50 text-xs text-amber-700">
                Fill in your contact details to generate an invoice.
              </div>
            )}

            {showEarningsCsv && invoiceableCompleted.length > 0 && (
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex flex-wrap items-end gap-4">
                <label className="flex flex-col gap-1 text-xs text-slate-500">
                  From
                  <input
                    type="date"
                    value={earningsFrom}
                    onChange={(e) => setEarningsFrom(e.target.value)}
                    className="border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-slate-500">
                  To
                  <input
                    type="date"
                    value={earningsTo}
                    onChange={(e) => setEarningsTo(e.target.value)}
                    className="border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  />
                </label>
                <button
                  onClick={downloadEarningsCsv}
                  disabled={downloadingCsv || !earningsFrom || !earningsTo}
                  className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  {downloadingCsv
                    ? 'Downloading…'
                    : <><span className="sm:hidden">CSV</span><span className="hidden sm:inline">Download CSV</span></>
                  }
                </button>
              </div>
            )}
            {showInvoiceGenerator && invoiceableCompleted.length > 0 && (
              <div className="px-5 py-4 border-b border-slate-100 bg-blue-50">
                <InvoiceGenerator
                  completed={invoiceableCompleted}
                  allShifts={shifts}
                  from={invoiceFrom}
                  onMissingProfile={() => {
                    setShowInvoiceGenerator(false)
                    startEditContact()
                  }}
                  clinicEntityMap={clinicEntityMap}
                  clinicAbbrMap={clinicAbbrMap}
                  petEndTime={clinics.find((c) => c.name === 'BC Cancer Agency MRI/PET')?.petEndTime ?? undefined}
                />
              </div>
            )}

            {completed.length === 0 ? (
              <p className="p-5 text-sm text-slate-400">No completed shifts yet.</p>
            ) : completed.length <= 5 ? (
              <div className="divide-y divide-slate-100">
                {completed.map((s) => (
                  <div key={`${s.id}::${s.startTime}`} className="px-5 py-3 flex items-center justify-between gap-3">
                    <span className="text-sm text-slate-500">
                      <span className="sm:hidden">{formatDateShort(s.date)}</span>
                      <span className="hidden sm:inline">{formatDateLong(s.date)}</span>
                    </span>
                    <div className="text-right">
                      <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                        {clinicAbbr(s.clinic)}
                      </span>
                      {formatTimeRange(s.startTime, s.endTime) && (
                        <div className="text-xs text-slate-400 mt-0.5">{formatTimeRange(s.startTime, s.endTime)}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {completedByMonth.map(({ key, label, shifts: monthShifts }) => {
                  const expanded = isMonthExpanded(key)
                  return (
                    <div key={key}>
                      <button
                        onClick={() => toggleMonth(key)}
                        className="w-full px-5 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors"
                      >
                        <span className="text-sm font-medium text-slate-600">{label}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-400">{monthShifts.length} shift{monthShifts.length !== 1 ? 's' : ''}</span>
                          <svg
                            className={`w-4 h-4 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
                            fill="none" stroke="currentColor" viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>
                      </button>
                      {expanded && (
                        <div className="divide-y divide-slate-100 bg-slate-50/50">
                          {monthShifts.map((s) => (
                            <div key={`${s.id}::${s.startTime}`} className="px-5 py-3 flex items-center justify-between gap-3">
                              <span className="text-sm text-slate-500">
                                <span className="sm:hidden">{formatDateShort(s.date)}</span>
                                <span className="hidden sm:inline">{formatDateLong(s.date)}</span>
                              </span>
                              <div className="text-right">
                                <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                                  {clinicAbbr(s.clinic)}
                                </span>
                                {formatTimeRange(s.startTime, s.endTime) && (
                                  <div className="text-xs text-slate-400 mt-0.5">{formatTimeRange(s.startTime, s.endTime)}</div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
