import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getSubmissions, upsertSubmission } from '@/lib/db'
import type { AvailabilitySubmission } from '@/lib/types'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(await getSubmissions())
}

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await currentUser()
  const residentName =
    user?.fullName ??
    [user?.firstName, user?.lastName].filter(Boolean).join(' ') ??
    user?.emailAddresses[0]?.emailAddress ??
    'Unknown'

  const { availableShiftIds } = (await request.json()) as { availableShiftIds: string[] }

  const submission: AvailabilitySubmission = {
    id: crypto.randomUUID(),
    residentName,
    submittedAt: new Date().toISOString(),
    availableShiftIds,
  }

  await upsertSubmission({ ...submission, userId })
  return NextResponse.json(submission)
}
