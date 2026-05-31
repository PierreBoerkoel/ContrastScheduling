'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import type { BillingEntity, CompletedShiftForInvoice, MriPetMode, BillingContact } from '@/lib/invoices'
import { defaultMriPetMode } from '@/lib/invoices'
import type { InvoiceHistoryRecord } from '@/lib/db'

const ENTITY_TAB_LABELS: Record<string, string> = {
  MRCT: 'BCCA MRI/CT',
  PET:  'BCCA PET',
}

const MRI_PET_MODE_LABELS: Partial<Record<MriPetMode, string>> = {
  'normal': 'MRI + PET',
  'ct-also': 'MRI + PET + CT',
  'ct-pet': 'CT + PET',
  'mri-ct': 'MRI + CT',
  'pet-down': 'MRI',
  'mri-down': 'PET only',
  'mri-ends-early': 'MRI ended early',
}

// Modes hidden per entity tab because they produce no billable items for that entity
const EXCLUDED_MODES: Partial<Record<string, MriPetMode[]>> = {
  MRCT: ['mri-down'],
  PET: ['pet-down', 'mri-ct'],
}

const EXCLUDED_REASON: Partial<Record<MriPetMode, string>> = {
  'mri-down': 'PET only — no MRI/CT billing',
  'pet-down': 'MRI only — no PET billing',
  'mri-ct': 'MRI + CT only — no PET billing',
}

interface Props {
  completed: CompletedShiftForInvoice[]
  ctShiftsByDate: Record<string, { startTime?: string; endTime: string }>
  from: { name: string; address: string; phone: string; email: string }
  onMissingProfile: () => void
  clinicEntityMap: Record<string, string[]>
  clinicAbbrMap: Record<string, string>
  petEndTime?: string
}


function formatDateShort(d: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(d))
}

function formatTime(t?: string): string {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  const ampm = h < 12 ? 'AM' : 'PM'
  const hour = h % 12 || 12
  return m === 0 ? `${hour} ${ampm}` : `${hour}:${m.toString().padStart(2, '0')} ${ampm}`
}

