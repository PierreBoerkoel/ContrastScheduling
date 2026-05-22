'use client'

import { useEffect, useState } from 'react'
import { useUser } from '@clerk/nextjs'
import type { Shift, Schedule, ShiftAssignment, ShiftSplit, ClinicName } from '@/lib/types'
import { CLINIC_ABBR, formatTimeRange, computeCoverageSegments } from '@/lib/types'
import { clinicEntities, calculateLineItems, ratesToBillingRates } from '@/lib/invoices'
import type { CompletedShiftForInvoice } from '@/lib/invoices'
import InvoiceGenerator from '@/app/components/InvoiceGenerator'

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

function clinicAbbr(clinic: string) {
  return CLINIC_ABBR[clinic] ?? clinic
}

function isShiftEnded(shift: { date: string; endTime?: string }): boolean {
  if (shift.endTime) {
    return new Date() >= new Date(`${shift.date}T${shift.endTime}:00`)
  }
  return new Date().toISOString().split('T')[0] > shift.date
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
  ]
  for (const s of shifts) {
    const dateBase = s.date.replace(/-/g, '')
    const timed = s.startTime && s.endTime
    lines.push(
      'BEGIN:VEVENT',
      `UID:${s.id}@contrast-scheduling`,
      timed
        ? `DTSTART:${dateBase}T${s.startTime!.replace(':', '')}00`
        : `DTSTART;VALUE=DATE:${dateBase}`,
      timed
        ? `DTEND:${dateBase}T${s.endTime!.replace(':', '')}00`
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

  const [shifts, setShifts] = useState<Shift[]>([])
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [history, setHistory] = useState<ShiftAssignment[]>([])
  const [allSplits, setAllSplits] = useState<ShiftSplit[]>([])
  const [loading, setLoading] = useState(true)
  const [showGoogleLinks, setShowGoogleLinks] = useState(false)

  const [editingName, setEditingName] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [nameSaving, setNameSaving] = useState(false)
  const [nameError, setNameError] = useState('')

  const [editingContact, setEditingContact] = useState(false)
  const [contactAddress, setContactAddress] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactSaving, setContactSaving] = useState(false)
  const [contactError, setContactError] = useState('')

  const [showInvoiceGenerator, setShowInvoiceGenerator] = useState(false)
  const [showEarningsCsv, setShowEarningsCsv] = useState(false)
  const [earningsFrom, setEarningsFrom] = useState(() => `${new Date().getUTCFullYear()}-01-01`)
  const [earningsTo, setEarningsTo] = useState(() => new Date().toISOString().split('T')[0])
  const [downloadingCsv, setDownloadingCsv] = useState(false)
  const [toggledMonths, setToggledMonths] = useState<Set<string>>(new Set())

  // Re-render every 60 s so isShiftEnded() stays current without a page refresh
  const [, forceUpdate] = useState(0)
  useEffect(() => {
    const id = setInterval(() => forceUpdate((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  const now = new Date()
  const [calYear, setCalYear] = useState(now.getUTCFullYear())
  const [calMonth, setCalMonth] = useState(now.getUTCMonth())

  useEffect(() => {
    Promise.all([
      fetch('/api/shifts').then((r) => r.json()),
      fetch('/api/schedule').then((r) => r.json()),
      fetch('/api/history').then((r) => r.json()),
      fetch('/api/splits').then((r) => r.json()),
    ]).then(([shiftList, sched, hist, splitList]) => {
      setShifts(Array.isArray(shiftList) ? shiftList : [])
      setSchedule(sched?.publishedAssignments?.length ? sched : null)
      setHistory(Array.isArray(hist) ? hist : [])
      setAllSplits(Array.isArray(splitList) ? splitList : [])
      setLoading(false)
    })
  }, [])

  async function saveName() {
    if (!user) return
    setNameSaving(true)
    setNameError('')
    try {
      await user.update({ firstName: firstName.trim(), lastName: lastName.trim() })
      setEditingName(false)
    } catch (e) {
      setNameError(e instanceof Error ? e.message : 'Failed to update name')
    } finally {
      setNameSaving(false)
    }
  }

  function startEditName() {
    setFirstName(user?.firstName ?? '')
    setLastName(user?.lastName ?? '')
    setNameError('')
    setEditingName(true)
  }

  async function saveContact() {
    if (!user) return
    setContactSaving(true)
    setContactError('')
    try {
      await user.update({
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
    setContactAddress(meta?.address ?? '')
    setContactPhone(meta?.phone ?? '')
    setContactEmail(meta?.email ?? user?.primaryEmailAddress?.emailAddress ?? '')
    setContactError('')
    setEditingContact(true)
  }

  if (!isLoaded || loading) return null

  const today = new Date().toISOString().split('T')[0]

  const shiftById = Object.fromEntries(shifts.map((s) => [s.id, s]))

  function assignmentToShift(a: ShiftAssignment): Shift {
    if (shiftById[a.shiftId]) return shiftById[a.shiftId]
    if (a.date && a.clinic) return { id: a.shiftId, date: a.date, clinic: a.clinic as ClinicName, startTime: a.startTime, endTime: a.endTime } as Shift
    const [date, ...parts] = a.shiftId.split('|')
    return { id: a.shiftId, date, clinic: parts.join('|') } as Shift
  }

  // Build split-aware coverage: resolve exact time windows each resident covers
  const splitsByShift: Record<string, ShiftSplit[]> = {}
  for (const s of allSplits) (splitsByShift[s.shiftId] ??= []).push(s)

  // My coverage from the published schedule (direct assignments, split-aware)
  const myScheduleCoverage: Shift[] = []
  for (const a of (schedule?.publishedAssignments ?? []).filter(
    (a) => a.residentName?.toLowerCase() === myName.toLowerCase()
  )) {
    const base = assignmentToShift(a)
    const segs = computeCoverageSegments(base, a.residentName, splitsByShift[a.shiftId] ?? [])
    for (const seg of segs.filter((s) => s.residentName.toLowerCase() === myName.toLowerCase())) {
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
      .filter((s) => s.status === 'accepted' && s.acceptorName?.toLowerCase() === myName.toLowerCase())
      .map((s) => s.shiftId)
  )]
  for (const sid of acceptorShiftIds) {
    const shift = shiftById[sid]
    if (!shift) continue  // block deleted; history records this coverage
    const base = assignmentToShift({ shiftId: sid, residentName: myName })
    if (!shift.startTime || !shift.endTime) {
      mySplitCoverage.push(base)
      continue
    }
    const assignment = (schedule?.publishedAssignments ?? []).find((a) => a.shiftId === sid)
    const segs = computeCoverageSegments(shift, assignment?.residentName ?? null, splitsByShift[sid] ?? [])
    for (const seg of segs.filter((s) => s.residentName.toLowerCase() === myName.toLowerCase())) {
      mySplitCoverage.push({
        ...base,
        startTime: seg.start || base.startTime,
        endTime: seg.end || base.endTime,
      })
    }
  }

  const allMyCoverage = [...myScheduleCoverage, ...mySplitCoverage]

  // Upcoming: not yet ended
  const upcoming: Shift[] = allMyCoverage
    .filter((s) => !isShiftEnded(s))
    .sort((a, b) => a.date.localeCompare(b.date))

  // Completed: ended from live schedule + permanent history (for deleted blocks)
  const scheduleCoverageIds = new Set(myScheduleCoverage.map((s) => s.id))
  const completedMap = new Map<string, Shift>()
  for (const a of history.filter((a) => a.residentName?.toLowerCase() === myName.toLowerCase())) {
    if (scheduleCoverageIds.has(a.shiftId)) continue
    // If this base-shift history record has accepted splits, compute actual segments
    // (splits survive block deletion, so we can derive the real coverage windows)
    const acceptedSplits = (splitsByShift[a.shiftId] ?? []).filter(sp => sp.status === 'accepted')
    if (acceptedSplits.length > 0 && a.startTime && a.endTime) {
      const segs = computeCoverageSegments({ startTime: a.startTime, endTime: a.endTime }, a.residentName!, acceptedSplits)
      segs
        .filter(seg => seg.residentName.toLowerCase() === myName.toLowerCase())
        .forEach((seg, i) => {
          completedMap.set(`${a.shiftId}::hseg::${i}`, {
            ...assignmentToShift(a),
            startTime: seg.start || undefined,
            endTime: seg.end || undefined,
          })
        })
    } else {
      completedMap.set(a.shiftId, assignmentToShift(a))
    }
  }
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
    .filter((s) => s.startTime && s.endTime && clinicEntities(s.clinic).length > 0)
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
        const entities = clinicEntities(shift.clinic)
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
        `${fmtDate(r.date)},"${r.clinic}",${r.entity},"${r.description}",${fmt(r.hours)},${fmt(r.rate)},${fmt(r.amount)}`
      ).join('\n')
      const footer = `\n,,,,,,${fmt(total)}`
      const note = rows.some((r) => r.clinic === 'BC Cancer Agency MRI/PET')
        ? '\n"Note: BC Cancer Agency MRI/PET amounts assume standard MRI + PET mode."'
        : ''

      const csv = header + body + footer + note
      const blob = new Blob([csv], { type: 'text/csv' })
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
      {/* ── Header / Name ── */}
      <div>
        <h1 className="text-2xl font-bold text-slate-800 mb-2">My Profile</h1>
        {editingName ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="First name"
              className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            <input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Last name"
              className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            <button
              onClick={saveName}
              disabled={nameSaving}
              className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              {nameSaving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => setEditingName(false)}
              className="text-sm text-slate-500 hover:text-slate-700 px-2 py-1.5"
            >
              Cancel
            </button>
            {nameError && <span className="text-sm text-red-500">{nameError}</span>}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <p className="text-slate-500 text-sm">{myName}</p>
            <button
              onClick={startEditName}
              className="text-xs text-blue-600 hover:text-blue-800 border border-blue-200 rounded px-2 py-0.5 transition-colors"
            >
              Edit name
            </button>
          </div>
        )}
      </div>

      {/* ── Contact info (for invoices) ── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-700">Invoice Contact Details</h2>
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
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Address (for invoice header)</label>
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
          <div className="text-sm text-slate-500 space-y-0.5">
            {invoiceFrom.address.split('\n').map((l, i) => <p key={i}>{l}</p>)}
            <p>{invoiceFrom.phone}</p>
            <p>{invoiceFrom.email}</p>
          </div>
        ) : (
          <p className="text-sm text-slate-400">Add your address, phone, and email to enable invoice generation.</p>
        )}
      </div>

      {!schedule && history.filter((a) => a.residentName?.toLowerCase() === myName.toLowerCase()).length === 0 ? (
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
                        ? isPast
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
                {upcoming.map((s) => (
                  <div key={s.id} className="px-5 py-3 flex items-center justify-between gap-3">
                    <span className="text-sm text-slate-700">
                      <span className="sm:hidden">{formatDateShort(s.date)}</span>
                      <span className="hidden sm:inline">{formatDateLong(s.date)}</span>
                    </span>
                    <div className="text-right">
                      <span className="text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">
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

          {/* ── Completed shifts list ── */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">Completed Shifts</h2>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-400">{completed.length} total</span>
                {invoiceableCompleted.length > 0 && (
                  <>
                    <button
                      onClick={() => { setShowEarningsCsv((v) => !v); setShowInvoiceGenerator(false) }}
                      className="flex items-center gap-1.5 text-xs text-blue-600 border border-blue-200 rounded-lg px-2.5 py-1 hover:bg-blue-50 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      {showEarningsCsv ? 'Hide' : 'Download CSV'}
                    </button>
                    <button
                      onClick={() => { setShowInvoiceGenerator((v) => !v); setShowEarningsCsv(false) }}
                      className="flex items-center gap-1.5 text-xs text-blue-600 border border-blue-200 rounded-lg px-2.5 py-1 hover:bg-blue-50 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      {showInvoiceGenerator ? 'Hide invoice' : 'Generate invoice'}
                    </button>
                  </>
                )}
              </div>
            </div>

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
                  {downloadingCsv ? 'Downloading…' : 'Download CSV'}
                </button>
              </div>
            )}
            {showInvoiceGenerator && invoiceableCompleted.length > 0 && (
              <div className="px-5 py-4 border-b border-slate-100 bg-blue-50">
                <InvoiceGenerator
                  completed={invoiceableCompleted}
                  from={invoiceFrom}
                  onMissingProfile={() => {
                    setShowInvoiceGenerator(false)
                    startEditContact()
                  }}
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
