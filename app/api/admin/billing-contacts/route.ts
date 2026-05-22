import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getBillingContacts, setBillingContact } from '@/lib/db'

const VALID_ENTITIES = new Set(['MRCT', 'PET', 'UBCMR', 'BCWHMR'])

async function requireAdmin() {
  const user = await currentUser()
  return (user?.publicMetadata as { role?: string })?.role === 'admin'
}

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(await getBillingContacts())
}

export async function PUT(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

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