function currentYearMonth(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

export default function InvoiceGenerator({ completed, ctShiftsByDate, from, onMissingProfile, clinicEntityMap, clinicAbbrMap, petEndTime }: Props) {
  const ctEndTimeByDate = Object.fromEntries(Object.entries(ctShiftsByDate).map(([d, v]) => [d, v.endTime]))
  const ctStartTimeByDate = Object.fromEntries(
    Object.entries(ctShiftsByDate).filter(([, v]) => v.startTime).map(([d, v]) => [d, v.startTime!])
  )
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const [activeEntity, setActiveEntity] = useState<BillingEntity>('')
  const [entities, setEntities] = useState<{ code: string; label: string }[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [modes, setModes] = useState<Record<string, MriPetMode>>({})
  const [mriEndTimes, setMriEndTimes] = useState<Record<string, string>>({})
  const [parkingAmounts, setParkingAmounts] = useState<Record<string, string>>({})
  const [invoiceDate, setInvoiceDate] = useState(today)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [filterMonth, setFilterMonth] = useState<string>(currentYearMonth())
  const [history, setHistory] = useState<InvoiceHistoryRecord[]>([])
  const [invoicePrefix, setInvoicePrefix] = useState('')
  const [invoiceSeq, setInvoiceSeq] = useState('')
  const [sequenceLoading, setSequenceLoading] = useState(false)
  const [dbContacts, setDbContacts] = useState<Partial<Record<BillingEntity, BillingContact>>>({})

  useEffect(() => {
    fetch('/api/invoices/history')
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setHistory(data) })
      .catch(() => {})
    fetch('/api/admin/billing-contacts')
      .then((r) => r.json())
      .then((data: { entity: string; contactName: string; org: string; address: string; email: string | null }[]) => {
        if (Array.isArray(data)) {
          const map: Partial<Record<BillingEntity, BillingContact>> = {}
          for (const c of data) {
            map[c.entity] = { name: c.contactName, org: c.org, address: c.address, email: c.email ?? undefined }
          }
          setDbContacts(map)
        }
      })
      .catch(() => {})
    fetch('/api/admin/billing-entities')
      .then((r) => r.json())
      .then((data: { code: string; label: string }[]) => {
        if (Array.isArray(data)) setEntities(data)
      })
      .catch(() => {})
  }, [])

  // Entity codes that have at least one eligible completed shift for this user
  const eligibleEntityTabs = useMemo(() => {
    const codes = new Set<string>()
    for (const s of completed) {
      for (const code of (clinicEntityMap[s.clinic] ?? [])) codes.add(code)
    }
    return entities.filter((e) => codes.has(e.code))
  }, [completed, clinicEntityMap, entities])

  // For simple (1:1) entity↔clinic mappings, map entity code → clinic abbreviation
  const entityAbbrMap = useMemo(() => {
    const entityToClinics: Record<string, string[]> = {}
    for (const [clinicName, codes] of Object.entries(clinicEntityMap)) {
      for (const code of codes) {
        if (!entityToClinics[code]) entityToClinics[code] = []
        entityToClinics[code].push(clinicName)
      }
    }
    const result: Record<string, string> = {}
    for (const [code, clinicNames] of Object.entries(entityToClinics)) {
      if (clinicNames.length === 1 && (clinicEntityMap[clinicNames[0]]?.length ?? 0) === 1) {
        const abbr = clinicAbbrMap[clinicNames[0]]
        if (abbr) result[code] = abbr
      }
    }
    return result
  }, [clinicEntityMap, clinicAbbrMap])

  // Set initial active entity once tabs are derived
  useEffect(() => {
    if (eligibleEntityTabs.length > 0 && (!activeEntity || !eligibleEntityTabs.find((e) => e.code === activeEntity))) {
      setActiveEntity(eligibleEntityTabs[0].code)
    }
  }, [eligibleEntityTabs])

  const fetchSequence = useCallback((entity: string) => {
    if (!entity) return
    setSequenceLoading(true)
    const abbr = entityAbbrMap[entity]
    const url = `/api/invoices/sequence?entity=${entity}${abbr ? `&abbr=${encodeURIComponent(abbr)}` : ''}`
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (data.formatted) {
          const match = /(\d+)$/.exec(data.formatted)
          const digits = match?.[0] ?? ''
          setInvoicePrefix(data.formatted.slice(0, data.formatted.length - digits.length))
          setInvoiceSeq(digits)
        }
      })
      .catch(() => {})
      .finally(() => setSequenceLoading(false))
  }, [entityAbbrMap])

  useEffect(() => {
    fetchSequence(activeEntity)
  }, [activeEntity, fetchSequence])

  // Map from shiftId → list of invoices it appeared in
  const invoicedShifts = new Map<string, InvoiceHistoryRecord[]>()
  for (const record of history) {
    for (const sid of record.shiftIds) {
      const existing = invoicedShifts.get(sid) ?? []
      existing.push(record)
      invoicedShifts.set(sid, existing)
    }
  }

  // Shifts that can contribute to the active billing entity, filtered by month
  const eligibleShifts = completed.filter((s) =>
    (clinicEntityMap[s.clinic] ?? []).includes(activeEntity) &&
    (filterMonth === 'all' || s.date.startsWith(filterMonth))
  )

  function toggle(shiftId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(shiftId) ? next.delete(shiftId) : next.add(shiftId)
      return next
    })
  }

  function setMode(shiftId: string, mode: MriPetMode) {
    setModes((prev) => ({ ...prev, [shiftId]: mode }))
  }

  function setParking(shiftId: string, value: string) {
    setParkingAmounts((prev) => ({ ...prev, [shiftId]: value }))
  }

  async function generate(format: 'pdf' | 'docx' = 'pdf') {
    if (!from.name || !from.address || !from.phone || !from.email) {
      onMissingProfile()
      return
    }

    const excludedModes = EXCLUDED_MODES[activeEntity]
    const shifts = eligibleShifts.filter((s) =>
      selected.has(s.shiftId) &&
      !(s.billingMode === 'mrct_pet_combined' && excludedModes?.length && excludedModes.includes(modes[s.shiftId] ?? defaultMriPetMode(s)))
    )
    if (shifts.length === 0) {
      setError('Select at least one shift.')
      return
    }

    setError('')
    setGenerating(true)
    const invoiceNumber = invoicePrefix + invoiceSeq
    const effectiveModes = Object.fromEntries(
      shifts.map((s) => [s.shiftId, modes[s.shiftId] ?? defaultMriPetMode(s)])
    ) as Record<string, MriPetMode>
    try {
      const res = await fetch('/api/invoices/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: activeEntity,
          invoiceNumber,
          shifts,
          modes: effectiveModes,
          petEndTime: petEndTime ?? undefined,
          mriEndTimes: Object.fromEntries(
            shifts
              .filter((s) => effectiveModes[s.shiftId] === 'mri-ends-early' && mriEndTimes[s.shiftId])
              .map((s) => [s.shiftId, mriEndTimes[s.shiftId]])
          ),
          ctEndTimes: Object.fromEntries(
            shifts
              .filter((s) => (effectiveModes[s.shiftId] === 'ct-pet' || effectiveModes[s.shiftId] === 'ct-also') && ctEndTimeByDate[s.date])
              .map((s) => [s.shiftId, ctEndTimeByDate[s.date]])
          ),
          ctStartTimes: Object.fromEntries(
            shifts
              .filter((s) => effectiveModes[s.shiftId] === 'ct-also' && ctStartTimeByDate[s.date])
              .map((s) => [s.shiftId, ctStartTimeByDate[s.date]])
          ),
          format,
          parkingAmounts: activeEntity === 'UBC'
            ? Object.fromEntries(
                Object.entries(parkingAmounts).map(([k, v]) => [k, parseFloat(v) || 0])
              )
            : {},
          invoiceDate,
          from,
        }),
      })

      if (!res.ok) {
        const { error: msg } = await res.json()
        setError(msg ?? 'Failed to generate invoice.')
        return
      }

      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const match = disposition.match(/filename="([^"]+)"/)
      const defaultExt = format === 'docx' ? 'invoice.docx' : 'invoice.pdf'
      const filename = match?.[1] ?? defaultExt
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      setSelected(new Set())
      fetch('/api/invoices/history')
        .then((r) => r.json())
        .then((data) => { if (Array.isArray(data)) setHistory(data) })
        .catch(() => {})
      fetchSequence(activeEntity)
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setGenerating(false)
    }
  }

  const contact = dbContacts[activeEntity]
  const tabExcludedModes = EXCLUDED_MODES[activeEntity]
  const selectedCount = eligibleShifts.filter((s) =>
    selected.has(s.shiftId) &&
    !(s.billingMode === 'mrct_pet_combined' && tabExcludedModes?.length && tabExcludedModes.includes(modes[s.shiftId] ?? defaultMriPetMode(s)))
  ).length

  if (eligibleEntityTabs.length === 0 && entities.length > 0) {
    return <p className="text-sm text-slate-400 py-2">No completed shifts eligible for invoicing.</p>
  }

  return (
    <div className="space-y-4">
      {/* Entity tabs */}
      <div className="flex border-b border-slate-200">
        {eligibleEntityTabs.map((e) => (
          <button
            key={e.code}
            onClick={() => { setActiveEntity(e.code); setSelected(new Set()); setError('') }}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeEntity === e.code
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {ENTITY_TAB_LABELS[e.code] ?? entityAbbrMap[e.code] ?? e.label}
          </button>
        ))}
      </div>

      {/* Billed to */}
      {contact && (
        <p className="text-xs text-slate-400">
          Billed to: {[contact.name, contact.org].filter(Boolean).join(', ')}
        </p>
      )}

      {/* Month filter */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-slate-600 whitespace-nowrap">Show shifts from:</label>
        <input
          type="month"
          value={filterMonth === 'all' ? '' : filterMonth}
          onChange={(e) => { setFilterMonth(e.target.value || 'all'); setSelected(new Set()) }}
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
        {filterMonth !== 'all' && (
          <button
            onClick={() => { setFilterMonth('all'); setSelected(new Set()) }}
            className="text-xs text-slate-500 hover:text-slate-700 underline"
          >
            Show all
          </button>
        )}
      </div>

      {/* Shift list */}
      {eligibleShifts.length === 0 ? (
        <p className="text-sm text-slate-400 py-2">
          {filterMonth === 'all' ? 'No completed shifts for this billing entity.' : 'No completed shifts in this month.'}
        </p>
      ) : (
        <div className="space-y-2">
          {eligibleShifts.map((shift) => {
            const isMriPet = shift.billingMode === 'mrct_pet_combined'
            const currentMode: MriPetMode = modes[shift.shiftId] ?? defaultMriPetMode(shift)
            const excludedModes = EXCLUDED_MODES[activeEntity]
            const isExcluded = isMriPet && !!excludedModes?.length && excludedModes.includes(currentMode)
            const isSelected = selected.has(shift.shiftId)
            const timeLabel = shift.startTime && shift.endTime
              ? ` · ${formatTime(shift.startTime)}–${formatTime(shift.endTime)}`
              : ''
            const priorInvoices = (invoicedShifts.get(shift.shiftId) ?? []).filter((inv) => inv.entity === activeEntity)
            const availableModes = (Object.entries(MRI_PET_MODE_LABELS) as [MriPetMode, string][])
              .filter(([k]) => !excludedModes?.includes(k))

            if (isExcluded) {
              return (
                <div
                  key={shift.shiftId}
                  className="rounded-lg border border-slate-200 bg-white px-4 py-3 opacity-50"
                >
                  <div className="flex items-start gap-3">
                    <input type="checkbox" disabled className="mt-0.5 accent-blue-600" />
                    <div className="flex-1 min-w-0 flex flex-wrap items-center gap-2">
                      <span className="text-sm text-slate-700 font-medium">
                        {formatDateShort(shift.date)}{timeLabel}
                      </span>
                      <span className="text-xs text-slate-400 italic">
                        {EXCLUDED_REASON[currentMode]}
                      </span>
                    </div>
                  </div>
                </div>
              )
            }

            return (
              <div
                key={shift.shiftId}
                className={`rounded-lg border px-4 py-3 transition-colors ${
                  isSelected ? 'border-blue-300 bg-blue-50' : 'border-slate-200 bg-white'
                }`}
              >
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(shift.shiftId)}
                    className="mt-0.5 accent-blue-600"
                  />
                  <div className="flex-1 min-w-0 flex flex-wrap items-center gap-2">
                    <span className="text-sm text-slate-700 font-medium">
                      {formatDateShort(shift.date)}{timeLabel}
                    </span>
                    {priorInvoices.length > 0 && (
                      <span className="text-xs text-slate-400 italic">
                        Downloaded {new Date(priorInvoices[0].generatedAt).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}
                      </span>
                    )}
                  </div>
                </label>

                {isMriPet && isSelected && (
                  <div className="mt-2 ml-7 space-y-1.5">
                    <select
                      value={currentMode ?? 'normal'}
                      onChange={(e) => setMode(shift.shiftId, e.target.value as MriPetMode)}
                      className="text-xs border border-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 w-full max-w-xs"
                    >
                      {availableModes.map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                    {currentMode === 'mri-ends-early' && (
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-slate-500 whitespace-nowrap">MRI ended at:</label>
                        <input
                          type="time"
                          value={mriEndTimes[shift.shiftId] ?? ''}
                          onChange={(e) => setMriEndTimes((prev) => ({ ...prev, [shift.shiftId]: e.target.value }))}
                          className="border border-slate-300 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400"
                        />
                        <span className="text-xs text-slate-400">PET continues to {petEndTime ?? '21:00'}</span>
                      </div>
                    )}
                    {(currentMode === 'ct-pet' || currentMode === 'ct-also') && (
                      <p className="text-xs text-slate-500">
                        {ctShiftsByDate[shift.date]
                          ? <>
                              CT shift: <span className="font-medium">
                                {ctStartTimeByDate[shift.date] ? formatTime(ctStartTimeByDate[shift.date]) + ' – ' : ''}
                                {formatTime(ctEndTimeByDate[shift.date])}
                              </span> (from schedule)
                            </>
                          : <span className="text-amber-600">No CT shift found for this date — add it to the schedule first.</span>
                        }
                      </p>
                    )}
                  </div>
                )}

                {activeEntity === 'UBC' && isSelected && (
                  <div className="mt-2 ml-7 flex items-center gap-2">
                    <label className="text-xs text-slate-500 whitespace-nowrap">Parking / transportation ($):</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={parkingAmounts[shift.shiftId] ?? ''}
                      onChange={(e) => setParking(shift.shiftId, e.target.value)}
                      placeholder="0.00"
                      className="border border-slate-300 rounded-lg px-2 py-1 text-xs w-24 focus:outline-none focus:ring-2 focus:ring-blue-400"
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Invoice number */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-slate-600 whitespace-nowrap">Invoice number:</label>
        <div className={`flex items-center border border-slate-300 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-400 font-mono text-sm ${sequenceLoading ? 'opacity-50' : ''}`}>
          <span className="px-3 py-1.5 text-slate-400 bg-slate-50 border-r border-slate-200 select-none whitespace-nowrap">
            {sequenceLoading ? '…' : invoicePrefix}
          </span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={sequenceLoading ? '' : invoiceSeq}
            onChange={(e) => { if (/^\d*$/.test(e.target.value)) setInvoiceSeq(e.target.value) }}
            disabled={sequenceLoading}
            className="px-2 py-1.5 w-16 focus:outline-none disabled:opacity-50 bg-white"
          />
        </div>
      </div>

      {/* Invoice date */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-slate-600 whitespace-nowrap">Invoice date:</label>
        <input
          type="date"
          value={invoiceDate}
          onChange={(e) => setInvoiceDate(e.target.value)}
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="flex flex-col gap-2 w-fit">
        <button
          onClick={() => generate('pdf')}
          disabled={generating || selectedCount === 0}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          {generating ? 'Generating…' : `Download PDF${selectedCount > 0 ? ` (${selectedCount} shift${selectedCount !== 1 ? 's' : ''})` : ''}`}
        </button>
        <button
          onClick={() => generate('docx')}
          disabled={generating || selectedCount === 0}
          className="text-xs text-slate-400 hover:text-slate-600 disabled:opacity-40 transition-colors underline underline-offset-2 text-left"
        >
          Download as Word (.docx)
        </button>
      </div>
    </div>
  )
}
