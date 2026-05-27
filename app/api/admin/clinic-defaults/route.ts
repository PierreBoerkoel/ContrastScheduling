import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getClinics, updateClinic } from '@/lib/db'

async function requireAdmin() {
  const user = await currentUser()
  return (user?.publicMetadata as { role?: string })?.role === 'admin'
}

export async function GET(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { searchParams } = new URL(request.url)
  const includeArchived = searchParams.get('includeArchived') === 'true'
  return NextResponse.json(await getClinics({ includeArchived }))
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

  if (!clinic) {
    return NextResponse.json({ error: 'Missing clinic name' }, { status: 400 })
  }
  if (!Array.isArray(activeDays) || !activeDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return NextResponse.json({ error: 'Invalid active days' }, { status: 400 })
  }

  const clinics = await getClinics()
  const existing = clinics.find((c) => c.name === clinic)
  if (!existing) {
    return NextResponse.json({ error: 'Clinic not found' }, { status: 404 })
  }

  await updateClinic(existing.id, { ...existing, activeDays, weekdayStart, weekdayEnd, weekendStart, weekendEnd })
  return NextResponse.json({ ok: true })
}
