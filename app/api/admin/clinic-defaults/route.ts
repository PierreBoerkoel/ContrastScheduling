import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getClinicDefaults, setClinicDefault } from '@/lib/db'
import { CLINICS } from '@/lib/types'

const VALID_CLINICS = new Set<string>(CLINICS)

async function requireAdmin() {
  const user = await currentUser()
  return (user?.publicMetadata as { role?: string })?.role === 'admin'
}

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const defaults = await getClinicDefaults()
  return NextResponse.json(defaults)
}

export async function PUT(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = (await request.json()) as {
    clinic: string
    activeDays: number[]
    weekdayStart: string | null
    weekdayEnd: string | null
    weekendStart: string | null
    weekendEnd: string | null
  }
  const { clinic, activeDays, weekdayStart, weekdayEnd, weekendStart, weekendEnd } = body

  if (!clinic || !VALID_CLINICS.has(clinic)) {
    return NextResponse.json({ error: 'Invalid clinic' }, { status: 400 })
  }
  if (!Array.isArray(activeDays) || !activeDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return NextResponse.json({ error: 'Invalid active days' }, { status: 400 })
  }

  await setClinicDefault(clinic, { activeDays, weekdayStart, weekdayEnd, weekendStart, weekendEnd })
  return NextResponse.json({ ok: true })
}
