import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getBillingContacts, setBillingContact } from '@/lib/db'

const VALID_ENTITIES = new Set(['MRCT', 'PET', 'UBCMR', 'BCWHMR'])

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(await getBillingContacts())
}

export async function PUT(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await request.json()) as {
    entity: string
    contactName: string
    org: string
    address: string
    email: string | null
  }
  const { entity, contactName, org, address, email } = body

  if (!entity || !VALID_ENTITIES.has(entity)) {
    return NextResponse.json({ error: 'Invalid entity' }, { status: 400 })
  }
  if (typeof org !== 'string' || typeof address !== 'string') {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  await setBillingContact(entity, {
    contactName: contactName ?? '',
    org,
    address,
    email: email || null,
  })
  return NextResponse.json({ ok: true })
}
