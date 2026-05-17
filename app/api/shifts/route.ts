import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getShifts, setShifts } from '@/lib/db'
import type { ClinicName, Shift } from '@/lib/types'

async function requireAdmin() {
  const user = await currentUser()
  return (user?.publicMetadata as { role?: string })?.role === 'admin'
}

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(await getShifts())
}

export async function POST(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

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
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  await setShifts([])
  return NextResponse.json({ ok: true })
}
