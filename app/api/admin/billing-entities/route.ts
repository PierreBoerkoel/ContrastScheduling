import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getBillingEntities, addBillingEntity, updateBillingEntity } from '@/lib/db'

async function requireAdmin() {
  const user = await currentUser()
  return (user?.publicMetadata as { role?: string })?.role === 'admin'
}

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(await getBillingEntities())
}

export async function POST(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  const body = (await request.json()) as {
    code: string
    label: string
    rate: number
    contactName: string
    org: string
    address: string
    email: string | null
  }
  if (!body.code || !body.org || body.rate == null) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }
  const code = body.code.toUpperCase().replace(/\s+/g, '')
  const entity = await addBillingEntity({ ...body, code, label: code })
  return NextResponse.json(entity, { status: 201 })
}

export async function PUT(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  const body = (await request.json()) as { id: string; code: string; label: string; rate: number }
  if (!body.id || !body.code || body.rate == null) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }
  await updateBillingEntity(body.id, { code: body.code, label: body.code, rate: body.rate })
  return NextResponse.json({ ok: true })
}
