'use client'

import { useState, useEffect } from 'react'
import type { BillingEntity, CompletedShiftForInvoice, MriPetMode } from '@/lib/invoices'
import { clinicEntities, BILLING_CONTACTS } from '@/lib/invoices'
import type { InvoiceHistoryRecord } from '@/lib/db'

const ENTITY_LABELS: Record<BillingEntity, string> = {
  MRCT: 'BCCA MRI / CT',
  PET: 'BCCA PET',
  UBCMR: 'UBC',
  BCWHMR: 'BCWH',
}

const MRI_PET_MODE_LABELS: Record<MriPetMode, string> = {
  'normal': 'Normal (MRI + PET, no CT shift)',
  'two-residents': 'CT shift scheduled, separate CT resident',
  'ct-also': 'CT shift — you are the sole BCCA resident',
  'mri-down': 'MRI scanner down (PET standalone)',
  'pet-down': 'PET scanner down (MRI standalone)',
}

interface Props {
  completed: CompletedShiftForInvoice[]
  from: { name: string; address: string; phone: string; email: string }
  onMissingProfile: () => void
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
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export default function InvoiceGenerator({ completed, from, onMissingProfile }: Props) {
  const today = new Date().toISOString().split('T')[0]
  const [activeEntity, setActiveEntity] = useState<BillingEntity>('MRCT')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [modes, setModes] = useState<Record<string, MriPetMode>>({})
  const [parkingAmount, setParkingAmount] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(today)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [filterMonth, setFilterMonth] = useState<string>(currentYearMonth()) // 'YYYY-MM' or 'all'
  const [history, setHistory] = useState<InvoiceHistoryRecord[]>([])

  useEffect(() => {
    fetch('/api/invoices/history')
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setHistory(data) })
      .catch(() => {})
  }, [])

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
    clinicEntities(s.clinic).includes(activeEntity) &&
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

  async function generate() {
    if (!from.name || !from.address || !from.phone || !from.email) {
      onMissingProfile()
      return
    }

    const shifts = eligibleShifts.filter((s) => selected.has(s.shiftId))
    if (shifts.length === 0) {
      setError('Select at least one shift.')
      return
    }

    setError('')
    setGenerating(true)
    try {
      const res = await fetch('/api/invoices/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: activeEntity,
          shifts,
          modes,
          parkingAmount: activeEntity === 'UBCMR' && parkingAmount ? parseFloat(parkingAmount) : 0,
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
      const filename = match?.[1] ?? 'invoice.docx'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      // Clear selection and refresh history
      setSelected(new Set())
      fetch('/api/invoices/history')
        .then((r) => r.json())
        .then((data) => { if (Array.isArray(data)) setHistory(data) })
        .catch(() => {})
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setGenerating(false)
    }
  }

  const contact = BILLING_CONTACTS[activeEntity]
  const selectedCount = eligibleShifts.filter((s) => selected.has(s.shiftId)).length

  return (
    <div className="space-y-4">
      {/* Entity tabs */}
      <div className="flex border-b border-slate-200">
        {(['MRCT', 'PET', 'UBCMR', 'BCWHMR'] as BillingEntity[]).map((e) => (
          <button
            key={e}
            onClick={() => { setActiveEntity(e); setSelected(new Set()); setError('') }}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeEntity === e
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {ENTITY_LABELS[e]}
          </button>
        ))}
      </div>

      {/* Billed to */}
      <p className="text-xs text-slate-400">
        Billed to: {[contact.name, contact.org].filter(Boolean).join(', ')}
      </p>

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
            const isMriPet = shift.clinic === 'BC Cancer Agency MRI/PET'
            const isSelected = selected.has(shift.shiftId)
            const timeLabel = shift.startTime && shift.endTime
              ? ` · ${formatTime(shift.startTime)}–${formatTime(shift.endTime)}`
              : ''
            const priorInvoices = (invoicedShifts.get(shift.shiftId) ?? []).filter((inv) => inv.entity === activeEntity)
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
                        Downloaded {new Date(priorInvoices[0].generatedAt).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}
                      </span>
                    )}
                  </div>
                </label>

                {isMriPet && isSelected && (
                  <div className="mt-2 ml-7">
                    <select
                      value={modes[shift.shiftId] ?? 'normal'}
                      onChange={(e) => setMode(shift.shiftId, e.target.value as MriPetMode)}
                      className="text-xs border border-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 w-full max-w-xs"
                    >
                      {(Object.entries(MRI_PET_MODE_LABELS) as [MriPetMode, string][]).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* UBC parking input */}
      {activeEntity === 'UBCMR' && selectedCount > 0 && (
        <div className="flex items-center gap-3">
          <label className="text-sm text-slate-600 whitespace-nowrap">Parking / transportation ($):</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={parkingAmount}
            onChange={(e) => setParkingAmount(e.target.value)}
            placeholder="0.00"
            className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>
      )}

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

      <button
        onClick={generate}
        disabled={generating || selectedCount === 0}
        className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        {generating ? 'Generating…' : `Download Invoice${selectedCount > 0 ? ` (${selectedCount} shift${selectedCount !== 1 ? 's' : ''})` : ''}`}
      </button>
    </div>
  )
}
