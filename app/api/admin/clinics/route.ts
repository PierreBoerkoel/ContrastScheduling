import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getClinics, addClinic, updateClinic, deleteClinic } from '@/lib/db'
import type { Clinic } from '@/lib/types'

async function requireAdmin() {
  const user = await currentUser()
  return (user?.publicMetadata as { role?: string })?.role === 'admin'
}

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(await getClinics())
}

export async function POST(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  const body = (await request.json()) as Omit<Clinic, 'id'>
  if (!body.name) return NextResponse.json({ error: 'Missing name' }, { status: 400 })
  const clinic = await addClinic(body)
  return NextResponse.json(clinic, { status: 201 })
}

export async function PUT(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  const body = (await request.json()) as Clinic
  if (!body.id || !body.name) return NextResponse.json({ error: 'Missing id or name' }, { status: 400 })
  const { id, ...data } = body
  await updateClinic(id, data)
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  const { id } = (await request.json()) as { id: string }
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
  await deleteClinic(id)
  return NextResponse.json({ ok: true })
}
