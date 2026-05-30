import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getResidentContact, upsertResidentContact } from '@/lib/db'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const contact = await getResidentContact(userId)
  return NextResponse.json(contact ?? { address: '', phone: '', email: '' })
}

export async function PUT(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { address, phone, email } = (await request.json()) as { address?: string; phone?: string; email?: string }
  await upsertResidentContact(userId, {
    address: address?.trim() ?? '',
    phone: phone?.trim() ?? '',
    email: email?.trim() ?? '',
  })
  return NextResponse.json({ ok: true })
}
