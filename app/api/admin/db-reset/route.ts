import { NextResponse } from 'next/server'
import { sql } from '@vercel/postgres'

const SCOPES: Record<string, string[]> = {
  scheduling:      ['shift_splits', 'shift_history', 'swap_requests', 'schedule', 'availability_submissions', 'shifts', 'scheduling_periods'],
  'clinic-defaults': ['clinic_defaults'],
  'billing-rates':   ['billing_rates'],
  'billing-contacts':['billing_contacts'],
  invoices:        ['invoice_history', 'invoice_sequences'],
  all:             ['shift_splits', 'shift_history', 'swap_requests', 'schedule', 'availability_submissions', 'shifts', 'scheduling_periods', 'clinic_defaults', 'billing_rates', 'billing_contacts', 'invoice_history', 'invoice_sequences'],
}

export async function POST(request: Request) {
  const secret = process.env.DB_RESET_SECRET
  const auth = request.headers.get('Authorization')
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { scope } = (await request.json()) as { scope?: string }
  const tables = scope ? SCOPES[scope] : undefined
  if (!tables) {
    return NextResponse.json({ error: `Unknown scope. Valid: ${Object.keys(SCOPES).join(', ')}` }, { status: 400 })
  }

  await sql.query(`TRUNCATE TABLE ${tables.join(', ')} CASCADE`)
  return NextResponse.json({ ok: true, cleared: tables })
}
