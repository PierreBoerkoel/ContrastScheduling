import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { peekInvoiceNumber } from '@/lib/db'
import { deriveInitials, formatInvoiceNumber } from '@/lib/invoices'
import type { BillingEntity } from '@/lib/invoices'

export async function GET(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const entity = searchParams.get('entity') as BillingEntity | null
  if (!entity) return NextResponse.json({ error: 'Missing entity' }, { status: 400 })

  const user = await currentUser()
  const name = user?.fullName ?? [user?.firstName, user?.lastName].filter(Boolean).join(' ') ?? ''
  const initials = deriveInitials(name)

  const n = await peekInvoiceNumber(name, entity)
  return NextResponse.json({ number: n, formatted: formatInvoiceNumber(initials, entity, n) })
}
