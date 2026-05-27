import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'

// Shift history is now derived from soft-deleted periods via /api/periods?all=true.
export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json([])
}
