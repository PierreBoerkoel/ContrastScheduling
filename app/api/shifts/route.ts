import { NextResponse } from 'next/server'
import { getShifts, setShifts } from '@/lib/store'
import type { ClinicName, Shift } from '@/lib/types'

export async function GET() {
  return NextResponse.json(getShifts())
}

export async function POST(request: Request) {
  const { startDate, endDate, activeClinics } = (await request.json()) as {
    startDate: string
    endDate: string
    // date string → list of clinics active that day
    activeClinics: Record<string, ClinicName[]>
  }

  const shifts: Shift[] = []
  const current = new Date(startDate + 'T00:00:00Z')
  const end = new Date(endDate + 'T00:00:00Z')

  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0]
    const clinicsForDay = activeClinics[dateStr] ?? []
    for (const clinic of clinicsForDay) {
      shifts.push({ id: `${dateStr}|${clinic}`, date: dateStr, clinic })
    }
    current.setUTCDate(current.getUTCDate() + 1)
  }

  setShifts(shifts)
  return NextResponse.json(shifts)
}

export async function DELETE() {
  setShifts([])
  return NextResponse.json({ ok: true })
}
