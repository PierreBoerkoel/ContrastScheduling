import { NextResponse } from 'next/server'
import { clerkClient } from '@clerk/nextjs/server'

export async function GET() {
  const client = await clerkClient()
  const { data: users } = await client.users.getUserList({ limit: 500 })
  const hasCoordinator = users.some(
    (u) => (u.publicMetadata as { coordinator?: boolean })?.coordinator === true
  )
  return NextResponse.json({ hasCoordinator })
}
