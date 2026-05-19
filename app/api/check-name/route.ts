import { NextResponse } from 'next/server'
import { auth, clerkClient } from '@clerk/nextjs/server'

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { firstName, lastName } = (await request.json()) as { firstName: string; lastName: string }
  const fullName = `${firstName.trim()} ${lastName.trim()}`.trim().toLowerCase()

  const client = await clerkClient()
  const { data: users } = await client.users.getUserList({ limit: 500 })

  const collision = users.some(
    (u) =>
      u.id !== userId &&
      `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim().toLowerCase() === fullName
  )

  return NextResponse.json({ collision })
}
