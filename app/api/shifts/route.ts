import { NextResponse } from 'next/server'
import { getShifts, setShifts } from '@/lib/db'
import type { ClinicName, Shift } from '@/lib/types'

export async function GET() {
  return NextResponse.json(await getShifts())
}

export async function POST(request: Request) {
  const { startDate, endDate, activeClinics } = (await request.json()) as {
    startDate: string
    endDate: string
    activeClinics: Record<string, ClinicName[]>
  }

  const shifts: Shift[] = []
  const current = new Date(startDate + 'T00:00:00Z')
  const end = new Date(endDate + 'T00:00:00Z')

  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0]
    for (const clinic of activeClinics[dateStr] ?? []) {
      shifts.push({ id: `${dateStr}|${clinic}`, date: dateStr, clinic })
    }
    current.setUTCDate(current.getUTCDate() + 1)
  }

  await setShifts(shifts)
  return NextResponse.json(shifts)
}

export async function DELETE() {
  await setShifts([])
  return NextResponse.json({ ok: true })
}
