import { NextResponse } from 'next/server'
import { auth, clerkClient } from '@clerk/nextjs/server'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const client = await clerkClient()
  const { data } = await client.users.getUserList({ limit: 500 })
  const map: Record<string, string> = {}
  for (const u of data) {
    const name = u.fullName ?? [u.firstName, u.lastName].filter(Boolean).join(' ') ?? ''
    if (name) map[u.id] = name
  }
  return NextResponse.json(map)
}
