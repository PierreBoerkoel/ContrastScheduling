import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getBillingRates, setBillingRate } from '@/lib/db'
import { DEFAULT_RATES } from '@/lib/invoices'

const VALID_KEYS = new Set(Object.keys(DEFAULT_RATES))

async function requireAdmin() {
  const user = await currentUser()
  return (user?.publicMetadata as { role?: string })?.role === 'admin'
}

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rates = await getBillingRates()
  return NextResponse.json(rates)
}

export async function PUT(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = (await request.json()) as { key: string; value: number }
  const { key, value } = body

  if (!key || !VALID_KEYS.has(key)) {
    return NextResponse.json({ error: 'Invalid rate key' }, { status: 400 })
  }
  if (typeof value !== 'number' || value < 0 || !isFinite(value)) {
    return NextResponse.json({ error: 'Invalid rate value' }, { status: 400 })
  }

  await setBillingRate(key, value)
  return NextResponse.json({ ok: true })
}
