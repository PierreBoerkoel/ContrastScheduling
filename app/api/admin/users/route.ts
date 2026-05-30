import { NextResponse } from 'next/server'
import { auth, currentUser, clerkClient } from '@clerk/nextjs/server'
import { getAllResidentContacts } from '@/lib/db'

async function requireAdmin() {
  const user = await currentUser()
  return (user?.publicMetadata as { role?: string })?.role === 'admin'
}

export async function GET() {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const client = await clerkClient()
  const [{ data: users }, contacts] = await Promise.all([
    client.users.getUserList({ limit: 500 }),
    getAllResidentContacts(),
  ])

  return NextResponse.json(
    users.map((u) => ({
      id: u.id,
      fullName: u.fullName ?? [u.firstName, u.lastName].filter(Boolean).join(' ') ?? '—',
      email: u.emailAddresses[0]?.emailAddress ?? '—',
      role: (u.publicMetadata as { role?: string })?.role ?? 'resident',
      createdAt: new Date(u.createdAt).toISOString(),
      phone: contacts[u.id]?.phone ?? '',
    }))
  )
}

export async function PATCH(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { userId: targetId, role } = (await request.json()) as { userId: string; role: string }
  if (!['admin', 'resident'].includes(role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
  }
  const client = await clerkClient()
  await client.users.updateUserMetadata(targetId, { publicMetadata: { role } })
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { userId: targetId } = (await request.json()) as { userId: string }
  const { userId: callerId } = await auth()
  if (targetId === callerId) {
    return NextResponse.json({ error: 'Cannot remove yourself' }, { status: 400 })
  }

  const client = await clerkClient()
  await client.users.deleteUser(targetId)
  return NextResponse.json({ ok: true })
}
