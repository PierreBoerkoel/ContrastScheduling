import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getResidentPreferences, setResidentPreferences } from '@/lib/db'
import type { ResidentPreferences } from '@/lib/db'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(await getResidentPreferences(userId))
}

export async function PUT(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await request.json()) as Partial<ResidentPreferences>
  await setResidentPreferences(userId, body)
  return NextResponse.json({ ok: true })
}
