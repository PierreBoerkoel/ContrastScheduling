import { NextResponse } from 'next/server'
import { clerkClient } from '@clerk/nextjs/server'

export async function GET() {
  const client = await clerkClient()
  const { data: users } = await client.users.getUserList({ limit: 500 })
  const coordinator = users.find(
    (u) => (u.publicMetadata as { coordinator?: boolean })?.coordinator === true
  )
  return NextResponse.json({
    email: coordinator?.emailAddresses[0]?.emailAddress ?? null,
    name: coordinator?.fullName ?? [coordinator?.firstName, coordinator?.lastName].filter(Boolean).join(' ') ?? null,
  })
}
